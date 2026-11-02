// Server-only worker. NodeSeek reads never mark notifications as read.
const TYPES=['message','at','reply'];
const LABEL={message:'新私信',at:'@我',reply:'主题回复'};
const PATH={message:'/api/notification/message/list',at:'/api/notification/at-me/list',reply:'/api/notification/reply-to-me/list'};
const ORIGIN='https://www.nodeseek.com',INTERVAL=60000,MAX_PAGES=10,MAX_NEW=100;
const ERR={CONFIG:'请填写Telegram配置并选择监听类型。',AUTH:'无法确认论坛登录，请更新会话后继续。',ACCOUNT:'论坛账号已变化，已暂停；请明确重新启动以建立新基线。',SCHEMA:'论坛返回格式异常，检查点未推进。',FETCH:'抓取未完成，检查点未推进。',LIMIT:'达到本轮抓取上限，已暂停，检查点未推进。',PAGE:'分页重复或历史边界未确认，检查点未推进。',GAP:'会话记录未覆盖已知边界，可能存在缺口，检查点未推进。',STORAGE:'服务存储操作失败，已暂停。',UNKNOWN:'存在发送结果未知的记录，请核对并明确跳过后继续。',REJECTED:'Telegram明确拒绝发送，请检查配置后继续。'};
const TRANSIENT_BROWSER=new Set(['disconnected','timeout','request_failed','login_required','verification_required','bridge_closed','busy']);
class Fault extends Error{constructor(code,retryable=false){super(ERR[code]||ERR.FETCH);this.code=code;this.retryable=retryable===true;}}
const fail=code=>{throw new Fault(code);};
function id(v,zero=false){if(!['number','string'].includes(typeof v)||!(zero?/^\d+$/:/^[1-9]\d*$/).test(String(v)))return null;const n=Number(v);return Number.isSafeInteger(n)?n:null;}
function clip(v,n){let s=String(v??'');if(s.length<=n)return s;s=s.slice(0,n-1);const c=s.charCodeAt(s.length-1);if(c>=0xd800&&c<=0xdbff)s=s.slice(0,-1);return s+'…';}
function plain(v,n=1600){if(typeof v!=='string')return '';const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};return clip(v.slice(0,200000).replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,e)=>{if(e[0]!=='#')return entities[e.toLowerCase()]||' ';const hex=e[1]?.toLowerCase()==='x',c=parseInt(e.slice(hex?2:1),hex?16:10);return Number.isFinite(c)&&c>=32&&c<=0x10ffff&&!(c>=0xd800&&c<=0xdfff)?String.fromCodePoint(c):' ';}).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim(),n);}
function identity(v){const uid=id(v?.id);return uid?{id:uid,name:plain(String(v.name||`用户 ${uid}`),80)}:null;}
function config(v){return{token:typeof v?.token==='string'?v.token.trim():'',chatId:String(v?.chatId??'').trim(),types:Object.fromEntries(TYPES.map(t=>[t,v?.types?.[t]===true])),includeSummary:v?.includeSummary!==false};}
async function deadline(work,ms=20000){let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Fault('FETCH',true)),ms);})]);}finally{clearTimeout(timer);}}
export class Monitor{
 constructor({store,browser,getConfig,sendTelegram}){
  Object.assign(this,{store,db:store.db,browser,getConfig,sendTelegram});
  this.running=false;this.phase='已停止';this.lastError='';this.lastCheck=null;this.nextCheck=null;this.account=null;this.haltCode=null;this.haltRetryable=false;
  this._gen=0;this._busy=null;this._timer=null;this._pendingAccount=null;this._destinationGen=0;this._startSerial=0;
  this.db.exec(`CREATE TABLE IF NOT EXISTS ns_monitor_cursors(account TEXT,type TEXT,cursor TEXT,updated INTEGER,PRIMARY KEY(account,type));
CREATE TABLE IF NOT EXISTS ns_monitor_peers(account TEXT,peer TEXT,latest TEXT,incoming TEXT,PRIMARY KEY(account,peer));
CREATE TABLE IF NOT EXISTS ns_monitor_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,type TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,not_before INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',UNIQUE(account,type,event_id));
CREATE INDEX IF NOT EXISTS ns_monitor_queue ON ns_monitor_outbox(account,status,id);`);
  const saved=store.get('monitor:runtime:v1');this.account=identity(saved?.account);this.lastCheck=Number.isFinite(saved?.lastCheck)?saved.lastCheck:null;
  this.haltCode=Object.hasOwn(ERR,saved?.haltCode)||['PAUSED','RESTART'].includes(saved?.haltCode)?saved.haltCode:saved?.running===true?'RESTART':null;
  this.haltRetryable=['AUTH','FETCH'].includes(this.haltCode)&&saved?.haltRetryable===true;
  if(this.haltCode){this.phase='已暂停';this.lastError=ERR[this.haltCode]||'';}
  this._rateUntil=Number(store.get('monitor:rate-until',0))||0;
  this.db.prepare("UPDATE ns_monitor_outbox SET status='unknown',updated=?,note=? WHERE status='sending'").run(Date.now(),'服务重启，上一发送结果未确认');
  this._prune();if(this._unknown())this._stopReason('UNKNOWN','待核对发送结果');
 }
 // Different bound identities ALWAYS stop the current attempt. Adoption is
 // possible only after this detection, while stopped, on a separate start().
 _adopt(user,g){
  this._assert(g);
  if(this.account&&this.account.id!==user.id){this._pendingAccount=user;fail('ACCOUNT');}
  if(!this.account){this.account=user;this._persist();}
  else this.account=user;
 }
 _acceptPendingAccount(user){
  if(this.running||this._busy||!this._pendingAccount||this._pendingAccount.id!==user.id)fail('ACCOUNT');
  const account=String(user.id);
  this._tx(()=>{
   this.db.prepare('DELETE FROM ns_monitor_cursors WHERE account=?').run(account);
   this.db.prepare('DELETE FROM ns_monitor_peers WHERE account=?').run(account);
   this.db.prepare("UPDATE ns_monitor_outbox SET status='skipped',payload='',updated=?,note=? WHERE status IN ('pending','failed')").run(Date.now(),'确认切换账号，旧队列不再自动发送');
  });
  this.account=user;this._pendingAccount=null;this._persist();this._prune();
 }
 _config(){try{return config(this.getConfig());}catch{return config(null);}}
 _configured(c=this._config()){return !!c.token&&!!c.chatId&&TYPES.some(t=>c.types[t]);}
 _unknown(){return Number(this.db.prepare("SELECT COUNT(*) AS n FROM ns_monitor_outbox WHERE status='unknown'").get().n);}
 _prune(){this.db.exec("DELETE FROM ns_monitor_outbox WHERE status IN ('sent','skipped') AND id NOT IN (SELECT id FROM ns_monitor_outbox WHERE status IN ('sent','skipped') ORDER BY id DESC LIMIT 2000)");}
 _persist(){try{this.store.set('monitor:runtime:v1',{account:this.account,lastCheck:this.lastCheck,running:this.running,haltCode:this.haltCode,haltRetryable:this.haltRetryable});}catch{fail('STORAGE');}}
 _stopReason(code,phase='已暂停',retryable=false){this.haltCode=code;this.haltRetryable=['AUTH','FETCH'].includes(code)&&retryable===true;this.phase=phase;this.lastError=ERR[code]||'';try{this._persist();}catch{this.haltCode='STORAGE';this.haltRetryable=false;this.lastError=ERR.STORAGE;}}
 _tx(work){this.db.exec('BEGIN IMMEDIATE');try{const value=work();this.db.exec('COMMIT');return value;}catch{try{this.db.exec('ROLLBACK');}catch{}fail('STORAGE');}}
 _assert(g){if(!this.running||g!==this._gen)fail('PAUSED');}
 _halt(code,g=this._gen,retryable=false){if(g!==this._gen||!this.running)return;this.running=false;this._gen++;clearTimeout(this._timer);this._timer=null;this.nextCheck=null;this._stopReason(Object.hasOwn(ERR,code)?code:'FETCH',code==='UNKNOWN'?'待核对发送结果':'已暂停',retryable);}
 _schedule(delay=INTERVAL){clearTimeout(this._timer);if(!this.running){this.nextCheck=null;return;}const wait=Math.max(INTERVAL,delay,this._rateUntil-Date.now());this.nextCheck=Date.now()+wait;this._timer=setTimeout(()=>{this._timer=null;void this.check();},Math.min(wait,2147483000));this._timer.unref?.();}
 _canRecover(expected){return Number.isSafeInteger(expected)&&expected>0&&this.account?.id===expected&&!this._pendingAccount&&(this.haltCode==='RESTART'||['AUTH','FETCH'].includes(this.haltCode)&&this.haltRetryable);}
 recoveryState(){return{running:this.running,busy:!!this._busy,haltCode:this.haltCode,haltRetryable:this.haltRetryable,accountId:this.account?.id||null,configured:this._configured(),unknown:this._unknown()>0,pendingAccount:!!this._pendingAccount};}
 async start({automatic=false,expectedAccountId=null}={}){
  if(this.running)return this.state();if(automatic&&!this._canRecover(expectedAccountId))return this.state();const attempt=++this._startSerial;
  if(this._busy)await this._busy;if(attempt!==this._startSerial)return this.state();
  if(automatic&&!this._canRecover(expectedAccountId))return this.state();
  if(!this._configured()){this._stopReason('CONFIG','等待配置');return this.state();}
  if(this._unknown()){this._stopReason('UNKNOWN','待核对发送结果');return this.state();}
  if(this._pendingAccount){
   try{const user=identity(await deadline(()=>this.browser.identity()));if(attempt!==this._startSerial)return this.state();if(!user)fail('AUTH');if(user.id!==this._pendingAccount.id){this._pendingAccount=user;fail('ACCOUNT');}this._acceptPendingAccount(user);}
   catch(error){if(attempt!==this._startSerial)return this.state();this._stopReason(error instanceof Fault?error.code:'AUTH','已暂停',error?.retryable===true||TRANSIENT_BROWSER.has(error?.code));return this.state();}
  }
  this.running=true;this._gen++;this.phase='正在确认登录';this.lastError='';this.haltCode=null;this.haltRetryable=false;try{this._persist();}catch{this._halt('STORAGE');return this.state();}return this.check();
 }
 pause({reason='PAUSED'}={}){this._startSerial++;this.running=false;this._gen++;clearTimeout(this._timer);this._timer=null;this.nextCheck=null;this._stopReason(Object.hasOwn(ERR,reason)||reason==='RESTART'?reason:'PAUSED');return this.state();}
 configureChanged({destinationChanged=false}={}){this.pause();if(destinationChanged)this._destinationGen++;if(destinationChanged)this.db.prepare("UPDATE ns_monitor_outbox SET status='skipped',payload='',updated=?,note=? WHERE status IN ('pending','failed')").run(Date.now(),'更换推送目标，旧待发送通知已跳过');this._prune();return this.state();}
 async resume(options={}){if(this.running)return this.state();const attempt=++this._startSerial;if(this._busy)await this._busy;if(attempt!==this._startSerial)return this.state();if(this._unknown()){if(options.skipUnknown!==true){this._stopReason('UNKNOWN','待核对发送结果');return this.state();}this.db.prepare("UPDATE ns_monitor_outbox SET status='skipped',payload='',updated=?,note=? WHERE status='unknown'").run(Date.now(),'用户核对后明确跳过，未重新发送');}if(this.account)this.db.prepare("UPDATE ns_monitor_outbox SET status='pending',updated=?,not_before=0,note=? WHERE account=? AND status='failed'").run(Date.now(),'等待明确拒绝后的重试',String(this.account.id));this._prune();return this.start();}
 async check(){if(this._busy){await this._busy;return this.state();}if(!this.running)return this.state();clearTimeout(this._timer);this._timer=null;this.nextCheck=null;const g=this._gen;let wait=INTERVAL;const task=(async()=>{try{wait=await this._cycle(g);}catch(error){if(g===this._gen&&error?.code!=='PAUSED')this._halt(error instanceof Fault&&ERR[error.code]?error.code:'FETCH',g,error instanceof Fault&&error.retryable);}finally{if(this.running&&g===this._gen)this._schedule(wait);}})();this._busy=task;try{await task;}finally{if(this._busy===task)this._busy=null;}return this.state();}
 async _identity(g){this._assert(g);let value;try{value=await deadline(()=>this.browser.identity());}catch(error){if(error?.code==='schema_invalid')fail('SCHEMA');throw new Fault('AUTH',error?.retryable===true||TRANSIENT_BROWSER.has(error?.code));}this._assert(g);const user=identity(value);if(!user){if(value!==null)fail('SCHEMA');throw new Fault('AUTH',true);}return user;}
 async _read(path,g){this._assert(g);let result;try{result=await deadline(()=>this.browser.api(path));}catch(error){if(error?.code==='schema_invalid')fail('SCHEMA');throw new Fault(['login_required','verification_required'].includes(error?.code)?'AUTH':'FETCH',error?.retryable===true||TRANSIENT_BROWSER.has(error?.code));}this._assert(g);if(!result||typeof result!=='object'||Array.isArray(result))fail('SCHEMA');if(result.success!==true)fail('AUTH');return result;}
 _cursor(account,type){const r=this.db.prepare('SELECT cursor FROM ns_monitor_cursors WHERE account=? AND type=?').get(String(account),type);return r?Number(r.cursor):null;}
 _peer(account,peer){return this.db.prepare('SELECT latest,incoming FROM ns_monitor_peers WHERE account=? AND peer=?').get(String(account),String(peer));}
 _rows(type,result,detail=false){
  let raw;if(type==='message')raw=result.msgArray;else{const nested=result.data&&typeof result.data==='object'&&!Array.isArray(result.data)?result.data:{};raw=[type==='at'?result.atList:result.replyList,result.msgArray,result.notifications,result.list,result.data,nested.atList,nested.replyList,nested.msgArray,nested.list].find(Array.isArray);}
  if(!Array.isArray(raw)||raw.length>2000)fail('SCHEMA');
  return raw.map(row=>{if(!row||typeof row!=='object')fail('SCHEMA');if(type==='message'){const uid=id(detail?row.id:(row.max_id??row.id)),sender=id(row.sender_id,true),receiver=id(row.receiver_id,true);if(!uid||sender===null||receiver===null||typeof row.content!=='string')fail('SCHEMA');return{...row,_id:uid,sender_id:sender,receiver_id:receiver};}const uid=id(row.id),post=id(row.post_id);if(!uid||!post)fail('SCHEMA');return{...row,_id:uid,post_id:post};});
 }
 async _scan(type,cursor,g){
  const found=new Map(),signatures=new Set();let max=cursor;
  for(let page=1;page<=MAX_PAGES;page++){
   const rows=this._rows(type,await this._read(`${PATH[type]}?page=${page}`,g));
   if(!rows.length)return{rows:[...found.values()],max};
   // The list is newest first. An unordered page cannot prove an old boundary.
   if(rows.some((row,index)=>index>0&&row._id>rows[index-1]._id))fail('PAGE');
   const signature=rows.map(r=>r._id).sort((a,b)=>a-b).join(',');if(signatures.has(signature))fail('PAGE');signatures.add(signature);
   for(const row of rows){max=Math.max(max,row._id);if(row._id>cursor)found.set(row._id,row);}
   if(found.size>=MAX_NEW)fail('LIMIT');
   // Collect the entire page before stopping; some endpoints repeat page 1.
   // A repeated all-new page still fails above instead of losing unseen records.
   if(rows.some(row=>row._id<=cursor))return{rows:[...found.values()],max};
  }fail('LIMIT');
 }
 async _baseline(type,account,g){const rows=this._rows(type,await this._read(`${PATH[type]}?page=1`,g)),cursor=rows.reduce((m,r)=>Math.max(m,r._id),0),peers=[];if(type==='message'){const latest=new Map();for(const row of rows){if(row.sender_id!==account&&row.receiver_id!==account)fail('SCHEMA');const peer=row.sender_id===account?row.receiver_id:row.sender_id;if(peer===account||!id(peer))continue;latest.set(peer,Math.max(latest.get(peer)||0,row._id));}for(const [peer,latestId]of latest)peers.push({peer,latest:latestId,incoming:cursor});}return{type,cursor,peers,events:[],baseline:true};}
 _event(budget,event){budget.push(event);if(budget.length>=MAX_NEW)fail('LIMIT');}
 async _private(account,cursor,c,g,budget){
  const scanned=await this._scan('message',cursor,g),changed=new Map(),events=[],peers=[];
  for(const row of scanned.rows){if(row.sender_id!==account&&row.receiver_id!==account)fail('SCHEMA');const peer=row.sender_id===account?row.receiver_id:row.sender_id;if(peer===account)continue;if(!id(peer))fail('SCHEMA');if(!changed.has(peer)||row._id>changed.get(peer)._id)changed.set(peer,row);}
  for(const [peer,summary]of changed){
   const stored=this._peer(account,peer);if(stored&&summary._id<=Number(stored.latest))continue;
   const result=await this._read(`/api/notification/message/with/${peer}`,g),rows=this._rows('message',result,true);
   for(const row of rows)if(!(row.sender_id===account&&row.receiver_id===peer||row.sender_id===peer&&row.receiver_id===account))fail('SCHEMA');
   const highest=rows.reduce((m,r)=>Math.max(m,r._id),0);if(highest<summary._id)fail('GAP');
   const floor=Math.max(cursor,Number(stored?.incoming||0));if(stored&&rows.length&&rows.every(r=>r._id>floor))fail('GAP');
   let incoming=Number(stored?.incoming||cursor);
   for(const row of [...new Map(rows.map(r=>[r._id,r])).values()].sort((a,b)=>a._id-b._id)){
    if(row.receiver_id!==account)continue;incoming=Math.max(incoming,row._id);if(row._id<=floor)continue;
    const event={type:'message',id:row._id,source:plain(row.sender_name||result.talkTo?.member_name||`用户 ${peer}`,80),date:plain(row.created_at||'',80),subject:'',summary:c.includeSummary?plain(row.content)||'暂无文字内容':'',url:`${ORIGIN}/notification#/message?mode=talk&to=${peer}`};this._event(budget,event);events.push(event);
   }peers.push({peer,latest:Math.max(summary._id,highest),incoming});
  }
  // Never advance the list cursor to IDs observed only by /with.
  return{type:'message',cursor:scanned.max,peers,events,baseline:false};
 }
 async _notices(type,cursor,c,g,budget){const scanned=await this._scan(type,cursor,g),events=[];for(const row of scanned.rows.sort((a,b)=>a._id-b._id)){
  const value=String(row.floor_id??'').replace(/^#/,''),floor=/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
  let summary=c.includeSummary?plain(row.content):'';
  if(c.includeSummary&&!summary&&typeof this.browser.postText==='function'){try{summary=plain(await deadline(()=>this.browser.postText(row.post_id,floor)));}catch{summary='';}this._assert(g);}
  const event={type,id:row._id,source:plain(row.commenter_name||'用户',80),date:plain(row.created_at||'',80),subject:plain(row.post_title||row.title||`帖子 ${row.post_id}`,220),summary:c.includeSummary?summary||'正文暂不可用，请打开原帖查看':'',url:`${ORIGIN}/post-${row.post_id}-1`,floor};this._event(budget,event);events.push(event);
 }return{type,cursor:scanned.max,peers:[],events,baseline:false};}
 _text(e){return clip([`NodeSeek · ${LABEL[e.type]}`,`来源：${e.source}`,...(e.date?[`时间：${e.date}`]:[]),...(e.subject?[`主题：${e.subject}`]:[]),...(e.floor!==null&&e.floor!==undefined?[`楼层：#${e.floor}`]:[]),...(e.summary?['',e.summary]:[]),'',e.url,`事件：${e.type}-${e.id}`].join('\n'),3500);}
 _commit(account,stages){let prepared;try{prepared=stages.map(s=>({...s,encrypted:s.events.map(event=>{const payload=this.store.encrypt(JSON.stringify({text:this._text(event)}));if(typeof payload!=='string'||!payload)fail('STORAGE');return{event,payload};})}));}catch{fail('STORAGE');}const now=Date.now();this._tx(()=>{for(const s of prepared){for(const {event,payload}of s.encrypted)this.db.prepare("INSERT OR IGNORE INTO ns_monitor_outbox(account,type,event_id,payload,status,created,updated,note) VALUES(?,?,?,?,'pending',?,?,?)").run(String(account),s.type,String(event.id),payload,now,now,'等待发送');for(const p of s.peers)this.db.prepare('INSERT INTO ns_monitor_peers(account,peer,latest,incoming) VALUES(?,?,?,?) ON CONFLICT(account,peer) DO UPDATE SET latest=excluded.latest,incoming=excluded.incoming').run(String(account),String(p.peer),String(p.latest),String(p.incoming));this.db.prepare('INSERT INTO ns_monitor_cursors(account,type,cursor,updated) VALUES(?,?,?,?) ON CONFLICT(account,type) DO UPDATE SET cursor=excluded.cursor,updated=excluded.updated').run(String(account),s.type,String(s.cursor),now);}});}
 async _deliver(account,c,g){
  const enabled=TYPES.filter(t=>c.types[t]);if(!enabled.length)return INTERVAL;
  const queue=this.db.prepare(`SELECT * FROM ns_monitor_outbox WHERE account=? AND status='pending' AND type IN (${enabled.map(()=>'?').join(',')}) ORDER BY id LIMIT 100`).all(String(account),...enabled);
  for(const row of queue){
   this._assert(g);const live=this._config();if(!this._configured(live))fail('CONFIG');if(!live.types[row.type])continue;
   const wait=Math.max(Number(row.not_before),this._rateUntil)-Date.now();if(wait>0){this.phase='等待Telegram限流恢复';return Math.max(INTERVAL,wait);}
   const user=await this._identity(g);if(user.id!==account){this._pendingAccount=user;fail('ACCOUNT');}
   let text;try{const data=JSON.parse(this.store.decrypt(row.payload));if(typeof data.text!=='string'||!data.text||data.text.length>3500)fail('STORAGE');text=data.text;}catch{fail('STORAGE');}
   this._assert(g);const destination=this._destinationGen||0;
   this.db.prepare("UPDATE ns_monitor_outbox SET status='sending',attempts=attempts+1,updated=?,note=? WHERE id=? AND status='pending'").run(Date.now(),'正在发送',row.id);this.phase='正在推送';
   let result;try{result=await deadline(()=>this.sendTelegram(text),25000);}catch{result={status:'unknown'};}text='';
   if(result?.status==='sent')this.db.prepare("UPDATE ns_monitor_outbox SET status='sent',payload='',updated=?,note=? WHERE id=?").run(Date.now(),'Telegram已确认接收',row.id);
   else if(destination!==(this._destinationGen||0)&&['rejected','rate_limited'].includes(result?.status)){
    this.db.prepare("UPDATE ns_monitor_outbox SET status='skipped',payload='',updated=?,note=? WHERE id=?").run(Date.now(),'更换推送目标，旧待发送通知已跳过',row.id);this._prune();return INTERVAL;
   }else if(result?.status==='rate_limited'){
    const seconds=Number(result.retryAfter),delay=Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds*1000):INTERVAL;
    if(!Number.isSafeInteger(delay)||delay>31536000000){this.db.prepare("UPDATE ns_monitor_outbox SET status='failed',updated=?,note=? WHERE id=?").run(Date.now(),'限流参数异常，等待人工检查',row.id);this._halt('REJECTED',g);return INTERVAL;}
    this._rateUntil=Date.now()+delay;this.store.set('monitor:rate-until',this._rateUntil);
    this.db.prepare("UPDATE ns_monitor_outbox SET status='pending',updated=?,not_before=?,note=? WHERE id=?").run(Date.now(),this._rateUntil,'Telegram限流，等待重试',row.id);
    if(this.running&&g===this._gen)this.phase='等待Telegram限流恢复';return Math.max(INTERVAL,delay);
   }else if(result?.status==='rejected'){
    this.db.prepare("UPDATE ns_monitor_outbox SET status='failed',updated=?,note=? WHERE id=?").run(Date.now(),'Telegram明确拒绝，等待检查配置',row.id);this._halt('REJECTED',g);return INTERVAL;
   }else{
    this.db.prepare("UPDATE ns_monitor_outbox SET status='unknown',updated=?,note=? WHERE id=?").run(Date.now(),'发送结果未确认，未自动重发',row.id);this._halt('UNKNOWN',g);return INTERVAL;
   }this._prune();
  }return INTERVAL;
 }
 async _cycle(g){
  const c=this._config();if(!this._configured(c))fail('CONFIG');if(this._unknown())fail('UNKNOWN');
  this.phase='正在确认登录';const user=await this._identity(g);this._adopt(user,g);const account=user.id;
  if(this._rateUntil>Date.now()){this.phase='等待Telegram限流恢复';return Math.max(INTERVAL,this._rateUntil-Date.now());}
  const stages=[],budget=[];let baselined=false;
  for(const type of TYPES){if(!c.types[type])continue;this._assert(g);const cursor=this._cursor(account,type);
   if(cursor===null){this.phase=`正在建立${LABEL[type]}基线`;stages.push(await this._baseline(type,account,g));baselined=true;}
   else{this.phase=`正在检查${LABEL[type]}`;stages.push(type==='message'?await this._private(account,cursor,c,g,budget):await this._notices(type,cursor,c,g,budget));}
  }
  const verified=await this._identity(g);if(verified.id!==account){this._pendingAccount=verified;fail('ACCOUNT');}this._assert(g);
  this._commit(account,stages);this.account=verified;this.lastCheck=Date.now();this.lastError='';this._persist();
  const delay=await this._deliver(account,c,g);if(this.running&&g===this._gen&&this.phase!=='等待Telegram限流恢复')this.phase=baselined?'基线已建立，等待新通知':'正常监听';return delay;
 }
 state(){
  const c=this._config(),counts={pending:0,sent:0,unknown:0,failed:0};
  for(const row of this.db.prepare('SELECT status,COUNT(*) AS n FROM ns_monitor_outbox GROUP BY status').all()){if(row.status==='sending')counts.pending+=Number(row.n);else if(Object.hasOwn(counts,row.status))counts[row.status]+=Number(row.n);}
  const notes=new Set(['等待发送','正在发送','Telegram已确认接收','Telegram限流，等待重试','Telegram明确拒绝，等待检查配置','发送结果未确认，未自动重发','服务重启，上一发送结果未确认','用户核对后明确跳过，未重新发送','等待明确拒绝后的重试','确认切换账号，旧队列不再自动发送','更换推送目标，旧待发送通知已跳过','限流参数异常，等待人工检查']);
  const logs=this.db.prepare('SELECT id,updated,type,status,note FROM ns_monitor_outbox ORDER BY id DESC LIMIT 50').all().map(row=>({id:Number(row.id),time:Number(row.updated),type:TYPES.includes(row.type)?row.type:'message',status:['pending','sending','sent','unknown','failed','skipped'].includes(row.status)?row.status:'failed',note:notes.has(row.note)?row.note:'记录状态已更新'}));
  return{running:this.running,phase:this.phase,lastError:this.lastError,haltCode:this.haltCode,lastCheck:this.lastCheck,nextCheck:this.nextCheck,account:this.account?{...this.account}:null,types:{...c.types},includeSummary:c.includeSummary,counts,logs,canStart:!this.running&&!this._busy&&this._configured(c)&&counts.unknown===0};
 }
}
