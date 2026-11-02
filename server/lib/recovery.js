const KEY='monitor:recovery:v1';
const TRANSIENT=new Set(['disconnected','timeout','request_failed','login_required','verification_required','bridge_closed','busy']);
const REASONS={
 UNKNOWN:'存在发送结果未知的记录，请核对后明确处理。',REJECTED:'Telegram 已拒绝发送，请检查后手动恢复。',
 ACCOUNT:'论坛账号已变化，请确认账号后手动开始。',SCHEMA:'论坛数据结构异常，请检查后手动开始。',
 PAGE:'分页边界未确认，请检查后手动开始。',GAP:'通知历史可能存在缺口，请检查后手动开始。',
 LIMIT:'达到安全读取上限，请检查后手动开始。',CONFIG:'请完成通知配置后手动开始。',
 STORAGE:'保存监控状态失败，请检查服务器后手动开始。',PAUSED:'监控已被暂停，请手动开始。',
 LEGACY:'旧监控状态缺少安全恢复记录，请确认账号后手动开始。',
 UNCONFIRMED:'无法确认上次停止原因，请检查后手动开始。',NO_ACCOUNT:'尚未确认监控账号，请登录后手动开始。',
 AUTH:'上次登录错误无法确认可安全重试，请检查后手动开始。',FETCH:'上次读取错误无法确认可安全重试，请检查后手动开始。'
};
const validId=value=>Number.isSafeInteger(value)&&value>0;
const systemClock={now:()=>Date.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:timer=>clearTimeout(timer)};
export class RecoveryController {
 constructor({monitor,browser,store,clock=systemClock,pollMs=2000,initialDelayMs=5000,maxDelayMs=300000,identityTimeoutMs=20000}){
  for(const value of [pollMs,initialDelayMs,maxDelayMs,identityTimeoutMs])if(!validId(value)||value>2147483000)throw new TypeError('Invalid recovery timing');
  if(initialDelayMs>maxDelayMs)throw new TypeError('Invalid recovery backoff');
  Object.assign(this,{monitor,browser,store,clock,pollMs,initialDelayMs,maxDelayMs,identityTimeoutMs});
  this._desired=false;this._accountId=null;this._blocked=null;this._status='disabled';this._reason='';
  this._next=null;this._timer=null;this._generation=0;this._attempt=0;this._work=null;this._manual=null;this._cancelCheck=null;this._closed=false;
  try{
   const saved=store.get(KEY,null);
   if(saved&&typeof saved==='object'){
    this._desired=saved.desired===true;this._accountId=validId(saved.accountId)?saved.accountId:null;
    this._blocked=Object.hasOwn(REASONS,saved.blocked)?saved.blocked:null;
    if(this._blocked){this._desired=false;this._status='blocked';this._reason=REASONS[this._blocked];}
   }else if(store.get('autoStart',false)===true){this._block('LEGACY');return;}
   if(this._desired)this._schedule(0);
  }catch{this._block('STORAGE');}
 }
 state(){return{desired:this._desired,state:this._status,reason:this._reason,nextRetryAt:this._next};}
 _save(){
  try{this.store.set(KEY,{desired:this._desired,accountId:this._accountId,blocked:this._blocked});return true;}
  catch{this._desired=false;this._blocked='STORAGE';this._status='blocked';this._reason=REASONS.STORAGE;this._clearTimer();return false;}
 }
 _clearTimer(){if(this._timer!==null)this.clock.clearTimeout(this._timer);this._timer=null;this._next=null;}
 _cancel(){this._generation++;this._clearTimer();this._cancelCheck?.();this._cancelCheck=null;this._manual=null;}
 _schedule(delay){
  this._clearTimer();if(this._closed||!this._desired)return;
  this._next=this.clock.now()+delay;
  this._timer=this.clock.setTimeout(()=>{this._timer=null;this._next=null;void this._tick().catch(()=>this._block('STORAGE'));},delay);
  this._timer?.unref?.();
 }
 _block(code){
  this._cancel();this._desired=false;this._blocked=Object.hasOwn(REASONS,code)?code:'UNCONFIRMED';
  this._status='blocked';this._reason=REASONS[this._blocked];this._save();
  try{this.monitor.pause({reason:this._blocked});}catch{}
 }
 _terminal(info){
  if(info.unknown)return 'UNKNOWN';if(!info.configured)return 'CONFIG';if(info.pendingAccount)return 'ACCOUNT';
  if(!validId(this._accountId)||!validId(info.accountId))return 'NO_ACCOUNT';
  if(info.accountId!==this._accountId)return 'ACCOUNT';
  if(info.running)return null;
  if(info.haltCode==='RESTART')return null;
  if(['AUTH','FETCH'].includes(info.haltCode)&&info.haltRetryable===true)return null;
  return Object.hasOwn(REASONS,info.haltCode)?info.haltCode:'UNCONFIRMED';
 }
 _wait(state,reason,delay=this.pollMs){this._status=state;this._reason=reason;this._schedule(delay);}
 _retry(){
  const delay=Math.min(this.maxDelayMs,this.initialDelayMs*2**Math.min(this._attempt++,20));
  this._wait('retrying','网络读取尚未恢复，将在稍后重新核对原账号。',delay);
 }
 async _identity(){
  let timer,cancel;
  const gate=new Promise((_,reject)=>{
   cancel=()=>reject(Object.assign(new Error('Cancelled'),{code:'cancelled'}));
   this._cancelCheck=cancel;
   timer=this.clock.setTimeout(()=>reject(Object.assign(new Error('Timed out'),{code:'timeout'})),this.identityTimeoutMs);
   timer?.unref?.();
  });
  try{return await Promise.race([Promise.resolve().then(()=>this.browser.identity()),gate]);}
  finally{this.clock.clearTimeout(timer);if(this._cancelCheck===cancel)this._cancelCheck=null;}
 }
 async _tick(){
  if(this._closed||!this._desired)return;
  if(this._work||this._manual){this._schedule(this.pollMs);return;}
  const generation=this._generation;
  const current=()=>!this._closed&&this._desired&&generation===this._generation;
  const info=this.monitor.recoveryState(),browser=this.browser.state();
  if(browser.phase==='schema_invalid'){this._block('SCHEMA');return;}
  const terminal=this._terminal(info);
  if(terminal){this._block(terminal);return;}
  if(info.running){this._attempt=0;this._wait('running','',this.pollMs);return;}
  if(info.busy){this._wait('retrying','等待上一轮读取结束。');return;}
  if(['verification_required','login_required'].includes(browser.phase)){
   this._wait('waiting_login','请在普通 Chrome 完成登录或验证，随后会核对原账号并恢复。');return;
  }
  if(browser.connected!==true){this._wait('waiting_connection','等待普通 Chrome 重新连接，连接恢复后将核对原账号。');return;}
  this._status='retrying';this._reason='正在重新核对原账号。';
  const work=(async()=>{
   try{
    const user=await this._identity();if(!current())return;
    if(user===null){this._wait('waiting_login','等待论坛登录恢复。');return;}
    if(!validId(user?.id)){this._block('SCHEMA');return;}
    if(user.id!==this._accountId){this._block('ACCOUNT');return;}
    const latest=this.monitor.recoveryState(),unsafe=this._terminal(latest);
    if(unsafe){this._block(unsafe);return;}
    if(!current())return;
    await this.monitor.start({automatic:true,expectedAccountId:this._accountId});if(!current())return;
    const after=this.monitor.recoveryState(),failed=this._terminal(after);
    if(failed){this._block(failed);return;}
    if(after.running){this._attempt=0;this._wait('running','');}else this._retry();
   }catch(error){
    if(!current())return;
    if(error?.code==='schema_invalid'){this._block('SCHEMA');return;}
    if(!TRANSIENT.has(error?.code)){this._block('UNCONFIRMED');return;}
    this._retry();
   }
  })();
  this._work=work;try{await work;}finally{if(this._work===work)this._work=null;}
 }
 _command(kind,options){
  if(this._closed)return Promise.resolve(this.state());
  if(this._manual)return this._manual;
  this._cancel();const generation=this._generation;
  this._desired=true;this._blocked=null;this._attempt=0;this._status='retrying';this._reason='正在启动监控并确认账号。';
  if(!this._save()){this.monitor.pause({reason:'STORAGE'});return Promise.resolve(this.state());}
  const before=this.monitor.recoveryState();
  if(!before.running)this.monitor.pause({reason:before.haltCode||'PAUSED'});
  const work=(async()=>{
   try{
    await this.monitor[kind](options);
    if(this._closed||generation!==this._generation||!this._desired)return this.state();
    const after=this.monitor.recoveryState();
    if(validId(after.accountId))this._accountId=after.accountId;
    const terminal=this._terminal(after);
    if(terminal){this._block(terminal);return this.state();}
    if(!this._save()){this.monitor.pause({reason:'STORAGE'});return this.state();}
    if(after.running)this._wait('running','');else this._retry();
   }catch(error){
    if(generation===this._generation&&!this._closed)this._block(error?.code==='schema_invalid'?'SCHEMA':'UNCONFIRMED');
   }finally{if(this._manual===work)this._manual=null;}
   return this.state();
  })();
  this._manual=work;return work;
 }
 start(){return this._command('start');}
 resume(options={}){return this._command('resume',options);}
 pause(){
  this._cancel();this._desired=false;this._blocked=null;this._attempt=0;this._status='disabled';this._reason='';
  this._save();this.monitor.pause();return this.state();
 }
 configureChanged(options={}){
  this._cancel();this._desired=false;this._blocked=null;this._attempt=0;this._status='disabled';this._reason='';
  this._save();this.monitor.configureChanged(options);return this.state();
 }
 close(){
  if(this._closed)return;
  this._cancel();this._closed=true;
  const info=this.monitor.recoveryState();
  const terminal=this._desired?this._terminal(info):null;
  if(terminal){this._block(terminal);return;}
  const restart=this._desired&&(info.running||info.haltCode==='RESTART'||['AUTH','FETCH'].includes(info.haltCode)&&info.haltRetryable);
  this.monitor.pause({reason:restart?'RESTART':info.haltCode||'PAUSED'});
 }
}
