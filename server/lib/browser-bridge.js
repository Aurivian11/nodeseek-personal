import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
const MAX_BODY=512*1024;
const client=value=>typeof value==='string'&&value.length>=16&&value.length<=100&&!/[^A-Za-z0-9_-]/.test(value);
const ERRORS=new Set(['verification_required','login_required','request_failed','schema_invalid']);
const STATES=new Set(['forum','verification','login','unknown']);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
function account(value){
 if(!record(value)||!positive(value.id)||typeof value.name!=='string'||value.name.length>100)return null;
 return {id:value.id,name:value.name};
}
function fault(code='request_failed'){
 const message={verification_required:'请在普通 Chrome 中完成论坛验证',login_required:'请在普通 Chrome 中登录论坛',
  schema_invalid:'论坛数据格式发生变化，请检查通知连接脚本',disconnected:'普通 Chrome 连接已断开，请保持论坛标签页开启',bridge_closed:'浏览器连接已关闭',
  timeout:'浏览器读取超时，请检查论坛标签页',busy:'浏览器任务繁忙，请稍后再试'}[code]||'浏览器读取未完成，请检查论坛页面';
 return Object.assign(new Error(message),{code});
}
function send(res,status,data){
 if(res.destroyed||res.writableEnded)return;
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 res.end(JSON.stringify(data));
}
function readBody(req){
 return new Promise((resolve,reject)=>{
  let size=0,done=false;const chunks=[];
  const finish=(error,value)=>{
   if(done)return;done=true;clearTimeout(timer);
   req.off('data',data);req.off('end',end);req.off('error',errorHandler);req.off('aborted',aborted);
   req.on('error',()=>{}); // A client abort may emit error after aborted.
   if(error){req.resume();reject(error);}else resolve(value);
  };
  const data=chunk=>{size+=chunk.length;if(size>MAX_BODY)return finish({status:413});chunks.push(chunk);};
  const end=()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!record(value))throw 0;finish(null,value);}catch{finish({status:400});}};
  const errorHandler=()=>finish({status:400}),aborted=()=>finish({status:400});
  const timer=setTimeout(()=>finish({status:408}),5000);timer.unref();
  req.on('data',data);req.once('end',end);req.once('error',errorHandler);req.once('aborted',aborted);
  if(Number(req.headers['content-length'])>MAX_BODY)finish({status:413});
 });
}
export function allowedBridgeAPI(value){
 if(typeof value!=='string'||value.length>200||/\s/.test(value))return false;
 const match=/^\/api\/notification\/(?:message\/(?:list|with\/([1-9]\d*))|at-me\/list|reply-to-me\/list)(?:\?page=([1-9]\d*))?$/.exec(value);
 return !!match&&[match[1],match[2]].every(part=>part===undefined||positive(Number(part)));
}
export class BrowserBridge {
 #digest;
 constructor({secret,pollTimeoutMs=25000,leaseMs=90000,jobTimeoutMs=30000,maxQueue=8}={}){
  if(!Buffer.isBuffer(secret)||secret.length!==32)throw new TypeError('A 32-byte bridge secret is required');
  for(const value of [pollTimeoutMs,leaseMs,jobTimeoutMs])if(!positive(value)||value>180000)throw new TypeError('Invalid bridge timeout');
  if(!positive(maxQueue)||maxQueue>16)throw new TypeError('Invalid bridge queue limit');
  this.#digest=createHash('sha256').update(secret.toString('base64url')).digest();
  Object.assign(this,{pollTimeoutMs,leaseMs,jobTimeoutMs,maxQueue});
  this._owner=null;this._expires=0;this._epoch=0;this._hint=null;this._verified=null;
  this._page='unknown';this._phase='disconnected';this._queue=[];this._inflight=null;
  this._poll=null;this._leaseTimer=null;this._closed=false;
 }
 _authorized(req){
  const header=typeof req.headers.authorization==='string'?req.headers.authorization:'';
  const token=header.startsWith('Bearer ')?header.slice(7):'';
  const digest=createHash('sha256').update(token).digest();
  return timingSafeEqual(this.#digest,digest)&&/^[A-Za-z0-9_-]{43}$/.test(token);
 }
 _finishPoll(data,status=200){
  const pending=this._poll;if(!pending)return;
  this._poll=null;clearTimeout(pending.timer);pending.res.off('close',pending.closed);
  send(pending.res,status,data);pending.resolve();
 }
 _rejectJobs(code){
  const jobs=[...this._queue,...(this._inflight?[this._inflight]:[])];
  this._queue=[];this._inflight=null;
  for(const job of jobs){clearTimeout(job.timer);job.reject(fault(code));}
 }
 _expire(){
  if(!this._owner||Date.now()<this._expires)return;
  clearTimeout(this._leaseTimer);this._leaseTimer=null;
  this._owner=null;this._expires=0;this._epoch++;this._hint=null;this._verified=null;
  this._page='unknown';this._phase='disconnected';
  this._rejectJobs('disconnected');this._finishPoll({job:null,retryAfter:1000});
 }
 _renew(){
  this._expires=Date.now()+this.leaseMs;clearTimeout(this._leaseTimer);
  this._leaseTimer=setTimeout(()=>this._expire(),this.leaseMs+1);this._leaseTimer.unref();
 }
 get account(){this._expire();return this._owner&&this._page==='forum'&&this._hint?{...this._hint}:null;}
 state(){
  this._expire();const connected=!!this._owner&&!this._closed;
  return {connected,running:connected,phase:this._closed?'stopped':this._phase,url:connected?'https://www.nodeseek.com':''};
 }
 async open(){if(this.state().phase==='schema_invalid')throw fault('schema_invalid');if(!this.state().connected)throw fault('disconnected');return this.state();}
 async identity(){
  this._expire();
  if(this._phase==='schema_invalid')throw fault('schema_invalid');
  if(!this._owner||this._closed)throw fault('disconnected');
  if(this._page==='login')return null;
  if(this._page!=='forum')throw fault(this._page==='verification'?'verification_required':'request_failed');
  return this._enqueue('identity',{});
 }
 async api(path){
  if(!allowedBridgeAPI(path))throw fault('request_failed');
  this._requireVerified();return this._enqueue('api',{path});
 }
 async postText(postId,floor){
  const raw=String(postId),rawFloor=String(floor??'').replace(/^#/,'');
  const id=Number(raw),f=Number(rawFloor);
  if(!/^[1-9]\d*$/.test(raw)||!/^[1-9]\d*$/.test(rawFloor)||!positive(id)||!positive(f)||f>1000000)return '';
  this._requireVerified();return this._enqueue('postText',{postId:id,floor:f});
 }
 _requireVerified(){
  this._expire();if(this._closed||!this._owner)throw fault('disconnected');
  if(this._page!=='forum'||!this._verified||this._verified.id!==this._hint?.id)throw fault(this._page==='verification'?'verification_required':'login_required');
 }
 _enqueue(op,args){
  if(this._queue.length+(this._inflight?1:0)>=this.maxQueue)return Promise.reject(fault('busy'));
  return new Promise((resolve,reject)=>{
   const job={id:randomUUID(),op,args,clientId:this._owner,epoch:this._epoch,accountId:this._verified?.id,resolve,reject};
   job.timer=setTimeout(()=>{
    if(this._inflight!==job&&!this._queue.includes(job))return;
    this._verified=null;this._phase='request_failed';this._rejectJobs('timeout');
    this._finishPoll({job:null,retryAfter:1000});
   },this.jobTimeoutMs);job.timer.unref();
   this._queue.push(job);this._dispatch();
  });
 }
 _dispatch(){
  this._expire();if(!this._poll||this._inflight||this._page!=='forum'||!this._owner||!this._queue.length)return;
  const job=this._queue.shift();this._inflight=job;
  this._finishPoll({job:{id:job.id,op:job.op,args:job.args}});
 }
 _releaseOwner(code,phase){
  clearTimeout(this._leaseTimer);this._leaseTimer=null;this._owner=null;this._expires=0;this._epoch++;
  this._hint=null;this._verified=null;this._page='unknown';this._phase=phase;
  this._rejectJobs(code);this._finishPoll({job:null,retryAfter:1000});
 }
 async _handlePoll(req,res,value){
  if(!client(value.clientId)||!STATES.has(value.pageState)||!Object.hasOwn(value,'account')
   ||value.account!==null&&!account(value.account)
   ||value.error!==undefined&&(value.error!=='schema_invalid'||value.pageState!=='unknown'||value.account!==null))return send(res,400,{error:'invalid_request'});
  this._expire();
  if(this._owner&&this._owner!==value.clientId)return send(res,200,{job:null,standby:true,retryAfter:5000});
  const next=value.pageState==='forum'?account(value.account):null;
  if(value.pageState!=='forum'||!next){
   const phase=value.error==='schema_invalid'?'schema_invalid':value.pageState==='verification'?'verification_required':value.pageState==='login'||value.pageState==='forum'?'login_required':'disconnected';
   if(this._owner)this._releaseOwner(phase==='disconnected'?'disconnected':phase,phase);else this._phase=phase;
   return send(res,200,{job:null,retryAfter:5000});
  }
  if(!this._owner){this._owner=value.clientId;this._epoch++;this._verified=null;}
  this._renew();
  if(next.id!==this._hint?.id){this._verified=null;this._rejectJobs('login_required');}
  this._hint=next;this._page='forum';this._phase=this._verified?'logged_in':'connected';
  if(this._poll)return send(res,409,{error:'poll_pending'});
  await new Promise(resolve=>{
   const pending={res,resolve,timer:null,closed:null};
   pending.closed=()=>{
    if(this._poll!==pending)return;
    this._poll=null;clearTimeout(pending.timer);resolve();
   };
   this._poll=pending;res.once('close',pending.closed);
   pending.timer=setTimeout(()=>this._finishPoll({job:null,retryAfter:250}),this.pollTimeoutMs);pending.timer.unref();
   if(res.destroyed)pending.closed();else this._dispatch();
  });
 }
 _handleReply(res,value){
  this._expire();
  if(!client(value.clientId)||typeof value.id!=='string'||!/^[0-9a-f-]{36}$/.test(value.id)
   ||typeof value.ok!=='boolean'||value.ok&&!Object.hasOwn(value,'result')||!value.ok&&!ERRORS.has(value.error))return send(res,400,{error:'invalid_request'});
  const job=this._inflight;
  if(!job||job.id!==value.id||job.clientId!==value.clientId||this._owner!==value.clientId||job.epoch!==this._epoch)return send(res,409,{error:'stale_reply'});
  if(!value.ok){
   if(value.error==='request_failed'){this._verified=null;this._phase=value.error;this._rejectJobs(value.error);this._finishPoll({job:null,retryAfter:1000});}
   else this._releaseOwner(value.error,value.error);
   return send(res,200,{ok:true});
  }
  const result=value.result;
  const valid=job.op==='identity'?(result===null||!!account(result)):
   job.op==='api'?record(result)&&result.success===true:typeof result==='string'&&result.length<=2000;
  if(!valid||job.op!=='identity'&&(!this._verified||job.accountId!==this._verified.id||this._hint?.id!==this._verified.id)){
   this._verified=null;this._phase='schema_invalid';this._rejectJobs('schema_invalid');
   this._finishPoll({job:null,retryAfter:1000});return send(res,422,{error:'invalid_result'});
  }
  this._renew();clearTimeout(job.timer);this._inflight=null;
  let safe=result;
  if(job.op==='identity'){
   safe=account(result);const changed=safe?.id!==this._hint?.id;
   this._hint=safe;this._verified=safe;this._phase=safe?'logged_in':'login_required';
   if(!safe)this._page='login';
   if(changed||!safe)this._rejectJobs('login_required');
  }
  job.resolve(safe);send(res,200,{ok:true});this._dispatch();
 }
 async handleHttp(req,res){
  if(req.method!=='POST'||!['/api/bridge/poll','/api/bridge/reply'].includes(req.url))return false;
  if(!this._authorized(req)){req.resume();send(res,401,{error:'unauthorized'});return true;}
  if(this._closed){req.resume();send(res,503,{error:'bridge_closed'});return true;}
  if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||''))){req.resume();send(res,415,{error:'invalid_request'});return true;}
  try{
   const value=await readBody(req);
   if(this._closed)send(res,503,{error:'bridge_closed'});
   else if(req.url==='/api/bridge/poll')await this._handlePoll(req,res,value);
   else this._handleReply(res,value);
  }catch(error){send(res,[400,408,413].includes(error?.status)?error.status:400,{error:'invalid_request'});}
  return true;
 }
 close(){
  if(this._closed)return;this._closed=true;clearTimeout(this._leaseTimer);this._leaseTimer=null;
  this._owner=null;this._hint=null;this._verified=null;this._phase='stopped';this._epoch++;
  this._rejectJobs('bridge_closed');this._finishPoll({error:'bridge_closed'},503);
 }
}
