import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const source=fs.readFileSync(new URL('../userscripts/nodeseek-monitor-bridge.template.js',import.meta.url),'utf8');
class Root{
 constructor(html){this.html=html;}
 get textContent(){return this.html.replace(/<[^>]*>/g,'').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&nbsp;',' ');}
 querySelector(selector){if(selector==='title'){const match=/<title>([\s\S]*?)<\/title>/i.exec(this.html);return match?{textContent:match[1]}:null;}if(selector.includes('#challenge-form'))return this.html.includes('challenge-form')?{}:null;if(selector==='#temp-script'){const match=/<script id="temp-script">([\s\S]*?)<\/script>/.exec(this.html);return match?{textContent:match[1]}:null;}return null;}
 querySelectorAll(selector){if(selector.startsWith('script,style'))return[{remove:()=>{this.html=this.html.replace(/<(script|style|noscript|iframe|object|embed|template)\b[^>]*>[\s\S]*?<\/\1>/gi,'');}}];return [];}
}
function setup(t){
 const s={title:'NodeSeek',login:false,fetches:[],gm:[],replyStatus:200,gmResponder:null,home:{user:{member_id:1,member_name:'Owner'}},data:{success:true,msgArray:[]},extraHTML:null};
 const body={append(node){node.isConnected=true;}};
 const doc={body,documentElement:{},querySelectorAll(selector){if(selector==='form input[type="password"]'&&(s.login||s.hiddenLogin))return[{getClientRects:()=>s.login?[{}]:[],closest:()=>null}];return [];},querySelector(selector){if(selector==='title')return{textContent:s.title};if(selector.includes('#challenge-form'))return s.title==='challenge'?{}:null;if(selector==='form input[type="password"]')return s.login?{}:null;return null;},createElement(tag){if(tag==='template')return{set innerHTML(value){this.content=new Root(value);}};return{isConnected:false,style:{},setAttribute(){},contains(node){return node===this;},textContent:''};}};
 Object.defineProperty(doc,'cookie',{get(){throw Error('Cookie must not be read');},set(){throw Error('Cookie must not be written');}});
 const win={events:{},addEventListener(name,fn){this.events[name]=fn;}};win.top=win;win.self=win;
 const context={window:win,document:doc,location:{origin:'https://www.nodeseek.com',pathname:'/'},getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'}),crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,URL,AbortController,atob,setTimeout,clearTimeout,setInterval:()=>777,clearInterval(){},queueMicrotask,MutationObserver:class{observe(){}disconnect(){}},fetch:async(url,options)=>{s.fetches.push({url,options});if(s.fetchResponder)return s.fetchResponder(url,options);const html=s.extraHTML??`<title>NodeSeek</title><script id="temp-script">${Buffer.from(JSON.stringify(s.home)).toString('base64')}</script>`;return new Response(url==='https://www.nodeseek.com/'?html:JSON.stringify(s.data),{status:200});},GM_xmlhttpRequest:options=>{s.gm.push(options);queueMicrotask(()=>{const response=s.gmResponder?s.gmResponder(options):{status:s.replyStatus,body:{job:null,retryAfter:1}};options.onload({status:response.status,responseText:JSON.stringify(response.body),finalUrl:options.url});});return{abort(){options.onabort();}};}};
 let code=source.replace('__BRIDGE_TOKEN__','mock_private_token_1234567890123456').replace('__BRIDGE_ORIGIN__','https://console.example.test').replace('__BRIDGE_HOST__','console.example.test');
 const end='  void start();\n})();';assert(code.includes(end));code=code.replace(end,`  globalThis.bridgeTest={applyDOMState,loop,pollDelay,allowedAPI,projectAPI,apiTask,postTask,refreshIdentity,execute,bridge,start,stop,activate(){running=true;generation++;account={id:1,name:'Owner'};pageState='forum';return generation;},snapshot(){return {running,terminal,account,pageState,generation,accountEpoch,lastIdentityError};}};\n})();`);
 vm.createContext(context);vm.runInContext(code,context);const api=context.bridgeTest;t.after(()=>api.stop());return{s,api,context};
}
const msg={id:7,sender_id:2,receiver_id:1,sender_name:'Sender',receiver_name:'Owner',content:'<p>Hello &amp; hi</p><script>BAD()</script>',created_at:'2026-11-02',viewed:0,secret:'DO_NOT_FORWARD'};
const tick=()=>new Promise(r=>setImmediate(r));
test('retryAfter is milliseconds; standby and idle never become 90 second sleep',t=>{
 const {api}=setup(t);assert.equal(api.pollDelay(250,25000),0);assert.equal(api.pollDelay(5000,25000),5000);assert.equal(api.pollDelay(5000,0),5000);assert.equal(api.pollDelay(1000,0),1000);assert.equal(api.pollDelay(undefined,25000),0);assert.equal(api.pollDelay(undefined,0),1000);assert.equal(api.pollDelay(9999999,0),30000);
});
test('metadata and template contain one secret placeholder; no persistence or credential reads',()=>{
 assert.equal((source.match(/__BRIDGE_TOKEN__/g)||[]).length,1);assert.match(source,/@match\s+https:\/\/www\.nodeseek\.com\/\*/);assert.match(source,/@connect\s+__BRIDGE_HOST__/);assert.match(source,/@version\s+1\.1\.0/);for(const placeholder of ['__BRIDGE_ORIGIN__','__BRIDGE_HOST__'])assert.equal(source.split(placeholder).length-1,1);assert.doesNotMatch(source,/document\.cookie|localStorage|sessionStorage|GM_setValue|GM_getValue|\beval\s*\(|new Function/);assert.doesNotMatch(source,/@connect\s+\*/);
});
test('only fixed read-only API paths and bounded page numbers are accepted',t=>{
 const {api}=setup(t);for(const p of ['/api/notification/message/list?page=1','/api/notification/message/with/8','/api/notification/at-me/list?page=10','/api/notification/reply-to-me/list'])assert(api.allowedAPI(p),p);
 for(const p of ['https://evil.test/a','//evil.test/a','/api/notification/message/send','/api/notification/message/markViewed','/api/account/password','/api/notification/message/with/0','/api/notification/message/list?page=1&x=1','/api/notification/message/list?page=1001','/api/notification/message/list#x','/api/notification/message/list?url=https://evil.test'])assert.equal(api.allowedAPI(p),false,p);
});
test('identity jobs always make fresh same-origin GET and do not read cookie fields',async t=>{
 const {api,s}=setup(t);const g=api.activate();const first=await api.refreshIdentity(true,g),second=await api.refreshIdentity(true,g);assert.equal(first.id,1);assert.equal(second.name,'Owner');assert.equal(s.fetches.length,2);for(const request of s.fetches){assert.equal(request.url,'https://www.nodeseek.com/');assert.equal(request.options.method,'GET');assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.Cookie,undefined);}
});
test('guest and verification pages are reported without solving or clicking',async t=>{
 const {api,s}=setup(t);const g=api.activate();s.home={user:null};assert.equal(await api.refreshIdentity(true,g),null);assert.equal(api.snapshot().pageState,'login');s.extraHTML='<title>Just a moment</title><form id="challenge-form"></form>';await assert.rejects(api.refreshIdentity(true,g),e=>e.code==='verification_required');assert.equal(api.snapshot().account,null);assert.equal(api.snapshot().pageState,'verification');
});
test('account names fit backend 100 UTF16 units; hidden login modal does not override identity',async t=>{
 const {api,s}=setup(t);const g=api.activate();s.hiddenLogin=true;s.home.user.member_name='a'.repeat(99)+'😀';const user=await api.refreshIdentity(true,g);assert(user.name.length<=100);assert.equal(user.name,'a'.repeat(99));assert.equal(api.snapshot().pageState,'forum');s.login=true;assert.equal(await api.refreshIdentity(true,g),null);assert.equal(api.snapshot().pageState,'login');
});
test('API projects full essential rows and strips arbitrary fields and executable HTML',async t=>{
 const {api,s}=setup(t);s.data={success:true,msgArray:[msg],talkTo:{member_name:'Sender',password:'DO_NOT_FORWARD'},cookie:'DO_NOT_FORWARD'};const result=await api.apiTask({path:'/api/notification/message/with/2'});assert.equal(result.msgArray[0].id,7);assert.equal(result.msgArray[0].content,'Hello & hi');assert.equal(result.talkTo.member_name,'Sender');assert(!JSON.stringify(result).includes('DO_NOT_FORWARD'));assert(!JSON.stringify(result).includes('<'));assert.equal(s.fetches[0].options.method,'GET');
 s.data={success:true,atList:[{id:8,post_id:12,floor_id:'#2',commenter_name:'User',post_title:'Topic',content:'<b>Reply</b>',created_at:'date',viewed:'0',secret:'DO_NOT_FORWARD'}]};const notice=await api.apiTask({path:'/api/notification/at-me/list?page=1'});assert.equal(notice.atList[0].floor_id,2);assert.equal(notice.atList[0].content,'Reply');assert.equal(notice.atList[0].post_title,'Topic');assert(!JSON.stringify(notice).includes('DO_NOT_FORWARD'));
});
test('privileged bridge sends only anonymous POST with Bearer to fixed endpoint',async t=>{
 const {api,s}=setup(t);await api.bridge('/api/bridge/poll',{clientId:'mock',account:null,pageState:'unknown'});const req=s.gm[0];assert.equal(req.url,'https://console.example.test/api/bridge/poll');assert.equal(req.method,'POST');assert.equal(req.anonymous,true);assert.equal(req.redirect,'error');assert.equal(req.timeout,35000);assert(req.headers.Authorization.startsWith('Bearer '));assert.equal(req.headers.Cookie,undefined);await assert.rejects(api.bridge('https://evil.test/',{}));assert.equal(s.gm.length,1);
});
test('unknown operations and extra request arguments never fetch forum',async t=>{
 const {api,s}=setup(t);const g=api.activate();await api.execute({id:'job-1',op:'send',args:{content:'no'}},g);let reply=JSON.parse(s.gm.at(-1).data);assert.equal(reply.ok,false);assert.equal(reply.error,'schema_invalid');assert.equal(s.fetches.length,0);await api.execute({id:'job-2',op:'api',args:{path:'/api/notification/message/list',method:'POST'}},g);reply=JSON.parse(s.gm.at(-1).data);assert.equal(reply.error,'schema_invalid');assert.equal(s.fetches.length,0);
});

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const htmlUser=id=>`<title>NodeSeek</title><script id="temp-script">${Buffer.from(JSON.stringify({user:{member_id:id,member_name:'User '+id}})).toString('base64')}</script>`;
test('a periodic identity change invalidates a running API reply without clearing the new account',async t=>{
 const {api,s}=setup(t),g=api.activate(),read=deferred();
 s.fetchResponder=async url=>url.endsWith('/')?new Response(htmlUser(2)):read.promise;
 const pending=api.execute({id:'job-account-race',op:'api',args:{path:'/api/notification/message/list'}},g);
 await tick();await api.refreshIdentity(true,g);read.resolve(new Response(JSON.stringify({success:true,msgArray:[]})));await pending;
 const reply=JSON.parse(s.gm.at(-1).data);assert.equal(reply.ok,false);assert.equal(reply.error,'request_failed');assert.equal(api.snapshot().account.id,2);
});
test('a job received on a poll for the previous account is never read under the new account',async t=>{
 const {api,s}=setup(t),g=api.activate(),epoch=api.snapshot().accountEpoch;
 s.home.user.member_id=2;await api.refreshIdentity(true,g);const before=s.fetches.length;
 await api.execute({id:'job-old-poll',op:'api',args:{path:'/api/notification/message/list'}},g,epoch);
 assert.equal(s.fetches.length,before);assert.equal(JSON.parse(s.gm.at(-1).data).ok,false);assert.equal(api.snapshot().account.id,2);
});
test('page restoration starts a fresh identity instead of reusing an aborted previous generation',async t=>{
 const {api,s}=setup(t),g=api.activate(),old=deferred();let count=0;
 s.fetchResponder=async()=>++count===1?old.promise:new Response(htmlUser(2));
 const stale=api.refreshIdentity(false,g);stale.catch(()=>{});await tick();api.stop();const next=api.activate();
 const fresh=api.refreshIdentity(false,next);await tick();assert.equal(count,2);
 old.reject(new Error('aborted'));assert.equal((await fresh).id,2);await assert.rejects(stale);assert.equal(api.snapshot().account.id,2);
});
test('an old generation failed read cannot overwrite restored account or send a late reply',async t=>{
 const {api,s}=setup(t),g=api.activate(),old=deferred();
 s.fetchResponder=async()=>old.promise;
 const pending=api.execute({id:'job-pagehide',op:'api',args:{path:'/api/notification/message/list'}},g);await tick();
 api.stop();const next=api.activate();s.fetchResponder=async()=>new Response(htmlUser(2));await api.refreshIdentity(true,next);
 old.resolve(new Response(JSON.stringify({success:false,message:'login required'})));await pending;
 assert.equal(api.snapshot().account.id,2);assert.equal(api.snapshot().pageState,'forum');assert.equal(s.gm.length,0);
});

test('revoked bridge authorization stops polling and page restoration cannot restart it',async t=>{
 const {api,s,context}=setup(t);s.replyStatus=401;await api.start();await tick();
 assert.equal(api.snapshot().running,false);assert.equal(api.snapshot().terminal,true);assert.equal(s.gm.length,1);
 context.window.events.pageshow();await api.start();await tick();assert.equal(s.gm.length,1);assert.equal(s.fetches.length,1);
});
test('a hidden tab retries a transient backend failure without extra forum reads or focus',async t=>{
 const {api,s,context}=setup(t),timers=new Map();let nextTimer=0,requests=0;
 context.document.hidden=true;context.document.visibilityState='hidden';
 context.setTimeout=(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;};context.clearTimeout=id=>timers.delete(id);
 s.gmResponder=()=>++requests===1?{status:503,body:{error:'temporary'}}:{status:200,body:{job:null,retryAfter:5000}};
 await api.start();await tick();assert.equal(s.gm.length,1);assert.equal(api.snapshot().running,true);
 const [id,retry]=[...timers].find(([,timer])=>timer.delay>=2000&&timer.delay<2500);timers.delete(id);retry.fn();await tick();
 assert.equal(s.gm.length,2);assert.equal(s.fetches.length,1);assert.equal(api.snapshot().account.id,1);assert.equal(api.snapshot().running,true);
});
test('returning to the same account does not authorize a result spanning an observed switch',async t=>{
 const {api,s}=setup(t),g=api.activate(),read=deferred();let identity=2;
 s.fetchResponder=async url=>url.endsWith('/')?new Response(htmlUser(identity)):read.promise;
 const pending=api.execute({id:'job-aba',op:'api',args:{path:'/api/notification/message/list'}},g);await tick();
 await api.refreshIdentity(true,g);identity=1;await api.refreshIdentity(true,g);read.resolve(new Response(JSON.stringify({success:true,msgArray:[]})));await pending;
 assert.equal(JSON.parse(s.gm.at(-1).data).ok,false);assert.equal(api.snapshot().account.id,1);
});

test('invalid API JSON and required response fields report schema_invalid without echoing data',async t=>{
 const {api,s}=setup(t),g=api.activate();s.fetchResponder=async()=>new Response('private malformed payload');
 await api.execute({id:'job-bad-json',op:'api',args:{path:'/api/notification/message/list'}},g);
 const reply=JSON.parse(s.gm.at(-1).data);assert.equal(reply.error,'schema_invalid');assert.equal(reply.ok,false);assert(!s.gm.at(-1).data.includes('private malformed'));
 for(const data of [null,[],{}, {success:'true',msgArray:[]},{success:true,msgArray:{}},{success:true,msgArray:[{id:1}]},{success:true,msgArray:[{...msg,id:0}]}])assert.throws(()=>api.projectAPI('/api/notification/message/list',data),e=>e.code==='schema_invalid');
 assert.throws(()=>api.projectAPI('/api/notification/at-me/list',{success:true,atList:[{id:1}]}),e=>e.code==='schema_invalid');
});
test('network errors, server failures and rate limits stay transient; login and challenge remain distinct',async t=>{
 const {api,s}=setup(t);const path={path:'/api/notification/message/list'};
 for(const status of [429,500,502,503]){s.fetchResponder=async()=>new Response('temporary unavailable',{status});await assert.rejects(api.apiTask(path),e=>e.code==='request_failed');}
 for(const error of [new TypeError('private network details'),new DOMException('timed out','AbortError')]){s.fetchResponder=async()=>{throw error;};await assert.rejects(api.apiTask(path),e=>e.code==='request_failed');}
 for(const [status,code] of [[401,'login_required'],[403,'verification_required']]){s.fetchResponder=async()=>new Response('denied',{status});await assert.rejects(api.apiTask(path),e=>e.code===code);}
 s.fetchResponder=async()=>new Response('<title>Just a moment</title>');await assert.rejects(api.apiTask(path),e=>e.code==='verification_required');
});
test('oversized forum data is rejected wholly as schema_invalid',async t=>{
 const {api,s}=setup(t);s.fetchResponder=async()=>new Response('x'.repeat(512*1024+1));await assert.rejects(api.apiTask({path:'/api/notification/message/list'}),e=>e.code==='schema_invalid');
 s.fetchResponder=async()=>new Response('{}',{headers:{'content-length':String(512*1024+1)}});await assert.rejects(api.apiTask({path:'/api/notification/message/list'}),e=>e.code==='schema_invalid');
});
test('identity schema failure survives heartbeat and clears only after recognized identity or login state',async t=>{
 const {api,s}=setup(t);s.extraHTML='<title>NodeSeek</title><script id="temp-script">not-valid-base64!</script>';
 s.gmResponder=()=>({status:200,body:{job:null,retryAfter:5000}});await api.start();await tick();
 const poll=JSON.parse(s.gm[0].data);assert.equal(poll.account,null);assert.equal(poll.pageState,'unknown');assert.equal(poll.error,'schema_invalid');
 let g=api.snapshot().generation;s.fetchResponder=async()=>{throw new TypeError('temporary');};await assert.rejects(api.refreshIdentity(true,g));assert.equal(api.snapshot().lastIdentityError,'schema_invalid');
 s.fetchResponder=null;s.extraHTML=null;await api.refreshIdentity(true,g);assert.equal(api.snapshot().lastIdentityError,null);assert.equal(api.snapshot().account.id,1);
 for(const user of [{},[],{user:{id:1,name:{nested:'unexpected'}}}]){s.extraHTML=`<script id="temp-script">${Buffer.from(JSON.stringify(user)).toString('base64')}</script>`;await assert.rejects(api.refreshIdentity(true,g),e=>e.code==='schema_invalid');}
 s.login=true;api.applyDOMState();assert.equal(api.snapshot().lastIdentityError,null);assert.equal(api.snapshot().pageState,'login');
});
test('invalid operation arguments produce schema_invalid and never fetch forum',async t=>{
 const {api,s}=setup(t),g=api.activate();
 for(const job of [{id:'bad-identity',op:'identity',args:{unexpected:true}},{id:'bad-post',op:'postText',args:{postId:'../bad',floor:1}},{id:'bad-args',op:'api',args:[]}]){await api.execute(job,g);assert.equal(JSON.parse(s.gm.at(-1).data).error,'schema_invalid');}
 assert.equal(s.fetches.length,0);
});
