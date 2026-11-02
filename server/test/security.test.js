import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { Store } from '../lib/store.js';
import { Auth, COOKIE, passwordRecord } from '../lib/auth.js';
import { sendTelegram } from '../lib/telegram.js';
import { ForumBrowser, ORIGIN, allowedBrowserURL, allowedAPI } from '../lib/browser.js';
import { createApplication } from '../server.js';
const ADMIN_ORIGIN='https://console.example.test';
const PASS='Synthetic-admin-password-only-for-tests';
const TOKEN='123456789:'+ 'A'.repeat(35);
const CHAT='987654321';
const PRIVATE='Synthetic-private-notification-content';
const RECORD=passwordRecord(PASS);
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
class MemoryStore {
 constructor(){this.data=new Map();this.key=randomBytes(32);}
 get(key,fallback=null){return this.data.has(key)?structuredClone(this.data.get(key)):fallback;}
 set(key,value){this.data.set(key,structuredClone(value));}
 encrypt(text){return Store.prototype.encrypt.call(this,text);}
 decrypt(text){return Store.prototype.decrypt.call(this,text);}
}
async function application(t,overrides={}) {
 const calls=[];
 const store=new MemoryStore(),auth=new Auth(RECORD);
 const browser={account:{id:7,name:'Test account'},state:()=>({running:false,phase:'stopped',url:''}),
  open:async()=>{calls.push('open');return {};},login:async()=>{calls.push('login');return {};},
  identity:async()=>({id:7,name:'Test account'}),input:async()=>{calls.push('input');},
  screenshot:async()=>{calls.push('frame');return Buffer.from('fake-jpeg');},...overrides.browser};
 const monitor={running:false,state:()=>({running:false,canStart:true,account:{id:7,name:'Test account'}}),
  configureChanged:()=>{calls.push('configure');},start:async()=>{calls.push('start');},
  pause:()=>{calls.push('pause');},check:async()=>{calls.push('check');},resume:async()=>{calls.push('resume');}};
 const app=createApplication({store,auth,browser,monitor,origin:ADMIN_ORIGIN});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
 return {...app,store,auth,browser,monitor,calls,port:app.server.address().port};
}
async function request(app,pathname,options={}) {
 const method=options.method||'GET';
 const payload=method==='POST'?JSON.stringify(options.data??{}):null;
 const headers={...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),
  ...(method==='POST'&&options.origin!==null?{Origin:options.origin||ADMIN_ORIGIN}:{}),
  ...(options.cookie?{Cookie:options.cookie}:{}),...(options.csrf?{'X-CSRF-Token':options.csrf}:{}),...options.headers};
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:app.port,path:pathname,method,headers,agent:false},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
    const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}
    resolve({status:res.statusCode,headers:res.headers,text,data});
   });
  });req.on('error',reject);req.end(payload);
 });
}
async function login(app){const res=await request(app,'/api/login',{method:'POST',data:{password:PASS}});assert.equal(res.status,200);return {cookie:res.headers['set-cookie'][0].split(';')[0],csrf:res.data.csrf,response:res};}

test('all protected control APIs reject unauthenticated requests before side effects',async t=>{
 const app=await application(t);
 const paths=['/api/config','/api/telegram/test','/api/monitor/start','/api/monitor/pause','/api/monitor/check','/api/monitor/resume','/api/browser/open','/api/browser/login','/api/browser/input','/api/browser/check','/api/logout'];
 for(const pathname of ['/api/state','/api/browser/frame','/api/config'])assert.equal((await request(app,pathname)).status,401,pathname);
 for(const pathname of paths)assert.equal((await request(app,pathname,{method:'POST',data:{token:TOKEN,password:PRIVATE,skipUnknown:true}})).status,401,pathname);
 assert.deepEqual(app.calls,[]);
 assert.deepEqual((await request(app,'/api/session')).data,{authenticated:false});
});

test('admin sessions use secure cookies, exact-origin and CSRF checks, and revoke on logout',async t=>{
 const app=await application(t),session=await login(app);
 const cookie=session.response.headers['set-cookie'][0];
 assert.ok(cookie.startsWith(COOKIE+'='));
 for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(cookie.includes(flag),flag);
 assert.doesNotMatch(cookie,/Domain=/i);
 assert.equal((await request(app,'/api/state',session)).status,200);
 const paths=['/api/config','/api/telegram/test','/api/monitor/start','/api/monitor/pause','/api/monitor/check','/api/monitor/resume','/api/browser/open','/api/browser/login','/api/browser/input','/api/browser/check','/api/logout'];
 for(const pathname of paths){
  assert.equal((await request(app,pathname,{method:'POST',cookie:session.cookie})).status,403,pathname+' missing CSRF');
  assert.equal((await request(app,pathname,{method:'POST',...session,origin:'https://evil.example'})).status,403,pathname+' wrong origin');
 }
 assert.equal((await request(app,'/api/monitor/pause',{method:'POST',...session,csrf:'wrong'})).status,403);
 assert.equal((await request(app,'/api/monitor/pause',{method:'POST',...session,origin:null})).status,403);
 assert.equal((await request(app,'/api/state',{...session,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await request(app,'/api/state',{...session,headers:{Host:'evil.example'}})).status,400);
 assert.deepEqual(app.calls,[]);
 assert.equal((await request(app,'/api/monitor/pause',{method:'POST',...session})).status,200);
 assert.deepEqual(app.calls,['pause']);
 assert.equal((await request(app,'/api/logout',{method:'POST',...session})).status,200);
 assert.equal((await request(app,'/api/state',session)).status,401);
 const next=await login(app);for(const value of app.auth.sessions.values())value.expires=Date.now()-1;
 assert.equal((await request(app,'/api/state',next)).status,401);
});

test('synthetic admin credentials are hashed and repeated failures are rate-limited',()=>{
 const auth=new Auth(RECORD);
 assert.equal(JSON.stringify(RECORD).includes(PASS),false);
 for(let i=0;i<6;i++)assert.equal(auth.authenticate('incorrect-test-password'),null);
 assert.deepEqual(auth.authenticate(PASS),{limited:true});
 const clean=new Auth(RECORD),session=clean.authenticate(PASS);
 assert.ok(session.token&&session.csrf);
 assert.equal(clean.sessions.has(session.token),false,'session bearer must not be the map key');
 assert.ok(clean.find({headers:{cookie:COOKIE+'='+session.token}}));
 assert.equal(clean.find({headers:{cookie:COOKIE+'=invalid'}}),null);
});

test('configuration is encrypted and Telegram secrets never appear in state, responses or errors',async t=>{
 const logs=[],network=[];
 t.mock.method(console,'error',(...args)=>logs.push(args));
 t.mock.method(console,'warn',(...args)=>logs.push(args));
 t.mock.method(globalThis,'fetch',async(url,options)=>{network.push({url,options});throw new Error(TOKEN+' '+PRIVATE);});
 const app=await application(t,{browser:{login:async()=>{throw new Error(TOKEN+' '+PRIVATE);}}});
 const session=await login(app);
 const configured=await request(app,'/api/config',{method:'POST',...session,data:{token:TOKEN,chatId:CHAT,types:{message:true,at:true,reply:true},includeSummary:true}});
 assert.equal(configured.status,200);
 const encrypted=app.store.get('telegram:encrypted');
 assert.equal(typeof encrypted,'string');assert.equal(encrypted.includes(TOKEN),false);
 assert.equal(JSON.parse(app.store.decrypt(encrypted)).token,TOKEN);
 assert.equal(JSON.stringify([...app.store.data]).includes(TOKEN),false);
 const state=await request(app,'/api/state',session);
 assert.equal(state.status,200);assert.equal(state.data.telegram.configured,true);
 assert.equal(Object.hasOwn(state.data.telegram,'token'),false);
 const failed=await request(app,'/api/browser/login',{method:'POST',...session,data:{username:'fake-user',password:PRIVATE}});
 assert.equal(failed.status,503);
 const send=await request(app,'/api/telegram/test',{method:'POST',...session,data:{text:PRIVATE}});
 assert.equal(send.status,200);assert.equal(send.data.status,'unknown');
 assert.equal(network.length,1);
 const payload=JSON.parse(network[0].options.body);
 assert.ok(payload.text.includes('Telegram'));assert.equal(payload.text.includes(PRIVATE),false);
 for(const text of [configured.text,state.text,failed.text,send.text,JSON.stringify(logs)]){
  assert.equal(text.includes(TOKEN),false);assert.equal(text.includes(PRIVATE),false);
 }
});

test('real Store protects temporary config with authenticated encryption and a private key file',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nsp-security-'));
 const store=new Store(dir);let closed=false;
 t.after(()=>{if(!closed)store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const plaintext=JSON.stringify({token:TOKEN,chatId:CHAT});
 const encrypted=store.encrypt(plaintext),again=store.encrypt(plaintext);
 assert.notEqual(encrypted,again);assert.equal(store.decrypt(encrypted),plaintext);
 store.set('telegram:encrypted',encrypted);
 assert.equal(store.get('telegram:encrypted').includes(TOKEN),false);
 const damaged=Buffer.from(encrypted,'base64');damaged[damaged.length-1]^=1;
 assert.throws(()=>store.decrypt(damaged.toString('base64')));
 assert.equal(fs.statSync(path.join(dir,'master.key')).mode&0o777,0o600);
 assert.equal(fs.statSync(dir).mode&0o777,0o700);
 store.close();closed=true;
 for(const file of fs.readdirSync(dir))assert.equal(fs.readFileSync(path.join(dir,file)).includes(Buffer.from(TOKEN)),false,file);
});

test('Telegram requests have a fixed destination, no redirects or cookie headers, and plain text',async()=>{
 const requests=[];
 const fetchImpl=async(url,options)=>{requests.push({url,options});return json({ok:true,result:{message_id:123}});};
 const text='<b>Plain text only</b> '+PRIVATE;
 assert.deepEqual(await sendTelegram({token:TOKEN,chatId:CHAT},text,{fetchImpl}),{status:'sent'});
 assert.equal(requests.length,1);
 const {url,options}=requests[0],target=new URL(url),body=JSON.parse(options.body);
 assert.equal(target.origin,'https://api.telegram.org');
 assert.equal(target.pathname,'/bot'+TOKEN+'/sendMessage');assert.equal(target.search,'');
 assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
 assert.deepEqual(Object.keys(options.headers),['Content-Type']);
 assert.equal(body.chat_id,CHAT);assert.equal(body.text,text);assert.equal(body.parse_mode,undefined);
 assert.deepEqual(body.link_preview_options,{is_disabled:true});
 assert.equal((await sendTelegram({token:'https://evil.example/token',chatId:CHAT},text,{fetchImpl})).status,'rejected');
 assert.equal((await sendTelegram({token:TOKEN,chatId:'-12345'},text,{fetchImpl})).status,'rejected');
 assert.equal(requests.length,1);
});

test('Telegram 429 is retryable and ambiguous/network outcomes stay unknown without secret echoes',async()=>{
 const config={token:TOKEN,chatId:CHAT};
 const limited=await sendTelegram(config,PRIVATE,{fetchImpl:async()=>json({ok:false,description:TOKEN+' '+PRIVATE,parameters:{retry_after:7}},429)});
 assert.equal(limited.status,'rate_limited');assert.equal(limited.retryAfter,7);
 const rejected=await sendTelegram(config,PRIVATE,{fetchImpl:async()=>json({ok:false,description:TOKEN+' '+PRIVATE},401)});
 assert.equal(rejected.status,'rejected');
 const failed=await sendTelegram(config,PRIVATE,{fetchImpl:async()=>{throw new Error(TOKEN+' '+PRIVATE);}});
 const ambiguous=await sendTelegram(config,PRIVATE,{fetchImpl:async()=>json({ok:false,description:TOKEN+' '+PRIVATE},500)});
 const malformed=await sendTelegram(config,PRIVATE,{fetchImpl:async()=>json({ok:true})});
 for(const result of [failed,ambiguous,malformed])assert.equal(result.status,'unknown');
 const all=JSON.stringify([limited,rejected,failed,ambiguous,malformed]);
 assert.equal(all.includes(TOKEN),false);assert.equal(all.includes(PRIVATE),false);
});

test('browser URL and forum API allowlists reject SSRF, credentials and unrelated writes',async()=>{
 assert.equal(allowedBrowserURL(ORIGIN+'/notification'),true);
 assert.equal(allowedBrowserURL('https://challenges.cloudflare.com/turnstile/test'),true);
 for(const url of ['http://www.nodeseek.com/','https://127.0.0.1/','https://[::1]/','https://169.254.169.254/latest/meta-data/','https://10.0.0.1/','file:///etc/passwd','javascript:alert(1)','https://www.nodeseek.com.evil.example/','https://user:password@www.nodeseek.com/','https://www.nodeseek.com:8443/'])assert.equal(allowedBrowserURL(url),false,url);
 for(const api of ['/api/notification/message/list?page=1','/api/notification/message/with/8','/api/notification/at-me/list?page=2','/api/notification/reply-to-me/list'])assert.equal(allowedAPI(api),true,api);
 const browser=new ForumBrowser('/not-used');let evaluations=0;
 browser.page={url:()=>ORIGIN,evaluate:async()=>{evaluations++;return {status:200,data:{success:true}};}};
 for(const api of ['https://evil.example/','//127.0.0.1/','/api/notification/message/send','/api/notification/message/markViewed','/api/account/change-password','/api/notification/message/list?page=0','/api/notification/message/list?url=https://evil.example/','/api/notification/message/with/../1'])await assert.rejects(browser.api(api),api);
 assert.equal(evaluations,0);
 await browser.api('/api/notification/message/list?page=1');assert.equal(evaluations,1);
});

test('the browser intercepts subrequests and top-level navigation, closes popups, and blocks workers',async t=>{
 let routeHandler,websocketHandler,launchOptions;const contextEvents=new Map(),pageEvents=new Map();
 let page,frame;frame={page:()=>page};
 page={evaluate:async()=>({challenge:false}),isClosed:()=>false,url:()=>ORIGIN,mainFrame:()=>frame,on:(name,fn)=>pageEvents.set(name,fn),goto:async url=>{assert.equal(url,ORIGIN);}};
 const context={setDefaultTimeout:()=>{},routeWebSocket:async(_pattern,fn)=>{websocketHandler=fn;},route:async(_pattern,fn)=>{routeHandler=fn;},pages:()=>[page],newPage:async()=>page,
  on:(name,fn)=>contextEvents.set(name,fn),close:async()=>contextEvents.get('close')?.()};
 t.mock.method(chromium,'launchPersistentContext',async(_dir,options)=>{launchOptions=options;return context;});
 const browser=new ForumBrowser('/test-only-not-created');t.after(()=>browser.close());
 await browser.open();
 let websocketClosed=false;websocketHandler({url:()=>'wss://www.nodeseek.com/test',close:()=>{websocketClosed=true;}});assert.equal(websocketClosed,true);
 assert.equal(launchOptions.serviceWorkers,'block');assert.equal(launchOptions.acceptDownloads,false);
 async function route(url,{navigation=false,type='script'}={}){
  let action;
  const request={url:()=>url,resourceType:()=>type,isNavigationRequest:()=>navigation,frame:()=>frame};
  await routeHandler({request:()=>request,abort:async()=>{action='abort';},continue:async()=>{action='continue';}});
  return action;
 }
 assert.equal(await route(ORIGIN+'/post-8-1',{navigation:true}),'continue');
 assert.equal(await route('https://challenges.cloudflare.com/check',{navigation:true}),'abort');
 assert.equal(await route('https://challenges.cloudflare.com/script.js'),'continue');
 assert.equal(await route('https://hagen.challenges.cloudflare.com/test'),'continue');
 assert.equal(await route('https://hagen.challenges.cloudflare.com/test',{navigation:true}),'abort');
 assert.equal(await route('https://127.0.0.1/secret'),'abort');
 assert.equal(await route('https://evil.example/steal'),'abort');
 assert.equal(await route(ORIGIN+'/video',{type:'media'}),'abort');
 let closed=0;contextEvents.get('page')({close:async()=>{closed++;}});assert.equal(closed,1);
});
