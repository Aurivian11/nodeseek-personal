import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const appSource=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const appHTML=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const desktopSource=fs.readFileSync(new URL('../public/desktop.js',import.meta.url),'utf8');
const desktopHTML=fs.readFileSync(new URL('../public/desktop.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
class Element {
 constructor(id=''){
  Object.assign(this,{id,dataset:{},disabled:false,hidden:false,open:false,value:'',checked:false,textContent:'',className:'',children:[],handlers:{},lastChild:{textContent:''}});
  const classes=new Set();this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)};
 }
 addEventListener(type,fn){(this.handlers[type]||=[]).push(fn);}
 setAttribute(){} removeAttribute(){}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 close(){this.open=false;} showModal(){this.open=true;} focus(){}
}
function surface(html){
 const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element(match[1])]));
 const body=new Element('body'),notice=new Element('notice'),windowEvents={},documentEvents={};
 for(const node of nodes.values())node.parentElement=body;
 const document={body,hidden:false,getElementById(id){assert(nodes.has(id),'unknown element '+id);return nodes.get(id);},querySelector(){return notice;},querySelectorAll(){return [];},createElement(){return new Element();},createDocumentFragment(){return new Element();},addEventListener(type,fn){(documentEvents[type]||=[]).push(fn);}};
 let timerId=0,now=Date.parse('2026-01-01T00:00:00Z');const timers=new Map();
 const timing={setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms,interval:false});return id;},clearTimeout(id){timers.delete(id);},setInterval(fn,ms){const id=++timerId;timers.set(id,{fn,ms,interval:true});return id;},clearInterval(id){timers.delete(id);}};
 const window={addEventListener(type,fn){(windowEvents[type]||=[]).push(fn);},confirm(){return true;}};
 const environment={document,window,AbortController,TypeError,URL:{revokeObjectURL(){},createObjectURL(){return 'blob:synthetic';}},Date:class extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}},...timing};
 return {nodes,document,window,windowEvents,environment,timers,get now(){return now;},advance(ms){now+=ms;},async tick(ms){for(const timer of [...timers.values()])if(timer.interval&&timer.ms===ms)await timer.fn();await settle();},async emitWindow(type,event={}){for(const fn of windowEvents[type]||[])await fn(event);await settle();}};
}
const baseState=()=>({manualDesktop:true,bridgeEnabled:true,running:false,monitorDesired:false,phase:'已暂停',canStart:true,browser:{connected:true,running:true,phase:'logged_in'},account:{id:101,name:'测试账号'},telegram:{configured:true,chatId:'101'},counts:{unknown:0},logs:[],recovery:{state:'disabled',desired:false,reason:''}});
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
async function appFixture(overrides={}){
 const f=surface(appHTML);f.calls=[];f.snapshot={...baseState(),...overrides};f.failState=false;f.customResponse=null;f.navigations=[];
 f.nodes.get('openBrowserButton').textContent='打开远程登录';f.nodes.get('logFilter').value='all';
 f.environment.location={assign:url=>f.navigations.push(url)};
 f.environment.fetch=async(path,options={})=>{
  f.calls.push({path,options});
  if(f.customResponse){const result=f.customResponse(path,options);if(result!==undefined)return result;}
  if(path==='/api/session')return response({authenticated:true,csrf:'synthetic-csrf'});
  if(path==='/api/state'){if(f.failState)throw new TypeError('synthetic outage');return response(f.snapshot);}
  return response({});
 };
 const anchor='  void initialize();\n})();';assert(appSource.includes(anchor));
 const instrumented=appSource.replace(anchor,'  globalThis.ui={api,refreshState,renderNextCheck,showApp,showLogin};\n'+anchor);
 const context=vm.createContext(f.environment);vm.runInContext(instrumented,context);f.ui=context.ui;
 f.el=id=>f.nodes.get(id);
 f.posts=()=>f.calls.filter(call=>call.options.method==='POST');
 f.click=async id=>{assert.equal(f.el(id).disabled,false,id+' is disabled');for(const fn of f.el(id).handlers.click||[])await fn({preventDefault(){}});await settle();};
 f.update=async values=>{f.snapshot={...f.snapshot,...values};await f.ui.refreshState();await settle();};
 await settle();return f;
}

test('waiting recovery preserves pause intent and countdown performs no monitor request',async()=>{
 const f=await appFixture({monitorDesired:true,recovery:{state:'retrying',desired:true,reason:'网络暂时不可用',nextRetryAt:Date.parse('2026-01-01T00:00:05Z')}});
 assert.match(f.el('monitorTitle').textContent,/自动重试/);assert.match(f.el('monitorDescription').textContent,/网络暂时不可用/);
 assert.equal(f.el('startButton').hidden,true);assert.equal(f.el('pauseButton').hidden,false);assert.equal(f.el('pauseButton').disabled,false);assert.equal(f.el('checkButton').disabled,true);
 assert.equal(f.el('nextCheck').textContent,'5 秒后重试');f.advance(2000);await f.tick(1000);assert.equal(f.el('nextCheck').textContent,'3 秒后重试');
 await f.tick(10000);assert.equal(f.posts().length,0);
 await f.update({recovery:{state:'waiting_connection',desired:true,reason:'浏览器离线'},browser:{connected:false,phase:'disconnected'},canStart:false});
 assert.match(f.el('monitorTitle').textContent,/等待浏览器/);assert.equal(f.el('pauseButton').disabled,false);
 f.snapshot={...f.snapshot,monitorDesired:false,recovery:{state:'disabled',desired:false,reason:''}};
 await f.click('pauseButton');assert.equal(f.posts().length,1);assert.equal(f.posts()[0].path,'/api/monitor/pause');assert.equal(f.el('pauseButton').hidden,true);
});
test('blocked recovery remains explicit and unknown results require the existing confirmation',async()=>{
 const f=await appFixture({recovery:{state:'blocked',desired:false,reason:'账号发生变化'}});
 assert.match(f.el('monitorTitle').textContent,/需要处理/);assert.match(f.el('monitorDescription').textContent,/账号发生变化/);
 assert.equal(f.el('startButton').textContent,'重新开始监控');assert.equal(f.el('startButton').disabled,false);assert.equal(f.el('checkButton').disabled,true);
 await f.update({canStart:false});assert.equal(f.el('startButton').disabled,true);
 await f.update({canStart:true,counts:{unknown:1},recovery:{state:'blocked',desired:false,reason:'发送结果未确认'}});
 assert.equal(f.el('startButton').disabled,true);assert.equal(f.el('resumeButton').hidden,false);assert.equal(f.el('resumeButton').disabled,false);
 f.window.confirm=()=>false;await f.click('resumeButton');assert.equal(f.posts().length,0);
 f.window.confirm=()=>true;await f.click('resumeButton');assert.equal(f.posts().length,1);
 assert.equal(f.posts()[0].path,'/api/monitor/resume');assert.equal(JSON.parse(f.posts()[0].options.body).skipUnknown,true);
 assert.equal(f.posts()[0].options.headers['X-CSRF-Token'],'synthetic-csrf');
});

test('control-plane outage freezes unsafe actions but preserves pause and recovers with only GET',async()=>{
 const f=await appFixture({running:true,monitorDesired:true,recovery:{state:'running',desired:true,reason:''}});
 assert.equal(f.el('checkButton').disabled,false);f.failState=true;await f.ui.refreshState();
 assert.match(f.el('monitorTitle').textContent,/无法连接服务器/);
 for(const id of ['startButton','checkButton','resumeButton'])assert.equal(f.el(id).disabled,true,id);
 assert.equal(f.el('pauseButton').disabled,false);
 for(const action of ['start','check','resume'])await assert.rejects(f.ui.api('/api/monitor/'+action,{method:'POST'}),/状态尚未确认/);
 assert.equal(f.posts().length,0);await f.click('pauseButton');assert.equal(f.posts()[0].path,'/api/monitor/pause');
 f.failState=false;await f.tick(10000);assert.equal(f.posts().length,1);assert.equal(f.el('checkButton').disabled,false);
 assert.match(f.el('monitorTitle').textContent,/守候/);
});

test('401 clears credentials while late 401 cannot invalidate a newer login',async()=>{
 const f=await appFixture();let finish;
 f.customResponse=path=>path==='/api/old-request'?new Promise(resolve=>{finish=resolve;}):undefined;
 const oldRequest=f.ui.api('/api/old-request');await settle();await f.ui.showApp('new-synthetic-csrf');
 finish(response({},401));await assert.rejects(oldRequest,/登录已过期/);
 assert.equal(f.el('appView').hidden,false);assert.equal(f.el('loginView').hidden,true);
 for(const id of ['adminPassword','botToken','forumPassword','remoteText'])f.el(id).value='synthetic-secret';
 f.customResponse=path=>path==='/api/expired'?response({},401):undefined;
 await assert.rejects(f.ui.api('/api/expired'),/登录已过期/);
 for(const id of ['adminPassword','botToken','forumPassword','remoteText'])assert.equal(f.el(id).value,'');
 assert.equal(f.el('appView').hidden,true);assert.equal(f.el('loginView').hidden,false);
 assert.equal([...f.timers.values()].filter(timer=>timer.interval).length,0);assert.equal(f.posts().length,0);
});
test('bridge login waits, manual fallback and page lifecycle never auto-start monitoring',async()=>{
 const f=await appFixture({monitorDesired:true,canStart:false,browser:{connected:true,phase:'verification_required'},recovery:{state:'waiting_login',desired:true,reason:'请完成登录或验证'}});
 assert.match(f.el('monitorTitle').textContent,/等待登录/);assert.equal(f.el('pauseButton').disabled,false);assert.equal(f.el('accountName').textContent,'需要安全验证');
 await f.update({manualDesktop:true,bridgeEnabled:false,monitorDesired:false});
 for(const action of ['start','check','resume'])await assert.rejects(f.ui.api('/api/monitor/'+action,{method:'POST'}),/尚未连接/);
 await f.update({monitorDesired:true});assert.equal(f.el('pauseButton').hidden,false);assert.equal(f.el('pauseButton').disabled,false);
 await f.update({...baseState()});
 for(const action of ['open','login','input','check'])await assert.rejects(f.ui.api('/api/browser/'+action,{method:'POST'}),/远程桌面/);
 for(const id of ['adminPassword','botToken','forumPassword','remoteText'])f.el(id).value='synthetic-secret';
 await f.emitWindow('pagehide');for(const id of ['adminPassword','botToken','forumPassword','remoteText'])assert.equal(f.el(id).value,'');
 await f.emitWindow('pageshow',{persisted:true});await f.tick(10000);assert.equal(f.posts().length,0);
 await f.click('openBrowserButton');assert.deepEqual(f.navigations,['/desktop']);assert.equal(f.posts().length,0);
});

test('manual desktop connection restores session checks after initial session request fails',async()=>{
 const f=surface(desktopHTML),calls=[],clients=[];let offline=true;
 f.window.location={host:'console.example.test',replace(){assert.fail('authenticated mock must not redirect');}};
 class RFB {
  constructor(target,url){this.target=target;this.url=url;this.handlers={};this.closed=false;clients.push(this);}
  addEventListener(name,fn){this.handlers[name]=fn;}
  disconnect(){this.closed=true;}
 }
 f.environment.RFB=RFB;
 f.environment.fetch=async(path,options)=>{calls.push({path,options});if(offline)throw new TypeError('synthetic outage');return response({authenticated:true});};
 const source=desktopSource.replace("import RFB from '/desktop-assets/core/rfb.js';",'');
 vm.runInContext(source,vm.createContext(f.environment));await settle();
 assert.equal(clients.length,0);assert.equal([...f.timers.values()].filter(timer=>timer.interval).length,0);
 assert.equal(f.nodes.get('connectButton').disabled,false);offline=false;
 for(const fn of f.nodes.get('connectButton').handlers.click)fn();await settle();
 assert.equal(clients.length,1);assert.equal(clients[0].url,'wss://console.example.test/api/desktop/socket');
 assert.equal([...f.timers.values()].filter(timer=>timer.interval&&timer.ms===30000).length,1);
 clients[0].handlers.connect();await f.tick(30000);assert.equal(calls.length,3);
 assert(calls.every(call=>call.path==='/api/session'&&call.options.method==='GET'));
 for(const fn of f.nodes.get('disconnectButton').handlers.click)fn();await settle();
 assert.equal(clients[0].closed,true);await f.tick(30000);assert.equal(clients.length,1,'session polling cannot reconnect RFB');
 await f.emitWindow('pagehide');assert.equal([...f.timers.values()].filter(timer=>timer.interval).length,0);
});
