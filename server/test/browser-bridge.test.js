import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { BrowserBridge, allowedBridgeAPI } from '../lib/browser-bridge.js';
const A='synthetic-client-alpha-0001',B='synthetic-client-beta-0002';
const USER={id:7,name:'Synthetic user'},OTHER={id:8,name:'Other synthetic user'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+1500;while(!fn()){assert.ok(Date.now()<end,'condition timed out');await sleep(5);}}
async function fixture(t,options={}){
 const secret=randomBytes(32),bridge=new BrowserBridge({secret,pollTimeoutMs:15,leaseMs:500,jobTimeoutMs:250,maxQueue:3,...options});
 const server=http.createServer(async(req,res)=>{if(!await bridge.handleHttp(req,res)){res.writeHead(404);res.end('not handled');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return {bridge,server,secret,token:secret.toString('base64url'),port:server.address().port};
}
function request(f,path,value,options={}){
 const raw=options.raw??JSON.stringify(value??{}),method=options.method||'POST';
 const headers={'Content-Type':'application/json',Authorization:'Bearer '+f.token,
  ...(!options.chunked?{'Content-Length':Buffer.byteLength(raw)}:{}),...options.headers};
 for(const key of Object.keys(headers))if(headers[key]===null)delete headers[key];
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:f.port,path,method,headers,agent:false},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
    const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}
    resolve({status:res.statusCode,data,text,headers:res.headers});
   });
  });req.on('error',reject);req.setTimeout(2000,()=>req.destroy(new Error('HTTP timeout')));
  if(options.chunked){for(let n=0;n<raw.length;n+=8192)req.write(raw.slice(n,n+8192));req.end();}else req.end(raw);
 });
}
const heartbeat=(clientId=A,user=USER,pageState='forum')=>({clientId,account:user,pageState});
const poll=(f,body=heartbeat())=>request(f,'/api/bridge/poll',body);
const reply=(f,job,result,clientId=A)=>request(f,'/api/bridge/reply',{clientId,id:job.id,ok:true,result});
function call(work){const pending=work();pending.catch(()=>{});return pending;}
async function identify(f,user=USER,clientId=A){
 const pending=call(()=>f.bridge.identity());const response=await poll(f,heartbeat(clientId,user));
 assert.equal(response.data.job.op,'identity');assert.deepEqual(response.data.job.args,{});
 assert.equal((await reply(f,response.data.job,user,clientId)).status,200);assert.deepEqual(await pending,user);
 return response.data.job;
}

test('only exact POST bridge routes accept the fixed bearer secret and never echo it',async t=>{
 const f=await fixture(t);
 for(const headers of [{Authorization:null},{Authorization:'Bearer wrong'}, {Authorization:'Basic '+f.token}]){
  const response=await request(f,'/api/bridge/poll',{...heartbeat(),secret:f.token},{headers});
  assert.equal(response.status,401);assert.doesNotMatch(response.text,new RegExp(f.token));
 }
 for(const path of ['/api/bridge/poll?target=https://attacker.test','/api/bridge/reply/','/api/bridge/eval'])
  assert.equal((await request(f,path,heartbeat())).status,404);
 assert.equal((await request(f,'/api/bridge/poll',{}, {method:'GET'})).status,404);
 assert.equal((await request(f,'/api/bridge/poll',heartbeat(),{headers:{'Content-Type':'text/plain'}})).status,415);
 assert.equal((await request(f,'/api/bridge/poll',{}, {raw:'{bad JSON'})).status,400);
 assert.equal(f.bridge.state().connected,false);assert.equal(f.bridge.account,null);
 assert.doesNotMatch(JSON.stringify(f.bridge),new RegExp(f.token));
});

test('body size is limited for declared and chunked requests before state changes',async t=>{
 const f=await fixture(t),raw=JSON.stringify({...heartbeat(),padding:'x'.repeat(512*1024)});
 for(const chunked of [false,true])assert.equal((await request(f,'/api/bridge/poll',{}, {raw,chunked})).status,413);
 assert.equal(f.bridge.account,null);assert.equal(f.bridge.state().connected,false);
 for(const body of [heartbeat('../bad',USER),heartbeat(A,{id:0,name:'bad'}),heartbeat(A,{id:7,name:'x'.repeat(101)}),heartbeat(A,USER,'eval')])
  assert.equal((await poll(f,body)).status,400);
});

test('heartbeat only hints identity; fresh identity RPC is required before whitelisted reads',async t=>{
 const f=await fixture(t);assert.equal((await poll(f)).status,200);
 assert.deepEqual(f.bridge.account,USER);assert.equal(f.bridge.state().phase,'connected');
 await assert.rejects(f.bridge.api('/api/notification/message/list'),{code:'login_required'});
 await identify(f);assert.equal(f.bridge.state().phase,'logged_in');
 const pending=call(()=>f.bridge.api('/api/notification/message/list?page=1'));
 const job=(await poll(f)).data.job;assert.deepEqual(job.args,{path:'/api/notification/message/list?page=1'});
 const result={success:true,msgArray:[{id:3,content:'synthetic private text'}]};
 assert.equal((await reply(f,job,result)).status,200);assert.deepEqual(await pending,result);
 const next=call(()=>f.bridge.identity());const fresh=(await poll(f)).data.job;
 assert.equal(fresh.op,'identity');await reply(f,fresh,USER);assert.deepEqual(await next,USER);
});

test('all job arguments stay fixed and arbitrary URL, methods, and executable input are rejected',async t=>{
 const f=await fixture(t);await poll(f);await identify(f);
 for(const value of ['https://attacker.test/api/notification/message/list','//127.0.0.1/x','/api/attendance','/api/notification/message/send',
  '/api/notification/message/list?page=1&url=https://attacker.test','/api/notification/message/with/0','/api/notification/message/list?page=9007199254740992']){
  assert.equal(allowedBridgeAPI(value),false,value);await assert.rejects(f.bridge.api(value));
 }
 for(const path of ['/api/notification/message/with/9','/api/notification/at-me/list?page=2','/api/notification/reply-to-me/list'])assert.equal(allowedBridgeAPI(path),true);
 assert.equal(await f.bridge.postText('../x',1),'');assert.equal(await f.bridge.postText(7,1000001),'');
 const pending=call(()=>f.bridge.postText(7,'#11')),job=(await poll(f)).data.job;
 assert.deepEqual({op:job.op,args:job.args},{op:'postText',args:{postId:7,floor:11}});
 await reply(f,job,'plain <script>text only</script>');assert.equal(await pending,'plain <script>text only</script>');
});

test('foreign clients cannot steal an active lease or reply; replies are single-use',async t=>{
 const f=await fixture(t);await poll(f);
 const pending=call(()=>f.bridge.identity()),job=(await poll(f)).data.job;
 const standby=await poll(f,heartbeat(B,OTHER));assert.equal(standby.data.standby,true);assert.equal(standby.data.retryAfter,5000);
 assert.deepEqual(f.bridge.account,USER);
 assert.equal((await reply(f,job,OTHER,B)).status,409);
 assert.equal((await request(f,'/api/bridge/reply',{clientId:A,id:job.id,ok:false,error:'payload-secret'})).status,400);
 assert.equal((await reply(f,job,USER)).status,200);assert.deepEqual(await pending,USER);
 assert.equal((await reply(f,job,OTHER)).status,409);assert.deepEqual(f.bridge.account,USER);
});

test('lease expiry cancels old jobs and allows a new client only with new identity verification',async t=>{
 const f=await fixture(t,{leaseMs:80,jobTimeoutMs:500});await poll(f);await identify(f);
 const stale=call(()=>f.bridge.api('/api/notification/message/list')),oldJob=(await poll(f)).data.job;
 await until(()=>!f.bridge.state().connected);await assert.rejects(stale,{code:'disconnected'});
 assert.equal(f.bridge.account,null);
 await poll(f,heartbeat(B,OTHER));assert.deepEqual(f.bridge.account,OTHER);
 await assert.rejects(f.bridge.api('/api/notification/message/list'),{code:'login_required'});
 assert.equal((await reply(f,oldJob,{success:true,msgArray:[]})).status,409);
 await identify(f,OTHER,B);assert.equal(f.bridge.state().phase,'logged_in');
 const standby=await poll(f);assert.equal(standby.data.standby,true);assert.deepEqual(f.bridge.account,OTHER);
});

test('verification, logout, and account change immediately invalidate jobs and previous verification',async t=>{
 const f=await fixture(t);await poll(f);await identify(f);
 for(const [state,user,code] of [['verification',null,'verification_required'],['login',null,'login_required'],['forum',OTHER,'login_required']]){
  const pending=call(()=>f.bridge.api('/api/notification/message/list')),oldJob=(await poll(f)).data.job;
  await poll(f,heartbeat(A,user,state));await assert.rejects(pending,{code});
  assert.equal((await reply(f,oldJob,{success:true,msgArray:[]})).status,409);
  await assert.rejects(f.bridge.api('/api/notification/message/list'));
  if(state!=='forum')assert.equal(f.bridge.account,null);
  await poll(f);await identify(f);
 }
});

test('non-forum clients do not occupy the initial lease',async t=>{
 const f=await fixture(t);
 for(const pageState of ['verification','login','unknown']){
  const response=await poll(f,heartbeat(A,null,pageState));assert.equal(response.data.job,null);
  assert.equal(f.bridge.state().connected,false);assert.equal(f.bridge.account,null);
 }
 await poll(f,heartbeat(B,OTHER));await identify(f,OTHER,B);assert.deepEqual(f.bridge.account,OTHER);
});

test('long poll dispatches promptly, keeps one inflight job and bounds the queue',async t=>{
 const f=await fixture(t,{pollTimeoutMs:200,jobTimeoutMs:700,leaseMs:1000,maxQueue:2});
 const waiting=poll(f);await until(()=>f.bridge.state().connected);
 const first=call(()=>f.bridge.identity()),job1=(await waiting).data.job;
 assert.equal(job1.op,'identity');
 const second=call(()=>f.bridge.identity());await assert.rejects(f.bridge.identity(),{code:'busy'});
 const nextPoll=poll(f);await until(()=>f.bridge._poll!==null);
 assert.equal((await poll(f)).status,409);
 await reply(f,job1,USER);assert.deepEqual(await first,USER);
 const job2=(await nextPoll).data.job;assert.notEqual(job1.id,job2.id);
 await reply(f,job2,USER);assert.deepEqual(await second,USER);
 const idle=await poll(f);assert.equal(idle.data.job,null);assert.ok(idle.data.retryAfter>0);
});

test('job timeout rejects outstanding work and requires fresh identity before reads',async t=>{
 const f=await fixture(t,{jobTimeoutMs:45});await poll(f);await identify(f);
 const pending=call(()=>f.bridge.api('/api/notification/message/list')),job=(await poll(f)).data.job;
 await assert.rejects(pending,{code:'timeout'});
 assert.equal((await reply(f,job,{success:true,msgArray:[]})).status,409);
 await assert.rejects(f.bridge.api('/api/notification/message/list'),{code:'login_required'});
 await identify(f);assert.equal(f.bridge.state().phase,'logged_in');
});

test('invalid result schema and explicit verification failures never reach Monitor as successful data',async t=>{
 const f=await fixture(t);await poll(f);await identify(f);
 const invalid=call(()=>f.bridge.api('/api/notification/message/list')),job=(await poll(f)).data.job;
 assert.equal((await reply(f,job,{success:false,secret:'must-not-be-echoed'})).status,422);
 await assert.rejects(invalid,{code:'schema_invalid'});await poll(f);await identify(f);
 const longText=call(()=>f.bridge.postText(7,1)),textJob=(await poll(f)).data.job;
 assert.equal((await reply(f,textJob,'x'.repeat(2001))).status,422);await assert.rejects(longText);
 await poll(f);await identify(f);
 const check=call(()=>f.bridge.identity()),identityJob=(await poll(f)).data.job;
 const result=await request(f,'/api/bridge/reply',{clientId:A,id:identityJob.id,ok:false,error:'verification_required'});
 assert.equal(result.status,200);await assert.rejects(check,{code:'verification_required'});
 assert.equal(f.bridge.account,null);assert.equal(f.bridge.state().phase,'verification_required');
});

test('close releases pending polls and jobs, removes account capability and rejects later traffic',async t=>{
 const f=await fixture(t,{pollTimeoutMs:200});
 const waiting=poll(f);await until(()=>f.bridge.state().connected);
 const job=call(()=>f.bridge.identity());await waiting;
 const queue=call(()=>f.bridge.identity()),pendingPoll=poll(f);await until(()=>f.bridge._poll!==null);
 f.bridge.close();f.bridge.close();
 assert.equal((await pendingPoll).status,503);
 await assert.rejects(job,{code:'bridge_closed'});await assert.rejects(queue,{code:'bridge_closed'});
 assert.equal(f.bridge.account,null);assert.deepEqual(f.bridge.state(),{connected:false,running:false,phase:'stopped',url:''});
 assert.equal((await poll(f)).status,503);
});

test('client IDs and paths reject coercible or trailing-control input',async t=>{
 const f=await fixture(t);
 for(const clientId of [1234567890123456,A+'\n',{toString:'not callable'}])
  assert.equal((await poll(f,heartbeat(clientId))).status,400);
 assert.equal(allowedBridgeAPI('/api/notification/message/list\n'),false);
 assert.equal(f.bridge.state().connected,false);
});

test('identity RPC returning guest revokes permission despite a prior logged-in heartbeat',async t=>{
 const f=await fixture(t);await poll(f);await identify(f);
 const pending=call(()=>f.bridge.identity()),job=(await poll(f)).data.job;
 assert.equal((await reply(f,job,null)).status,200);assert.equal(await pending,null);
 assert.equal(f.bridge.account,null);await assert.rejects(f.bridge.api('/api/notification/message/list'));
});

test('aborted request bodies and long polls do not crash or leave a stuck poll',async t=>{
 const f=await fixture(t,{pollTimeoutMs:200});
 const req=http.request({host:'127.0.0.1',port:f.port,path:'/api/bridge/poll',method:'POST',agent:false,
  headers:{Authorization:'Bearer '+f.token,'Content-Type':'application/json'}});
 req.on('error',()=>{});req.write('{');await sleep(15);req.destroy();await sleep(15);
 assert.equal(f.bridge.account,null);
 const held=http.request({host:'127.0.0.1',port:f.port,path:'/api/bridge/poll',method:'POST',agent:false,
  headers:{Authorization:'Bearer '+f.token,'Content-Type':'application/json'}});
 held.on('error',()=>{});held.end(JSON.stringify(heartbeat()));await until(()=>f.bridge._poll!==null);
 held.destroy();await until(()=>f.bridge._poll===null);
 assert.equal((await poll(f)).status,200);
});

test('an unhealthy existing owner releases its lease so a healthy tab can reconnect safely',async t=>{
 for(const pageState of ['verification','login','unknown']){
  const f=await fixture(t);await poll(f);await identify(f);
  const pending=call(()=>f.bridge.api('/api/notification/message/list')),job=(await poll(f)).data.job;
  await poll(f,heartbeat(A,null,pageState));await assert.rejects(pending);
  assert.equal(f.bridge.state().connected,false);
  await poll(f,heartbeat(B,USER));assert.deepEqual(f.bridge.account,USER);
  assert.equal((await reply(f,job,{success:true,msgArray:[]})).status,409);
  await assert.rejects(f.bridge.api('/api/notification/message/list'),{code:'login_required'});
  await identify(f,USER,B);assert.equal(f.bridge.state().phase,'logged_in');
 }
});

test('identity schema failures survive heartbeat and are never disguised as a network disconnect',async t=>{
 const f=await fixture(t);
 assert.equal((await poll(f,{...heartbeat(A,null,'unknown'),error:'schema_invalid'})).status,200);
 assert.equal(f.bridge.state().phase,'schema_invalid');assert.equal(f.bridge.account,null);
 await assert.rejects(f.bridge.open(),{code:'schema_invalid'});await assert.rejects(f.bridge.identity(),{code:'schema_invalid'});
 assert.equal((await poll(f,{...heartbeat(A),error:'schema_invalid'})).status,400);
 await poll(f,heartbeat(B,USER));await identify(f,USER,B);
 const pending=call(()=>f.bridge.api('/api/notification/message/list')),job=(await poll(f,heartbeat(B,USER))).data.job;
 await request(f,'/api/bridge/reply',{clientId:B,id:job.id,ok:false,error:'schema_invalid'});
 await assert.rejects(pending,{code:'schema_invalid'});assert.equal(f.bridge.state().phase,'schema_invalid');
});
