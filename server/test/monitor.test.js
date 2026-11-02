import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {Monitor} from '../lib/monitor.js';
function fixture(t,types={message:false,at:true,reply:false}){
 const db=new DatabaseSync(':memory:'),kv=new Map(),key=randomBytes(32);
 const store={db,get:(k,f=null)=>kv.has(k)?kv.get(k):f,set:(k,v)=>kv.set(k,structuredClone(v)),encrypt(text){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');},decrypt(text){const b=Buffer.from(text,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}};
 const s={uid:1,lists:{message:[],at:[],reply:[]},pages:{},details:{},calls:[],sends:[],result:{status:'sent'},config:{token:'mock-token',chatId:'123',types,includeSummary:true},sender:null};
 const browser={identity:async()=>s.uid?{id:s.uid,name:`Mock ${s.uid}`}:null,api:async path=>{s.calls.push(path);const u=new URL(path,'https://www.nodeseek.com');if(u.pathname.includes('/with/')){const peer=u.pathname.split('/').at(-1);return{success:true,msgArray:s.details[peer]||[],talkTo:{member_name:`Peer ${peer}`}};}const kind=u.pathname.includes('/at-me/')?'at':u.pathname.includes('/reply-to-me/')?'reply':'message',page=Number(u.searchParams.get('page'));const rows=s.pages[kind]?.[page]??(page===1?s.lists[kind]:[]);return{success:true,[kind==='at'?'atList':kind==='reply'?'replyList':'msgArray']:rows};},postText:async()=>'<p>fallback content</p>'};
 const args={store,browser,getConfig:()=>s.config,sendTelegram:async text=>{s.sends.push(text);return s.sender?s.sender(text):s.result;}};
 const m=new Monitor(args);t.after(()=>{m.pause();db.close();});return{m,s,store,db,args};
}
const notice=(id,text='mock-notice')=>({id,post_id:55,floor_id:'#2',commenter_name:'Peer',post_title:'Title',content:text,created_at:'2026-11-02T01:00:00Z',viewed:1});
const message=(id,sender=2)=>({id,sender_id:sender,receiver_id:sender===1?2:1,sender_name:'Peer',receiver_name:'Owner',content:`private-mock-body-${id}`,created_at:'2026-11-02T01:00:00Z',viewed:1});
const row=(db,id)=>db.prepare('SELECT * FROM ns_monitor_outbox WHERE event_id=?').get(String(id));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let i=0;i<30;i++){if(fn())return;await tick();}assert.fail('mock operation did not reach checkpoint');}

test('first screen baseline, all three types, conversation summaries expand incoming IDs, sent dedup',async t=>{
 const {m,s,db}=fixture(t,{message:true,at:true,reply:true});s.lists={message:[message(10)],at:[notice(10)],reply:[notice(10)]};await m.start();assert.equal(s.sends.length,0);
 s.lists={message:[{...message(13,1),id:undefined,max_id:13}],at:[notice(11)],reply:[notice(11)]};s.details[2]=[message(10),message(11),message(12),message(13,1)];await m.check();assert.equal(s.sends.length,4);assert.equal(m.state().counts.sent,4);assert(s.sends.some(x=>x.includes('private-mock-body-11')));assert(s.sends.every(x=>x.length<=3500));assert.equal(row(db,11).payload,'');assert(!JSON.stringify(m.state()).includes('private-mock-body'));await m.check();assert.equal(s.sends.length,4);
});
test('encrypted pending payload and sanitized known rejection; explicit resume retries',async t=>{
 const {m,s,db,store}=fixture(t);s.lists.at=[notice(1)];await m.start();s.lists.at=[notice(2,'private-mock-body')];s.result={status:'rejected',message:'SECRET reflected-token'};await m.check();assert.equal(m.running,false);const r=row(db,2);assert.equal(r.status,'failed');assert(!r.payload.includes('private-mock-body'));assert(store.decrypt(r.payload).includes('private-mock-body'));assert(!JSON.stringify(m.state()).includes('SECRET'));s.result={status:'sent'};await m.resume();assert.equal(row(db,2).status,'sent');assert.equal(s.sends.length,2);
});
test('unknown result pauses and requires explicit skip; never automatic resend',async t=>{
 const {m,s,db}=fixture(t);s.lists.at=[notice(1)];await m.start();s.lists.at=[notice(2)];s.result={status:'unknown'};await m.check();assert.equal(row(db,2).status,'unknown');assert.equal(m.running,false);await m.check();await m.start();await m.resume();assert.equal(s.sends.length,1);assert.equal(m.running,false);s.result={status:'sent'};await m.resume({skipUnknown:true});assert.equal(m.running,true);assert.equal(row(db,2).status,'skipped');assert.equal(row(db,2).payload,'');assert.equal(s.sends.length,1);
});
test('crashed sending ledger becomes unknown and blocks startup',async t=>{
 const {m,s,db,store,args}=fixture(t);s.lists.at=[notice(1)];await m.start();m.pause();db.prepare("INSERT INTO ns_monitor_outbox(account,type,event_id,payload,status,created,updated,note) VALUES('1','at','9',?,'sending',1,1,'')").run(store.encrypt('{"text":"private-mock-body"}'));const restarted=new Monitor(args);await restarted.start();assert.equal(restarted.running,false);assert.equal(restarted.state().counts.unknown,1);assert.equal(s.sends.length,0);restarted.pause();
});
test('bound account change pauses first, separate explicit start verifies and baselines new account',async t=>{
 const {m,s,db}=fixture(t);s.lists.at=[notice(1)];await m.start();const calls=s.calls.length;s.uid=2;s.lists.at=[notice(100)];await m.check();assert.equal(m.running,false);assert.equal(m.account.id,1);assert.equal(s.calls.length,calls);assert.match(m.lastError,/账号已变化/);await m.start();assert.equal(m.account.id,2);assert.equal(m.running,true);assert.equal(s.sends.length,0);assert.equal(db.prepare("SELECT cursor FROM ns_monitor_cursors WHERE account='2' AND type='at'").get().cursor,'100');
});
test('429 is persistent and cannot be bypassed by manual check or restart',async t=>{
 const {m,s,db,store,args}=fixture(t);s.lists.at=[notice(1)];await m.start();s.lists.at=[notice(2)];s.result={status:'rate_limited',retryAfter:300};await m.check();assert.equal(row(db,2).status,'pending');const calls=s.calls.length;await m.check();assert.equal(s.sends.length,1);assert.equal(s.calls.length,calls);m.pause();const restarted=new Monitor(args);await restarted.start();assert.equal(s.sends.length,1);assert.equal(s.calls.length,calls);restarted.pause();m._rateUntil=Date.now()-1;store.set('monitor:rate-until',m._rateUntil);db.prepare('UPDATE ns_monitor_outbox SET not_before=0').run();s.result={status:'sent'};await m.start();assert.equal(s.sends.length,2);assert.equal(row(db,2).status,'sent');
});
for(const outcome of ['sent','unknown','rejected','rate_limited'])test(`pause during TG ${outcome} keeps paused state and records outcome`,async t=>{
 const {m,s,db}=fixture(t);s.lists.at=[notice(1)];await m.start();s.lists.at=[notice(2)];let resolve;s.sender=()=>new Promise(r=>{resolve=r;});const checking=m.check();await until(()=>!!resolve);m.pause();resolve({status:outcome,retryAfter:300});await checking;assert.equal(m.running,false);assert.equal(m.phase,'已暂停');assert.equal(m.nextCheck,null);assert.equal(row(db,2).status,{sent:'sent',unknown:'unknown',rejected:'failed',rate_limited:'pending'}[outcome]);
});
test('concurrent checks share one fetch/send cycle',async t=>{
 const {m,s}=fixture(t);s.lists.at=[notice(1)];await m.start();s.lists.at=[notice(2)];await Promise.all([m.check(),m.check(),m.check()]);assert.equal(s.sends.length,1);
});
test('unordered page with an old record before newer records pauses without advancing',async t=>{
 const {m,s,db}=fixture(t);s.lists.at=[notice(1)];await m.start();s.calls=[];s.pages.at={1:[notice(1),notice(3)],2:[notice(2)],3:[]};await m.check();assert.equal(m.running,false);assert.match(m.lastError,/分页/);assert.equal(s.sends.length,0);assert.equal(db.prepare("SELECT cursor FROM ns_monitor_cursors WHERE type='at'").get().cursor,'1');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ns_monitor_outbox').get().n,0);assert.deepEqual(s.calls,['/api/notification/at-me/list?page=1']);
});
test('100 new records abort without cursor advance or outbox insert',async t=>{
 const {m,s,db}=fixture(t);s.lists.at=[notice(1)];await m.start();s.lists.at=Array.from({length:100},(_,i)=>notice(101-i));await m.check();assert.equal(m.running,false);assert.match(m.lastError,/上限/);assert.equal(db.prepare("SELECT cursor FROM ns_monitor_cursors WHERE type='at'").get().cursor,'1');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ns_monitor_outbox').get().n,0);
});
test('10 pages without boundary and repeated pagination both abort atomically',async t=>{
 const {m,s,db}=fixture(t);s.lists.at=[notice(1)];await m.start();s.pages.at=Object.fromEntries(Array.from({length:10},(_,i)=>[i+1,[notice(i+2)]]));await m.check();assert.equal(m.running,false);assert.equal(db.prepare("SELECT cursor FROM ns_monitor_cursors WHERE type='at'").get().cursor,'1');s.pages.at={1:[notice(2)],2:[notice(2)]};await m.start();assert.match(m.lastError,/分页/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ns_monitor_outbox').get().n,0);
});
test('truncated known private conversation pauses without moving message cursor',async t=>{
 const {m,s,db}=fixture(t,{message:true,at:false,reply:false});s.lists.message=[message(10)];await m.start();s.lists.message=[message(12)];s.details[2]=[message(11),message(12)];await m.check();assert.equal(m.running,false);assert.match(m.lastError,/缺口/);assert.equal(db.prepare("SELECT cursor FROM ns_monitor_cursors WHERE type='message'").get().cursor,'10');assert.equal(s.sends.length,0);
});
test('destination change pauses, scrubs pending/failed, retains unknown',async t=>{
 const {m,db,store}=fixture(t);const insert=db.prepare("INSERT INTO ns_monitor_outbox(account,type,event_id,payload,status,created,updated,note) VALUES('1','at',?,?,?,1,1,'')");for(const [i,status]of ['pending','failed','unknown'].entries())insert.run(String(i+1),store.encrypt('{"text":"private-mock-body"}'),status);m.configureChanged({destinationChanged:true});assert.equal(m.running,false);assert.equal(row(db,1).status,'skipped');assert.equal(row(db,2).payload,'');assert.equal(row(db,3).status,'unknown');assert(row(db,3).payload);assert.equal(row(db,1).note,'更换推送目标，旧待发送通知已跳过');
});
test('target change while in-flight known rejection cannot requeue to new target',async t=>{
 const {m,s,db}=fixture(t);s.lists.at=[notice(1)];await m.start();s.lists.at=[notice(2)];let resolve;s.sender=()=>new Promise(r=>{resolve=r;});const checking=m.check();await until(()=>!!resolve);m.configureChanged({destinationChanged:true});s.config.chatId='different';resolve({status:'rejected'});await checking;assert.equal(row(db,2).status,'skipped');assert.equal(row(db,2).payload,'');assert.equal(m.phase,'已暂停');
});
test('terminal ledger bounded to 2000, unresolved rows retained',async t=>{
 const {m,db,store}=fixture(t);const insert=db.prepare("INSERT INTO ns_monitor_outbox(account,type,event_id,payload,status,created,updated,note) VALUES('1','at',?,?,?,1,1,'')");db.exec('BEGIN');for(let i=1;i<=2005;i++)insert.run(String(i),'','sent');insert.run('3000',store.encrypt('{"text":"private-mock-body"}'),'unknown');db.exec('COMMIT');m._prune();assert.equal(m.state().counts.sent,2000);assert.equal(m.state().counts.unknown,1);assert.equal(m.state().logs.length,50);assert(!JSON.stringify(m.state()).includes('private-mock-body'));
});
test('HTML summary never executes and remains bounded; missing summary falls back',async t=>{
 const {m,s}=fixture(t);s.lists.at=[notice(1)];await m.start();s.lists.at=[notice(3,''),notice(2,'<script>BAD()</script><b>A &amp; B</b>'+ 'x'.repeat(10000))];await m.check();assert.equal(s.sends.length,2);assert(s.sends.every(x=>x.length<=3500&&!x.includes('BAD()')));assert(s.sends[0].includes('A & B'));assert(s.sends[1].includes('fallback content'));
});
test('pause during separate account confirmation cancels startup',async t=>{
 const {m,s,args}=fixture(t);s.lists.at=[notice(1)];await m.start();s.uid=2;await m.check();assert.equal(m.running,false);let resolve;args.browser.identity=()=>new Promise(r=>{resolve=r;});const starting=m.start();await until(()=>!!resolve);m.pause();resolve({id:2,name:'Mock 2'});await starting;assert.equal(m.running,false);assert.equal(m.phase,'已暂停');assert.equal(m.account.id,1);assert.equal(m.nextCheck,null);
});
test('identity changes again during confirmation requires yet another explicit start',async t=>{
 const {m,s}=fixture(t);s.lists.at=[notice(1)];await m.start();s.uid=2;await m.check();s.uid=3;await m.start();assert.equal(m.running,false);assert.equal(m.account.id,1);await m.start();assert.equal(m.running,true);assert.equal(m.account.id,3);assert.equal(s.sends.length,0);
});

for(const type of ['message','at','reply'])test(`${type}: unchanged newest-first 50-row first page finishes without requesting repeated page 2`,async t=>{
 const types={message:false,at:false,reply:false};types[type]=true;
 const {m,s,db}=fixture(t,types);
 const rows=Array.from({length:50},(_,i)=>type==='message'?message(50-i,100+i):notice(50-i));
 s.lists[type]=rows;await m.start();s.calls=[];
 s.pages[type]={1:rows,2:rows};await m.check();
 const endpoint={message:'message',at:'at-me',reply:'reply-to-me'}[type];
 assert.equal(m.running,true);assert.equal(m.lastError,'');assert.equal(s.sends.length,0);
 assert.deepEqual(s.calls,[`/api/notification/${endpoint}/list?page=1`]);
 assert.equal(db.prepare('SELECT cursor FROM ns_monitor_cursors WHERE type=?').get(type).cursor,'50');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ns_monitor_outbox').get().n,0);
});

test('all three types collect every new row before the old boundary on a mixed first page',async t=>{
 const {m,s,db}=fixture(t,{message:true,at:true,reply:true});
 s.lists={message:[message(10)],at:[notice(10)],reply:[notice(10)]};await m.start();s.calls=[];
 const lists={message:[message(12),message(9,3)],at:[notice(12),notice(11),notice(10)],reply:[notice(12),notice(11),notice(10)]};
 for(const type of ['message','at','reply'])s.pages[type]={1:lists[type],2:lists[type]};
 s.details[2]=[message(10),message(11),message(12)];await m.check();
 assert.equal(m.running,true);assert.equal(s.sends.length,6);
 for(const type of ['message','at','reply']){
  assert(s.sends.some(text=>text.includes(`事件：${type}-11`)));
  assert(s.sends.some(text=>text.includes(`事件：${type}-12`)));
  assert.equal(db.prepare('SELECT cursor FROM ns_monitor_cursors WHERE type=?').get(type).cursor,'12');
 }
 assert(s.calls.every(path=>!path.includes('page=2')));
 await m.check();assert.equal(s.sends.length,6);assert.equal(m.running,true);
});

test('a repeated 50-row all-new window still pauses atomically without advancing any cursor',async t=>{
 const {m,s,db}=fixture(t,{message:true,at:true,reply:true});
 s.lists={message:[message(10)],at:[notice(10)],reply:[notice(10)]};await m.start();s.calls=[];
 const rows=Array.from({length:50},(_,i)=>notice(60-i));s.pages.at={1:rows,2:rows};
 await m.check();assert.equal(m.running,false);assert.match(m.lastError,/分页/);
 assert.equal(s.sends.length,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ns_monitor_outbox').get().n,0);
 for(const type of ['message','at','reply'])assert.equal(db.prepare('SELECT cursor FROM ns_monitor_cursors WHERE type=?').get(type).cursor,'10');
 assert(s.calls.includes('/api/notification/at-me/list?page=2'));
 assert(!s.calls.includes('/api/notification/at-me/list?page=3'));
});

test('private summaries use max_id while expanded conversation messages use their own id',async t=>{
 const {m,s,db}=fixture(t,{message:true,at:false,reply:false});
 s.lists.message=[{...message(2),max_id:10}];await m.start();
 assert.equal(db.prepare("SELECT cursor FROM ns_monitor_cursors WHERE type='message'").get().cursor,'10');
 s.lists.message=[{...message(2),max_id:12},{...message(3,3),max_id:9}];
 s.details[2]=[10,11,12].map(id=>({...message(id),max_id:999}));
 await m.check();assert.equal(m.running,true);assert.equal(s.sends.length,2);
 assert(s.sends.some(text=>text.includes('事件：message-11')));
 assert(s.sends.some(text=>text.includes('事件：message-12')));
 assert(s.sends.every(text=>!text.includes('事件：message-999')));
 assert.equal(db.prepare("SELECT cursor FROM ns_monitor_cursors WHERE type='message'").get().cursor,'12');
 const peer=db.prepare("SELECT latest,incoming FROM ns_monitor_peers WHERE peer='2'").get();
 assert.equal(peer.latest,'12');assert.equal(peer.incoming,'12');
});
