import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Monitor } from '../lib/monitor.js';
import { RecoveryController } from '../lib/recovery.js';
const KEY='monitor:recovery:v1';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const failure=code=>Object.assign(new Error('synthetic private diagnostic must never appear'),{code});
class Clock {
 constructor(){this.time=0;this.sequence=0;this.timers=new Map();}
 now=()=>this.time;
 setTimeout=(fn,delay)=>{const id=++this.sequence;this.timers.set(id,{at:this.time+delay,fn});return id;};
 clearTimeout=id=>this.timers.delete(id);
 async advance(ms){
  const target=this.time+ms;
  for(;;){
   const due=[...this.timers.entries()].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
   if(!due)break;this.time=due[1].at;this.timers.delete(due[0]);due[1].fn();await flush();
  }
  this.time=target;await flush();
 }
}
function fixture(t,{info={},saved={desired:true,accountId:1,blocked:null},legacy=false,browserState={connected:true,phase:'connected'},timing={}}={}){
 const data=new Map();if(saved!==null)data.set(KEY,saved);if(legacy)data.set('autoStart',true);
 const store={get:(key,fallback=null)=>data.has(key)?structuredClone(data.get(key)):fallback,set:(key,value)=>data.set(key,structuredClone(value))};
 const state={running:false,busy:false,haltCode:'AUTH',haltRetryable:true,accountId:1,configured:true,unknown:false,pendingAccount:false,...info};
 const calls={identity:0,start:[],resume:[],pause:[],config:[]},clock=new Clock();let sequence=0;
 const browser={view:{...browserState},read:async()=>({id:1,name:'Synthetic'}),state(){return {...this.view};},async identity(){calls.identity++;return this.read();}};
 const monitor={state,recoveryState:()=>({...state}),startHook:null,
  async start(options){calls.start.push(options);const serial=++sequence;if(this.startHook)await this.startHook(options);if(serial===sequence){state.running=true;state.haltCode=null;state.haltRetryable=false;}},
  async resume(options){calls.resume.push(options);state.unknown=false;return this.start();},
  pause({reason='PAUSED'}={}){sequence++;calls.pause.push(reason);state.running=false;state.haltCode=reason;state.haltRetryable=false;},
  configureChanged(options){calls.config.push(options);this.pause();}};
 const controller=new RecoveryController({monitor,browser,store,clock,pollMs:10,initialDelayMs:5,maxDelayMs:20,identityTimeoutMs:50,...timing});
 t.after(()=>controller.close());return{controller,monitor,browser,store,data,state,calls,clock};
}

test('recovers a runtime disconnection only after a new identity RPC confirms the original account',async t=>{
 const f=fixture(t);await f.clock.advance(0);
 assert.equal(f.controller.state().state,'running');assert.equal(f.calls.identity,1);
 assert.deepEqual(f.calls.start,[{automatic:true,expectedAccountId:1}]);
 Object.assign(f.state,{running:false,haltCode:'AUTH',haltRetryable:true});f.browser.view.connected=false;
 await f.clock.advance(10);assert.equal(f.controller.state().state,'waiting_connection');assert.equal(f.calls.identity,1);
 f.browser.view.connected=true;await f.clock.advance(10);
 assert.equal(f.calls.identity,2);assert.equal(f.calls.start.length,2);assert.equal(f.controller.state().state,'running');
});

for(const operation of ['pause','configureChanged'])test(`${operation} cancels pending identity recovery and persists disabled intent`,async t=>{
 const f=fixture(t),pending=deferred();f.browser.read=()=>pending.promise;await f.clock.advance(0);
 assert.equal(f.calls.identity,1);f.controller[operation]({destinationChanged:true});
 pending.resolve({id:1,name:'Synthetic'});await flush();await f.clock.advance(200);
 assert.equal(f.calls.start.length,0);assert.equal(f.controller.state().desired,false);
 assert.equal(f.controller.state().state,'disabled');assert.equal(f.store.get(KEY).desired,false);
 assert.equal(f.clock.timers.size,0);
});

for(const code of ['UNKNOWN','REJECTED','ACCOUNT','PAGE','SCHEMA','GAP','LIMIT','CONFIG','STORAGE','PAUSED'])test(`terminal ${code} disables desired recovery and survives restart`,async t=>{
 const f=fixture(t,{info:{haltCode:code,haltRetryable:false}});await f.clock.advance(0);
 assert.equal(f.controller.state().state,'blocked');assert.equal(f.controller.state().desired,false);
 assert.equal(f.calls.identity,0);assert.equal(f.calls.start.length,0);
 const saved=f.store.get(KEY);assert.equal(saved.desired,false);assert.equal(saved.blocked,code);
 const next=new RecoveryController({monitor:f.monitor,browser:f.browser,store:f.store,clock:f.clock});
 assert.equal(next.state().state,'blocked');next.close();assert.equal(f.calls.identity,0);
});

test('fresh identity mismatch blocks instead of adopting a different account',async t=>{
 const f=fixture(t);f.browser.read=async()=>({id:2,name:'Other'});await f.clock.advance(0);
 assert.equal(f.calls.identity,1);assert.equal(f.calls.start.length,0);
 assert.equal(f.controller.state().state,'blocked');assert.equal(f.store.get(KEY).blocked,'ACCOUNT');
 assert.equal(f.store.get(KEY).accountId,1);assert.equal(f.controller.state().desired,false);
});

test('known transient failures back off to a fixed cap and never overlap identity requests',async t=>{
 const f=fixture(t);f.browser.read=async()=>{throw failure('timeout');};
 for(const [advance,next,count] of [[0,5,1],[5,15,2],[10,35,3],[20,55,4],[20,75,5]]){
  await f.clock.advance(advance);assert.equal(f.controller.state().nextRetryAt,next);assert.equal(f.calls.identity,count);
 }
 assert.equal(f.calls.start.length,0);assert.equal(f.controller.state().desired,true);
 assert(!JSON.stringify(f.controller.state()).includes('private diagnostic'));
});

test('login or verification waits locally until the browser is ready, then verifies identity again',async t=>{
 const f=fixture(t,{browserState:{connected:true,phase:'verification_required'}});
 await f.clock.advance(40);assert.equal(f.calls.identity,0);assert.equal(f.controller.state().state,'waiting_login');
 f.browser.view.phase='connected';await f.clock.advance(10);
 assert.equal(f.calls.identity,1);assert.equal(f.controller.state().state,'running');
});

test('schema failure is terminal even when disconnected or without an account hint',async t=>{
 const f=fixture(t,{info:{accountId:null},browserState:{connected:false,phase:'schema_invalid'}});await f.clock.advance(0);
 assert.equal(f.calls.identity,0);assert.equal(f.store.get(KEY).blocked,'SCHEMA');assert.equal(f.controller.state().desired,false);
});

test('schema RPC failure and unclassified exceptions never become retryable network failures',async t=>{
 for(const [error,reason] of [[failure('schema_invalid'),'SCHEMA'],[new Error('private unknown failure'),'UNCONFIRMED']]){
  const f=fixture(t);f.browser.read=async()=>{throw error;};await f.clock.advance(0);
  assert.equal(f.store.get(KEY).blocked,reason);assert.equal(f.controller.state().desired,false);
  assert(!JSON.stringify(f.controller.state()).includes('private'));assert.equal(f.calls.start.length,0);
 }
});

test('identity timeout is bounded and a late result cannot restart a user-paused monitor',async t=>{
 const f=fixture(t),pending=deferred();f.browser.read=()=>pending.promise;await f.clock.advance(0);
 await f.clock.advance(49);assert.equal(f.calls.identity,1);assert.equal(f.calls.start.length,0);
 await f.clock.advance(1);assert.equal(f.controller.state().nextRetryAt,55);
 f.controller.pause();pending.resolve({id:1,name:'Late'});await flush();await f.clock.advance(100);
 assert.equal(f.calls.start.length,0);assert.equal(f.controller.state().state,'disabled');
});

test('an explicit start supersedes an in-progress recovery identity check',async t=>{
 const f=fixture(t),pending=deferred();f.browser.read=()=>pending.promise;await f.clock.advance(0);
 await f.controller.start();assert.equal(f.calls.start.length,1);assert.equal(f.calls.start[0],undefined);
 pending.resolve({id:1,name:'Old recovery result'});await flush();await f.clock.advance(20);
 assert.equal(f.calls.start.length,1);assert.equal(f.controller.state().state,'running');
});

test('concurrent explicit starts share a command and pause invalidates an in-progress start',async t=>{
 const f=fixture(t,{saved:{desired:false,accountId:1,blocked:null}}),pending=deferred();
 f.monitor.startHook=()=>pending.promise;
 const first=f.controller.start(),second=f.controller.start();assert.equal(first,second);assert.equal(f.calls.start.length,1);
 f.controller.pause();pending.resolve();await Promise.all([first,second]);await f.clock.advance(100);
 assert.equal(f.state.running,false);assert.equal(f.controller.state().desired,false);assert.equal(f.calls.start.length,1);
});

test('normal shutdown keeps enabled intent and RESTART, while terminal state is never relabeled',async t=>{
 const f=fixture(t,{info:{running:true,haltCode:null,haltRetryable:false}});f.controller.close();
 assert.equal(f.store.get(KEY).desired,true);assert.equal(f.state.haltCode,'RESTART');
 const restarted=new RecoveryController({monitor:f.monitor,browser:f.browser,store:f.store,clock:f.clock,pollMs:10});
 await f.clock.advance(0);assert.equal(restarted.state().state,'running');assert.equal(f.calls.identity,1);restarted.close();
 const unsafe=fixture(t,{info:{haltCode:'PAGE',haltRetryable:false}});unsafe.controller.close();
 assert.equal(unsafe.state.haltCode,'PAGE');assert.equal(unsafe.store.get(KEY).desired,false);
});

test('legacy autoStart and unclassified historical AUTH/FETCH require explicit confirmation',async t=>{
 const legacy=fixture(t,{saved:null,legacy:true});await legacy.clock.advance(0);
 assert.equal(legacy.store.get(KEY).blocked,'LEGACY');assert.equal(legacy.calls.identity,0);
 for(const haltCode of ['AUTH','FETCH',null]){
  const f=fixture(t,{info:{haltCode,haltRetryable:false}});await f.clock.advance(0);
  assert.equal(f.controller.state().state,'blocked');assert.equal(f.calls.identity,0);
 }
});

test('explicit resume is the only path that forwards skipUnknown to Monitor',async t=>{
 const f=fixture(t,{info:{haltCode:'UNKNOWN',haltRetryable:false,unknown:true}});await f.clock.advance(0);
 assert.equal(f.calls.resume.length,0);await f.controller.resume({skipUnknown:true});
 assert.deepEqual(f.calls.resume,[{skipUnknown:true}]);assert.equal(f.controller.state().state,'running');
});

function realFixture(t,savedRuntime=null){
 const db=new DatabaseSync(':memory:'),data=new Map();if(savedRuntime)data.set('monitor:runtime:v1',savedRuntime);
 const store={db,get:(key,fallback=null)=>data.has(key)?structuredClone(data.get(key)):fallback,set:(key,value)=>data.set(key,structuredClone(value))};
 const browser={identity:async()=>({id:1,name:'Synthetic'}),api:async()=>({success:true,atList:[]})};
 let sends=0;const args={store,browser,getConfig:()=>({token:'synthetic-token',chatId:'123',types:{at:true},includeSummary:false}),sendTelegram:async()=>{sends++;throw new Error('No sends expected');}};
 const monitor=new Monitor(args);t.after(()=>{monitor.pause();db.close();});return{monitor,store,browser,data,args,db,sends:()=>sends};
}

test('Monitor persists known transient provenance and rejects schema or unknown errors from automatic recovery',async t=>{
 for(const [code,expected,retryable] of [['disconnected','AUTH',true],['timeout','AUTH',true],['schema_invalid','SCHEMA',false],['other','AUTH',false]]){
  const f=realFixture(t);f.browser.identity=async()=>{throw failure(code);};await f.monitor.start();
  assert.equal(f.monitor.haltCode,expected);assert.equal(f.monitor.haltRetryable,retryable);
  const saved=f.store.get('monitor:runtime:v1');assert.equal(saved.haltCode,expected);assert.equal(saved.haltRetryable,retryable);
  const restarted=new Monitor(f.args);assert.equal(restarted.haltCode,expected);assert.equal(restarted.haltRetryable,retryable);restarted.pause();
 }
 const f=realFixture(t);await f.monitor.start();f.browser.api=async()=>{throw failure('schema_invalid');};await f.monitor.check();
 assert.equal(f.monitor.haltCode,'SCHEMA');assert.equal(f.monitor.haltRetryable,false);
 let identities=0;f.browser.identity=async()=>{identities++;return{id:1,name:'Synthetic'};};
 await f.monitor.start({automatic:true,expectedAccountId:1});assert.equal(identities,0);assert.equal(f.monitor.running,false);
});

test('Monitor automatic start requires original account and cannot accept a pending account change',async t=>{
 const f=realFixture(t);await f.monitor.start();f.browser.identity=async()=>{throw failure('disconnected');};await f.monitor.check();
 assert.equal(f.monitor.haltRetryable,true);let reads=0;
 f.browser.identity=async()=>{reads++;return{id:2,name:'Other'};};
 await f.monitor.start({automatic:true,expectedAccountId:2});assert.equal(reads,0);
 await f.monitor.start({automatic:true,expectedAccountId:1});assert.equal(f.monitor.haltCode,'ACCOUNT');assert.equal(f.monitor.account.id,1);
 const count=reads;await f.monitor.start({automatic:true,expectedAccountId:1});assert.equal(reads,count);assert.equal(f.monitor.account.id,1);
 await f.monitor.start();assert.equal(f.monitor.account.id,2);assert.equal(f.monitor.running,true);assert.equal(f.sends(),0);
});

test('real Monitor and RecoveryController resume a fresh same-account connection without sends',async t=>{
 const f=realFixture(t);await f.monitor.start();f.browser.identity=async()=>{throw failure('disconnected');};await f.monitor.check();
 assert.equal(f.monitor.haltCode,'AUTH');assert.equal(f.monitor.haltRetryable,true);
 f.store.set(KEY,{desired:true,accountId:1,blocked:null});let identities=0;
 f.browser.state=()=>({connected:true,phase:'connected'});f.browser.identity=async()=>{identities++;return{id:1,name:'Synthetic'};};
 const clock=new Clock(),controller=new RecoveryController({monitor:f.monitor,browser:f.browser,store:f.store,clock});
 await clock.advance(0);assert.equal(controller.state().state,'running');assert.equal(f.monitor.running,true);
 assert(identities>=2);assert.equal(f.sends(),0);controller.close();
 assert.equal(f.monitor.haltCode,'RESTART');assert.equal(f.store.get(KEY).desired,true);
 const restarted=new Monitor(f.args);assert.equal(restarted.haltCode,'RESTART');restarted.pause();
});

test('healthy crash state becomes RESTART, but unknown legacy runtime does not',async t=>{
 const healthy=realFixture(t,{account:{id:1,name:'Synthetic'},running:true,haltCode:null,haltRetryable:false});
 assert.equal(healthy.monitor.haltCode,'RESTART');
 const old=realFixture(t,{account:{id:1,name:'Synthetic'},lastCheck:1});assert.equal(old.monitor.haltCode,null);
 await old.monitor.start({automatic:true,expectedAccountId:1});assert.equal(old.monitor.running,false);
});

test('late halt and a paused in-flight start cannot overwrite paused state or adopt an account',async t=>{
 const f=realFixture(t),pending=deferred();f.browser.identity=()=>pending.promise;
 const starting=f.monitor.start(),generation=f.monitor._gen;f.monitor.pause();
 const error=f.monitor.lastError;f.monitor._halt('UNKNOWN',generation,true);
 assert.equal(f.monitor.haltCode,'PAUSED');assert.equal(f.monitor.lastError,error);
 pending.resolve({id:1,name:'Late'});await starting;
 assert.equal(f.monitor.running,false);assert.equal(f.monitor.haltCode,'PAUSED');assert.equal(f.monitor.account,null);assert.equal(f.sends(),0);
});

for(const phase of ['verification_required','login_required'])test(`released lease with ${phase} waits for login before classifying the connection as offline`,async t=>{
 const f=fixture(t,{browserState:{connected:false,phase}});
 await f.clock.advance(40);
 assert.equal(f.controller.state().state,'waiting_login');assert.equal(f.controller.state().desired,true);
 assert.match(f.controller.state().reason,/登录或验证/);
 assert.equal(f.calls.identity,0);assert.equal(f.calls.start.length,0);
 f.browser.view={connected:true,phase:'connected'};await f.clock.advance(10);
 assert.equal(f.calls.identity,1);assert.deepEqual(f.calls.start,[{automatic:true,expectedAccountId:1}]);
 assert.equal(f.controller.state().state,'running');
});
