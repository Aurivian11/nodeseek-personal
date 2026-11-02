import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Auth, COOKIE, passwordRecord } from '../lib/auth.js';
import { BrowserBridge } from '../lib/browser-bridge.js';
import { createApplication } from '../server.js';
const origin='https://console.test';
async function fixture(t,{recoveryState=null}={}){
 const secret=randomBytes(32),browser=new BrowserBridge({secret,pollTimeoutMs:10,leaseMs:10000});
 const auth=new Auth(passwordRecord('Synthetic test login password'));const session=auth.authenticate('Synthetic test login password');
 const values=new Map();const store={get:(k,d=null)=>values.has(k)?values.get(k):d,set:(k,v)=>values.set(k,v),encrypt:v=>v,decrypt:v=>v};
 values.set('telegram:encrypted',JSON.stringify({token:'123456789:'+ 'A'.repeat(35),chatId:'987654321',types:{message:true,at:true,reply:true}}));
 const calls=[];const monitor={running:false,state(){return{running:this.running,canStart:true,account:{id:999,name:'Stale account'},counts:{unknown:0}};},async start(){calls.push('start');this.running=true;},pause(){calls.push('pause');this.running=false;},async check(){calls.push('check');},async resume(){calls.push('resume');},configureChanged(options){calls.push(['configureChanged',options]);}};
 const controlCalls=[];
 let recoverySnapshot=recoveryState?{...recoveryState}:null;
 const recovery=recoverySnapshot?{
  state(){return{...recoverySnapshot};},
  async start(){controlCalls.push(['start']);recoverySnapshot={desired:true,state:'waiting_connection',reason:'Synthetic wait',nextRetryAt:123456};},
  pause(){controlCalls.push(['pause']);recoverySnapshot={desired:false,state:'disabled',reason:'',nextRetryAt:null};},
  async resume(options){controlCalls.push(['resume',options]);recoverySnapshot={desired:true,state:'retrying',reason:'Synthetic retry',nextRetryAt:234567};},
  configureChanged(options){controlCalls.push(['configureChanged',options]);recoverySnapshot={desired:false,state:'disabled',reason:'',nextRetryAt:null};}
 }:null;
 const app=createApplication({store,browser,auth,monitor,origin,manualDesktop:true,bridgeEnabled:true,recovery});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await browser.close();app.closeDesktop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const request=(url,{method='GET',data,admin=false,bearer=false,site=origin}={})=>new Promise((resolve,reject)=>{
  const raw=data===undefined?'':JSON.stringify(data),headers={Origin:site,'Content-Type':'application/json',...(admin?{Cookie:COOKIE+'='+session.token,'X-CSRF-Token':session.csrf}:{}),...(bearer?{Authorization:'Bearer '+secret.toString('base64url')}:{}),...(raw?{'Content-Length':Buffer.byteLength(raw)}:{})};
  const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:url,method,headers,agent:false},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>{let data;try{data=JSON.parse(Buffer.concat(parts));}catch{}resolve({status:res.statusCode,data});});});req.on('error',reject);req.end(raw);
 });return{app,browser,monitor,recovery,calls,controlCalls,values,request};
}
test('private bridge authentication does not grant admin controls or inherit admin cookies',async t=>{
 const f=await fixture(t),poll={clientId:'synthetic-client-00001',account:{id:7,name:'Synthetic'},pageState:'forum'};
 assert.equal((await f.request('/api/bridge/poll',{method:'POST',data:poll,admin:true})).status,401);
 assert.equal((await f.request('/api/bridge/poll',{method:'POST',data:poll,bearer:true,site:'https://www.nodeseek.com'})).status,200);
 assert.equal((await f.request('/api/state',{bearer:true})).status,401);
 assert.equal((await f.request('/api/config',{method:'POST',data:{},bearer:true})).status,401);
 assert.equal((await f.request('/api/bridge/unknown',{method:'POST',data:{},bearer:true})).status,404);
 assert.equal((await f.request('/api/monitor/start',{method:'POST',data:{}})).status,401);
 assert.deepEqual(f.calls,[]);
});
test('manual Chrome bridge reflects live identity and enables monitor without legacy browser actions',async t=>{
 const f=await fixture(t);
 let state=(await f.request('/api/state',{admin:true})).data;
 assert.equal(state.bridgeEnabled,true);assert.equal(state.manualDesktop,true);assert.equal(state.canStart,false);assert.equal(state.account,null);
 await f.request('/api/bridge/poll',{method:'POST',data:{clientId:'synthetic-client-00002',account:{id:7,name:'Synthetic'},pageState:'forum'},bearer:true});
 state=(await f.request('/api/state',{admin:true})).data;
 assert.equal(state.browser.connected,true);assert.equal(state.account.id,7);assert.equal(state.canStart,true);
 assert.equal((await f.request('/api/monitor/start',{method:'POST',data:{},admin:true})).status,200);assert.deepEqual(f.calls,['start']);
 for(const path of ['open','login','input','check'])assert.equal((await f.request('/api/browser/'+path,{method:'POST',data:{},admin:true})).status,409);
 assert.equal((await f.request('/api/monitor/pause',{method:'POST',data:{},admin:true})).status,200);assert.deepEqual(f.calls,['start','pause']);
 await f.browser.close();state=(await f.request('/api/state',{admin:true})).data;assert.equal(state.account,null);assert.equal(state.canStart,false);
});

test('snapshot exposes recovery intent while the underlying monitor is paused',async t=>{
 const expected={desired:true,state:'waiting_login',reason:'Synthetic login recovery',nextRetryAt:345678};
 const f=await fixture(t,{recoveryState:expected});
 const result=await f.request('/api/state',{admin:true});
 assert.equal(result.status,200);assert.equal(result.data.running,false);
 assert.equal(result.data.monitorDesired,true);assert.deepEqual(result.data.recovery,expected);
 assert.equal(f.app.snapshot().monitorDesired,true);assert.deepEqual(f.app.snapshot().recovery,expected);
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.controlCalls,[]);
});

test('monitor commands and configuration changes use the recovery controller',async t=>{
 const f=await fixture(t,{recoveryState:{desired:false,state:'disabled',reason:'',nextRetryAt:null}});
 await f.request('/api/bridge/poll',{method:'POST',data:{clientId:'synthetic-client-control',account:{id:7,name:'Synthetic'},pageState:'forum'},bearer:true});
 let result=await f.request('/api/monitor/start',{method:'POST',data:{},admin:true});
 assert.equal(result.status,200);assert.deepEqual(f.controlCalls,[['start']]);
 assert.equal(result.data.running,false);assert.equal(result.data.monitorDesired,true);
 assert.equal(result.data.recovery.state,'waiting_connection');assert.equal(f.values.get('autoStart'),true);
 result=await f.request('/api/monitor/pause',{method:'POST',data:{},admin:true});
 assert.equal(result.status,200);assert.equal(result.data.monitorDesired,false);
 assert.equal(result.data.recovery.state,'disabled');assert.equal(f.values.get('autoStart'),false);
 result=await f.request('/api/monitor/resume',{method:'POST',data:{},admin:true});
 assert.equal(result.status,400);assert.deepEqual(f.controlCalls,[['start'],['pause']]);
 result=await f.request('/api/monitor/resume',{method:'POST',data:{skipUnknown:true},admin:true});
 assert.equal(result.status,200);assert.equal(result.data.monitorDesired,true);assert.equal(f.values.get('autoStart'),true);
 assert.deepEqual(f.controlCalls,[['start'],['pause'],['resume',{skipUnknown:true}]]);
 result=await f.request('/api/config',{method:'POST',data:{chatId:'123456789',types:{message:true,at:false,reply:true},includeSummary:false},admin:true});
 assert.equal(result.status,200);assert.equal(result.data.monitorDesired,false);assert.equal(f.values.get('autoStart'),false);
 assert.deepEqual(f.controlCalls.at(-1),['configureChanged',{destinationChanged:true}]);
 const saved=JSON.parse(f.values.get('telegram:encrypted'));
 assert.equal(saved.chatId,'123456789');assert.equal(saved.includeSummary,false);
 assert.deepEqual(saved.types,{message:true,at:false,reply:true});
 assert.deepEqual(f.calls,[],'routes must not bypass recovery and call monitor controls directly');
});

test('waiting recovery rejects Telegram tests and source diagnostics before any external work',async t=>{
 let outbound=0;
 t.mock.method(globalThis,'fetch',async()=>{outbound++;throw new Error('External network disabled by test');});
 for(const recoveryStatus of ['waiting_connection','waiting_login','retrying'])await t.test(recoveryStatus,async child=>{
  const f=await fixture(child,{recoveryState:{desired:true,state:recoveryStatus,reason:'Synthetic waiting state',nextRetryAt:null}});
  let identityCalls=0,sourceCalls=0;
  child.mock.method(f.browser,'identity',async()=>{identityCalls++;throw new Error('Identity must not be requested');});
  child.mock.method(f.browser,'api',async()=>{sourceCalls++;throw new Error('Forum requests disabled by test');});
  assert.equal(f.monitor.running,false);
  for(const route of ['/api/telegram/test','/api/diagnostics/sources']){
   const result=await f.request(route,{method:'POST',data:{},admin:true});
   assert.equal(result.status,409,route);assert.match(result.data.error,/暂停监控/);
  }
  assert.equal(outbound,0,'no Telegram fetch');assert.equal(identityCalls,0);assert.equal(sourceCalls,0);
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.controlCalls,[]);
 });
});
