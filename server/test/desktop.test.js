import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { Auth, COOKIE } from '../lib/auth.js';
import { attachDesktop, desktopAsset } from '../lib/desktop.js';
import { createApplication } from '../server.js';
const ORIGIN='https://console.example.test';
const SOCKET_ROUTE='/api/desktop/socket';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label='condition'){
 const limit=Date.now()+3000;
 while(!predicate()){if(Date.now()>limit)assert.fail('Timed out: '+label);await wait(10);}
}
function event(emitter,name){
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{emitter.off(name,done);reject(new Error('Timed out: '+name));},3000);
  const done=(...args)=>{clearTimeout(timer);resolve(args);};emitter.once(name,done);
 });
}
function session(auth){
 const token=randomBytes(32).toString('base64url'),key=auth.key(token),csrf='synthetic-csrf';
 auth.sessions.set(key,{csrf,expires:Date.now()+60000});
 return {key,csrf,cookie:COOKIE+'='+token};
}
async function closeServer(server){
 if(server.listening)await new Promise(resolve=>server.close(resolve));
}
async function fixture(t,{integration=false,maxClients=2}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nsp-desktop-test-'));
 const socketPath=path.join(dir,'fake-rfb.sock'),peers=new Set(),accepted=[],clients=new Set();
 const backend=net.createServer(peer=>{
  peers.add(peer);accepted.push(peer);peer.chunks=[];
  peer.on('error',()=>{});peer.on('data',chunk=>peer.chunks.push(chunk));
  peer.on('close',()=>peers.delete(peer));
 });
 await new Promise(resolve=>backend.listen(socketPath,resolve));
 const auth=new Auth({salt:'00'.repeat(16),hash:'00'.repeat(32)}),login=session(auth),calls=[];
 let server,proxy;
 if(integration){
  const connect=net.createConnection;
  t.mock.method(net,'createConnection',(options,...args)=>{
   if(options.path==='/run/nodeseek-desktop/vnc.sock')return connect({path:socketPath},...args);
   assert.equal(options.host,'127.0.0.1');assert.equal(options.port,server.address().port);
   return connect(options,...args);
  });
  const store={get:(_key,fallback=null)=>fallback,set:()=>calls.push('store')};
  const browser={account:{id:7},state:()=>({running:false}),diagnostics:async()=>({}),
   ...Object.fromEntries(['open','login','input','identity','screenshot'].map(name=>[name,async()=>{calls.push(name);return Buffer.from('fixture');}]))};
  const monitor={running:false,state:()=>({canStart:true}),
   ...Object.fromEntries(['start','pause','check','resume','configureChanged'].map(name=>[name,async()=>calls.push(name)]))};
  ({server}=createApplication({store,browser,monitor,auth,origin:ORIGIN,manualDesktop:true}));
 }else{
  server=http.createServer((_req,res)=>res.end());
  proxy=attachDesktop(server,{auth,origin:ORIGIN,socketPath,checkInterval:30,maxClients});
 }
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{
  for(const client of clients)client.terminate();for(const peer of peers)peer.destroy();
  server.closeAllConnections();await closeServer(server);await closeServer(backend);
  fs.rmSync(dir,{recursive:true,force:true});
 });
 return {server,proxy,auth,login,clients,peers,accepted,calls,port:server.address().port};
}
async function handshake(f,{route=SOCKET_ROUTE,headers={},login=f.login}={}){
 const all={Host:new URL(ORIGIN).host,Origin:ORIGIN,...(login?{Cookie:login.cookie}:{}),...headers};
 for(const key of Object.keys(all))if(all[key]===null)delete all[key];
 const ws=new WebSocket('ws://127.0.0.1:'+f.port+route,{headers:all,perMessageDeflate:false});
 f.clients.add(ws);ws.on('error',()=>{});ws.on('close',()=>f.clients.delete(ws));
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.terminate();reject(new Error('handshake timeout'));},3000);
  ws.once('open',()=>{clearTimeout(timer);resolve({status:101,ws});});
  ws.once('unexpected-response',(_req,res)=>{
   clearTimeout(timer);res.resume();resolve({status:res.statusCode,ws});ws.terminate();
  });
  ws.once('error',error=>{clearTimeout(timer);reject(error);});
 });
}
async function connected(f,options){
 const before=f.accepted.length,result=await handshake(f,options);assert.equal(result.status,101);
 await until(()=>f.accepted.length===before+1,'Unix socket connected');
 return {ws:result.ws,peer:f.accepted.at(-1)};
}
async function request(f,pathname,{method='GET',login=f.login,origin=ORIGIN,csrf=login?.csrf}={}){
 const payload=method==='POST'?'{}':undefined;
 const headers={Host:new URL(ORIGIN).host,...(login?{Cookie:login.cookie}:{}),
  ...(origin?{Origin:origin}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),
  ...(payload?{'Content-Type':'application/json','Content-Length':2}:{})};
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:f.port,path:pathname,method,headers,agent:false},res=>{
   const chunks=[];res.on('data',data=>chunks.push(data));res.on('end',()=>{
    const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}
    resolve({status:res.statusCode,text,data,headers:res.headers});
   });
  });req.on('error',reject);req.end(payload);
 });
}

test('desktop handshake rejects unauthenticated, Origin, Host and path failures before Unix connect',async t=>{
 const f=await fixture(t);
 const cases=[
  [{login:null},401],[{headers:{Cookie:COOKIE+'=invalid'}},401],
  [{headers:{Origin:null}},403],[{headers:{Origin:'null'}},403],
  [{headers:{Origin:'https://attacker.example'}},403],
  [{headers:{Origin:ORIGIN+'/'}},403],[{headers:{Host:'attacker.example'}},403],
  [{route:'/api/desktop/socket/'},404],[{route:'/api/desktop/other'},404]
 ];
 for(const [options,status] of cases)assert.equal((await handshake(f,options)).status,status);
 assert.equal(f.accepted.length,0);assert.equal(f.proxy.connections(),0);
});

test('clients cannot choose a TCP host or Unix path through the upgrade request',async t=>{
 const f=await fixture(t);
 for(const query of ['?host=127.0.0.1&port=22','?path=/run/other.sock','?target=ws://attacker.example'])
  assert.equal((await handshake(f,{route:SOCKET_ROUTE+query})).status,404);
 assert.equal(f.accepted.length,0);
 const {ws,peer}=await connected(f,{headers:{'X-Target':'127.0.0.1:22','X-Socket-Path':'/run/other.sock'}});
 const received=event(peer,'data');ws.send(Buffer.from([1,2,255]));
 assert.deepEqual((await received)[0],Buffer.from([1,2,255]));assert.equal(f.accepted.length,1);
});

test('authorized binary bytes travel in both directions without text conversion',async t=>{
 const f=await fixture(t),{ws,peer}=await connected(f);
 const outbound=Buffer.from([0,255,128,13,10,1,2,0]),incoming=Buffer.from([82,70,66,32,0,255,128,10]);
 const fromClient=event(peer,'data');ws.send(outbound);assert.deepEqual((await fromClient)[0],outbound);
 const fromBackend=event(ws,'message');peer.write(incoming);
 const [data,isBinary]=await fromBackend;assert.equal(isBinary,true);assert.deepEqual(data,incoming);
 assert.equal(ws.extensions,'');assert.equal(f.proxy.connections(),1);
});

test('revoke closes only the chosen session and expired sessions close on timer',async t=>{
 const f=await fixture(t),second=session(f.auth);
 const firstPair=await connected(f),secondPair=await connected(f,{login:second});
 const firstClosed=event(firstPair.ws,'close');f.auth.remove(f.login);f.proxy.revoke(f.login.key);
 await firstClosed;await until(()=>firstPair.peer.destroyed&&f.proxy.connections()===1,'revoked resources');
 assert.equal(secondPair.ws.readyState,WebSocket.OPEN);
 const secondClosed=event(secondPair.ws,'close');f.auth.sessions.get(second.key).expires=Date.now()-1;
 await secondClosed;await until(()=>secondPair.peer.destroyed&&f.proxy.connections()===0,'expired resources');
 assert.equal((await handshake(f,{login:second})).status,401);assert.equal(f.accepted.length,2);
});

test('a revoked session cannot send even before the periodic auth check',async t=>{
 const f=await fixture(t),{ws,peer}=await connected(f),closed=event(ws,'close');
 f.auth.remove(f.login);ws.send(Buffer.from('must-not-reach-rfb'));
 await closed;await until(()=>peer.destroyed,'revoked upstream closes');
 assert.equal(Buffer.concat(peer.chunks).length,0);assert.equal(f.proxy.connections(),0);
});

test('text and oversized frames close both streams without forwarding the frame',async t=>{
 const f=await fixture(t);
 for(const payload of ['invalid text frame',Buffer.alloc(1024*1024+1,65)]){
  const {ws,peer}=await connected(f),closed=event(ws,'close');ws.send(payload);
  await closed;await until(()=>peer.destroyed&&f.proxy.connections()===0,'rejected frame cleanup');
  assert.equal(Buffer.concat(peer.chunks).length,0);
 }
});

test('connection limit rejects without opening a backend and normal disconnect frees the slot',async t=>{
 const f=await fixture(t,{maxClients:1}),first=await connected(f);
 assert.equal((await handshake(f)).status,429);assert.equal(f.accepted.length,1);
 const closed=event(first.ws,'close');first.ws.close();await closed;
 await until(()=>first.peer.destroyed&&f.proxy.connections()===0,'client close cleanup');
 const second=await connected(f),backendClosed=event(second.ws,'close');second.peer.destroy();
 await backendClosed;await until(()=>f.proxy.connections()===0&&f.peers.size===0,'backend close cleanup');
 assert.equal(f.accepted.length,2);
});

test('explicit proxy shutdown releases websocket and Unix streams before HTTP shutdown',async t=>{
 const f=await fixture(t),{ws,peer}=await connected(f);
 assert.equal(typeof f.proxy.close,'function');
 const closed=event(ws,'close');f.proxy.close();f.proxy.close();
 await Promise.all([closeServer(f.server),closed]);
 await until(()=>peer.destroyed&&f.proxy.connections()===0,'shutdown cleanup');
});

test('logout requires Origin and CSRF, then immediately closes the authenticated desktop',async t=>{
 const f=await fixture(t,{integration:true}),{ws,peer}=await connected(f);
 for(const options of [{origin:'https://attacker.example'},{csrf:'wrong'}]){
  assert.equal((await request(f,'/api/logout',{method:'POST',...options})).status,403);
  assert.equal(ws.readyState,WebSocket.OPEN);assert.ok(f.auth.sessions.has(f.login.key));
 }
 const closed=event(ws,'close');const result=await request(f,'/api/logout',{method:'POST'});
 assert.equal(result.status,200);await closed;await until(()=>peer.destroyed,'logout upstream cleanup');
 assert.equal(f.auth.sessions.has(f.login.key),false);
 assert.match(result.headers['set-cookie'][0],/Max-Age=0/);
 assert.equal((await handshake(f)).status,401);assert.equal(f.accepted.length,1);
});

test('manual mode protects desktop assets and blocks old browser and monitor control paths',async t=>{
 const f=await fixture(t,{integration:true});
 assert.equal((await request(f,'/desktop',{login:null})).status,302);
 for(const pathname of ['/desktop.js','/desktop.css','/desktop-assets/core/rfb.js'])
  assert.equal((await request(f,pathname,{login:null})).status,401,pathname);
 const page=await request(f,'/desktop');assert.equal(page.status,200);
 assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
 assert.match(page.headers['cache-control'],/no-store/);
 const state=await request(f,'/api/state');assert.equal(state.data.manualDesktop,true);assert.equal(state.data.canStart,false);
 const controls=['/api/browser/open','/api/browser/login','/api/browser/input','/api/browser/check',
  '/api/monitor/start','/api/monitor/check','/api/monitor/resume'];
 for(const pathname of controls){
  assert.equal((await request(f,pathname,{method:'POST',login:null})).status,401,pathname);
  assert.equal((await request(f,pathname,{method:'POST'})).status,409,pathname);
 }
 assert.deepEqual(f.calls,[]);assert.equal(f.accepted.length,0);
});

test('desktop assets cannot escape the static allowlist',()=>{
 const root='/synthetic-app-root';
 assert.equal(desktopAsset('/desktop',root),root+'/public/desktop.html');
 assert.equal(desktopAsset('/desktop-assets/core/rfb.js',root),'/usr/share/novnc/core/rfb.js');
 for(const value of ['/desktop-assets/../data/admin.json','/desktop-assets/core/../../data/admin.js',
  '/desktop-assets/core/%2e%2e/secret.js','/desktop-assets/core//secret.js','/desktop-assets/core/./secret.js',
  '/desktop-assets/core/secret.json','/desktop-assets/etc/passwd.js','/desktop-assets/core/secret.js?x=1',
  '/desktop-assets/core/secret.js/','/api/desktop/socket'])assert.equal(desktopAsset(value,root),null,value);
});

test('only authenticated desktop HTML permits noVNC data images without widening script or connect sources',async t=>{
 const f=await fixture(t,{integration:true});
 const directive=(response,name)=>{
  const policy=response.headers['content-security-policy'];assert.equal(typeof policy,'string');
  const matches=policy.split(';').map(value=>value.trim().split(/\s+/)).filter(parts=>parts[0]===name);
  assert.equal(matches.length,1,'exactly one '+name+' directive');return matches[0].slice(1);
 };
 const assertRestricted=(response,dataImages=false)=>{
  assert.deepEqual(directive(response,'img-src'),dataImages?["'self'",'blob:','data:']:["'self'",'blob:']);
  assert.deepEqual(directive(response,'script-src'),["'self'"]);
  assert.deepEqual(directive(response,'connect-src'),["'self'"]);
 };
 const desktop=await request(f,'/desktop');assert.equal(desktop.status,200);assertRestricted(desktop,true);
 for(const pathname of ['/','/index.html','/app.js','/style.css','/desktop.js','/desktop.css','/desktop-assets/core/display.js']){
  const response=await request(f,pathname);assert.equal(response.status,200,pathname);assertRestricted(response);
 }
 const redirect=await request(f,'/desktop',{login:null});
 assert.equal(redirect.status,302);assert.equal(redirect.headers.location,'/');assertRestricted(redirect);
 for(const pathname of ['/desktop.js','/desktop.css','/desktop-assets/core/display.js']){
  const denied=await request(f,pathname,{login:null});assert.equal(denied.status,401,pathname);assertRestricted(denied);
 }
 assert.deepEqual(f.calls,[]);assert.equal(f.accepted.length,0);
});
