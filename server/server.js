import { loadConfig } from './lib/config.js';
import { RecoveryController } from './lib/recovery.js';
import { BrowserBridge } from './lib/browser-bridge.js';
import { randomBytes } from 'node:crypto';
import { desktopAsset, attachDesktop } from './lib/desktop.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { Auth, COOKIE } from './lib/auth.js';
import { ForumBrowser } from './lib/browser.js';
import { Monitor } from './lib/monitor.js';
import { validToken, validChat, sendTelegram } from './lib/telegram.js';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
export function createApplication({store,browser,monitor,origin,auth,manualDesktop=false,bridgeEnabled=false,recovery=null}){
 const defaultConfig={token:'',chatId:'',types:{message:true,at:true,reply:true},includeSummary:true};
 const getConfig=()=>{try{const encrypted=store.get('telegram:encrypted');return encrypted?{...defaultConfig,...JSON.parse(store.decrypt(encrypted))}:defaultConfig;}catch{return defaultConfig;}};
 const control=recovery||monitor;
 let testing=false,interacting=false;
 const headers={
  'Cache-Control':'no-store, max-age=0','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy':'same-origin',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
 };
 const json=(res,status,data,extra={})=>{res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(data));};
 const snapshot=()=>{const state=monitor.state(),config=getConfig();return {...state,version:'1.1.0',browser:browser.state(),account:bridgeEnabled?browser.account:(browser.account||state.account),telegram:{configured:validToken(config.token)&&validChat(config.chatId),chatId:config.chatId},manualDesktop,bridgeEnabled,monitorDesired:recovery?recovery.state().desired:monitor.running,recovery:recovery?recovery.state():null,canStart:(!manualDesktop||bridgeEnabled)&&!!browser.account&&state.canStart};};
 const error=(status,message)=>Object.assign(new Error(message),{status,public:true});
 async function body(req){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw error(415,'请使用 JSON 请求');
  let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16384)throw error(413,'请求过大');}
  try{const value=JSON.parse(text||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw 0;return value;}catch{throw error(400,'请求格式无效');}
 }
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(req.headers.host!==new URL(origin).host&&!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host||''))throw error(400,'请求主机无效');
   if(bridgeEnabled&&url.pathname.startsWith('/api/bridge/')){if(await browser.handleHttp(req,res))return;throw error(404,'接口不存在');}
   const remoteFile=manualDesktop?desktopAsset(url.pathname,ROOT):null;
   if(remoteFile){
    if(!['GET','HEAD'].includes(req.method))throw error(405,'不支持的请求方式');
    if(!auth.find(req)){if(url.pathname==='/desktop'){res.writeHead(302,{...headers,Location:'/'});return res.end();}throw error(401,'请先登录管理后台');}
    const data=fs.readFileSync(remoteFile);
    res.writeHead(200,{...headers,'Content-Security-Policy':url.pathname==='/desktop'?headers['Content-Security-Policy'].replace("style-src 'self'","style-src 'self' 'unsafe-inline'").replace("img-src 'self' blob:","img-src 'self' blob: data:"):headers['Content-Security-Policy'],'Content-Type':remoteFile.endsWith('.js')?'text/javascript; charset=utf-8':remoteFile.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});
    return res.end(req.method==='HEAD'?undefined:data);
   }
   if(!url.pathname.startsWith('/api/')){
    const files={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js'};
    const file=files[url.pathname];if(!file||!['GET','HEAD'].includes(req.method))throw error(404,'页面不存在');
    const data=fs.readFileSync(path.join(ROOT,'public',file));res.writeHead(200,{...headers,'Content-Type':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});return res.end(req.method==='HEAD'?undefined:data);
   }
   if(!['GET','POST'].includes(req.method))throw error(405,'不支持的请求方式');
   if(req.headers['sec-fetch-site']==='cross-site')throw error(403,'禁止跨站请求');
   if(req.method==='POST'&&req.headers.origin!==origin)throw error(403,'请求来源不匹配');
   const session=auth.find(req);
   if(url.pathname==='/api/session'&&req.method==='GET')return json(res,200,session?{authenticated:true,csrf:session.csrf}:{authenticated:false});
   if(url.pathname==='/api/login'&&req.method==='POST'){
    const data=await body(req),result=auth.authenticate(data.password);data.password='';
    if(result?.limited)throw error(429,'尝试过于频繁，请五分钟后重试');
    if(!result)throw error(401,'管理密码不正确');
    return json(res,200,{authenticated:true,csrf:result.csrf},{'Set-Cookie':COOKIE+'='+result.token+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200'});
   }
   if(!session)throw error(401,'请先登录管理后台');
   if(req.method==='POST'&&req.headers['x-csrf-token']!==session.csrf)throw error(403,'页面验证已失效，请刷新重试');
   if(req.method==='GET'){
    if(url.pathname==='/api/state')return json(res,200,snapshot());
    if(bridgeEnabled&&url.pathname==='/api/browser/diagnostics')return json(res,200,browser.state());
    if(manualDesktop&&url.pathname==='/api/browser/frame')throw error(409,'请使用普通 Chrome 远程桌面');
    if(url.pathname==='/api/browser/diagnostics')return json(res,200,await browser.diagnostics());
    if(url.pathname==='/api/browser/frame'){
     if(interacting)throw error(409,'浏览器正在操作，请稍后刷新画面');
     const frame=await browser.screenshot();res.writeHead(200,{...headers,'Content-Type':'image/jpeg'});return res.end(frame);
    }
    throw error(404,'接口不存在');
   }
   const data=await body(req);
   if(url.pathname==='/api/logout'){auth.remove(session);desktop?.revoke(session.key);return json(res,200,{ok:true},{'Set-Cookie':COOKIE+'=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});}
   if(url.pathname==='/api/config'){
    const old=getConfig();const token=typeof data.token==='string'&&data.token.trim()?data.token.trim():old.token;
    const chatId=String(data.chatId??old.chatId).trim();
    if(!validToken(token)||!validChat(chatId))throw error(400,'请填写有效的 Bot Token 和正整数私人 Chat ID');
    const types=Object.fromEntries(['message','at','reply'].map(type=>[type,data.types?.[type]===true]));
    if(!Object.values(types).some(Boolean))throw error(400,'请至少选择一类通知');
    control.configureChanged({destinationChanged:old.chatId!==chatId||old.token!==token});store.set('autoStart',false);
    store.set('telegram:encrypted',store.encrypt(JSON.stringify({token,chatId,types,includeSummary:data.includeSummary!==false})));data.token='';
    return json(res,200,{ok:true,message:'配置已保存；请点击开始监控',...snapshot()});
   }
   if(url.pathname==='/api/telegram/test'){
    if(testing)throw error(409,'测试正在发送，请勿重复点击');
    if(monitor.running||recovery?.state().desired)throw error(409,'请先暂停监控再发送测试');
    testing=true;let result;try{result=await sendTelegram(getConfig(),'NodeSeek 通知台：Telegram 推送测试。收到此消息说明连接成功。');}finally{testing=false;}
    return json(res,200,{...result,message:result.status==='sent'?'测试消息已发送，请查看 Telegram':result.message});
   }
   if(url.pathname==='/api/diagnostics/sources'){
    if(monitor.running||interacting||recovery?.state().desired)throw error(409,'请先暂停监控');
    interacting=true;
    try{
     const user=await browser.identity();if(!user)throw error(409,'请先登录论坛');
     const paths={message:'/api/notification/message/list',at:'/api/notification/at-me/list',reply:'/api/notification/reply-to-me/list'},sources=[];
     for(const[type,route]of Object.entries(paths)){
      const pages=[];for(const page of [1,2]){const result=await browser.api(route+'?page='+page);pages.push(type==='message'?result.msgArray:result[type==='at'?'atList':'replyList']);}
      if(pages.some(rows=>!Array.isArray(rows)))throw error(503,'通知结构待适配');
      const cursor=Number(store.db.prepare('SELECT cursor FROM ns_monitor_cursors WHERE account=? AND type=?').get(String(user.id),type)?.cursor||0);
      const ids=rows=>rows.map(row=>Number(type==='message'?(row.max_id??row.id):row.id));
      const describe=rows=>{const values=ids(rows);return {count:rows.length,latestIdDescending:values.every((v,i)=>!i||values[i-1]>=v),allOld:values.every(v=>v<=cursor),hasOld:values.some(v=>v<=cursor),newCount:values.filter(v=>v>cursor).length,rowsHaveIdAndMaxId:rows.some(r=>r.id!==undefined&&r.max_id!==undefined),anyIdDiffersMaxId:rows.some(r=>r.id!==undefined&&r.max_id!==undefined&&Number(r.id)!==Number(r.max_id))};};
      sources.push({type,page1:describe(pages[0]),page2:describe(pages[1]),sameIds:JSON.stringify(ids(pages[0]))===JSON.stringify(ids(pages[1]))});
     }
     return json(res,200,{identityConfirmed:true,sources});
    }finally{interacting=false;}
   }
   if(manualDesktop&&((!bridgeEnabled&&['/api/monitor/start','/api/monitor/check','/api/monitor/resume'].includes(url.pathname))||url.pathname.startsWith('/api/browser/')))throw error(409,'请使用普通 Chrome 远程桌面；通知监控尚未连接此浏览器');
   if(url.pathname==='/api/monitor/start'){
    if(interacting)throw error(409,'请先完成浏览器操作');
    await browser.open();await control.start();store.set('autoStart',recovery?recovery.state().desired:monitor.running);return json(res,200,snapshot());
   }
   if(url.pathname==='/api/monitor/pause'){control.pause();store.set('autoStart',false);return json(res,200,snapshot());}
   if(url.pathname==='/api/monitor/check'){await monitor.check();return json(res,200,snapshot());}
   if(url.pathname==='/api/monitor/resume'){
    if(data.skipUnknown!==true)throw error(400,'请先核对 Telegram，再确认跳过未知结果');
    await control.resume({skipUnknown:true});store.set('autoStart',recovery?recovery.state().desired:monitor.running);return json(res,200,snapshot());
   }
   if(['/api/browser/open','/api/browser/login','/api/browser/input','/api/browser/check'].includes(url.pathname)){
    if(interacting)throw error(409,'浏览器正在处理，请稍候');
    interacting=true;control.pause();store.set('autoStart',false);
    try{
     let result={ok:true};
     if(url.pathname==='/api/browser/open')result=await browser.open();
     else if(url.pathname==='/api/browser/login'){try{result=await browser.login(data.username,data.password);}finally{data.password='';}}
     else if(url.pathname==='/api/browser/input'){await browser.input(data);data.text='';}
     else result={account:await browser.identity()};
     return json(res,200,result);
    }finally{interacting=false;}
   }
   throw error(404,'接口不存在');
  }catch(e){if(!res.headersSent)json(res,e.public?e.status:503,{error:e.public?e.message:'操作未完成，请检查服务器浏览器的登录或验证状态后重试'});else res.end();}
 });
 const desktop=manualDesktop?attachDesktop(server,{auth,origin}):null;
 server.requestTimeout=30000;server.headersTimeout=10000;
 return {server,getConfig,snapshot,closeDesktop:()=>desktop?.close()};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {dataDir,origin,port}=loadConfig();
 const store=new Store(dataDir),auth=new Auth(JSON.parse(fs.readFileSync(path.join(dataDir,'admin.json'),'utf8')));
 const bridgeEnabled=process.env.BROWSER_BRIDGE==='1',secretPath=path.join(dataDir,'browser-bridge.key');
 if(bridgeEnabled&&!fs.existsSync(secretPath))fs.writeFileSync(secretPath,randomBytes(32),{mode:0o600,flag:'wx'});
 const browser=bridgeEnabled?new BrowserBridge({secret:fs.readFileSync(secretPath)}):new ForumBrowser(dataDir);
 const getConfig=()=>{const encrypted=store.get('telegram:encrypted');return encrypted?JSON.parse(store.decrypt(encrypted)):{token:'',chatId:'',types:{message:true,at:true,reply:true},includeSummary:true};};
 const monitor=new Monitor({store,browser,getConfig,sendTelegram:text=>sendTelegram(getConfig(),text)});
 const recovery=bridgeEnabled?new RecoveryController({monitor,browser,store}):null;
 const {server,closeDesktop}=createApplication({store,browser,monitor,origin,auth,manualDesktop:process.env.MANUAL_DESKTOP==='1',bridgeEnabled,recovery});
 server.listen(port,'127.0.0.1',()=>console.info('NodeSeek console started on loopback'));
 if(!bridgeEnabled&&process.env.MANUAL_DESKTOP!=='1'&&store.get('autoStart',false))setTimeout(()=>browser.open().then(()=>monitor.start()).catch(()=>{}),1000);
 const stop=async()=>{if(recovery)recovery.close();else monitor.pause();closeDesktop();server.close();await Promise.resolve(browser.close()).catch(()=>{});store.close();process.exit(0);};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}

