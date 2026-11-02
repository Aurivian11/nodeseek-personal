import { chromium } from 'playwright-core';
import path from 'node:path';
export const ORIGIN='https://www.nodeseek.com';
const allowedHosts=new Set(['www.nodeseek.com','nodeseek.com','challenges.cloudflare.com','hagen.challenges.cloudflare.com']);
export function allowedBrowserURL(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&allowedHosts.has(u.hostname);}catch{return false;}}
export function allowedAPI(value){return /^\/api\/notification\/(?:message\/(?:list|with\/[1-9]\d*)|at-me\/list|reply-to-me\/list)(?:\?page=[1-9]\d*)?$/.test(value);}
export class ForumBrowser {
 constructor(dir){this.dir=dir;this.context=null;this.page=null;this.launching=null;this.phase='stopped';this.account=null;this.netLog=[];this.jsErrors=0;}
 record(kind,url,detail){let host='invalid';try{host=new URL(url).hostname;}catch{}this.netLog.push({time:Date.now(),kind,host,detail});if(this.netLog.length>80)this.netLog.shift();}
 async diagnostics(){let pageState={};if(this.page&&!this.page.isClosed())pageState=await this.page.evaluate(()=>({challenge:!!document.querySelector('#challenge-form,#cf-challenge-running,.cf-turnstile')||/Just a moment|安全验证|验证您是真人/.test(document.title+' '+document.body?.innerText?.slice(0,700)),passwordField:!!document.querySelector('input[type=password]'),cookiesEnabled:navigator.cookieEnabled,readyState:document.readyState})).catch(()=>({unavailable:true}));if(pageState.challenge){this.phase='verification_required';this.account=null;}else if(!pageState.unavailable&&this.phase==='verification_required')this.phase='ready';return {phase:this.phase,page:pageState,jsErrors:this.jsErrors,events:this.netLog};}
 state(){return {running:!!this.context,phase:this.phase,url:this.page?.url().startsWith(ORIGIN)?this.page.url().split('?')[0]:''};}
 async open(){
  if(this.page&&!this.page.isClosed())return this.state();
  if(this.launching)return this.launching;
  this.phase='starting';
  this.launching=(async()=>{
   try{
    this.context=await chromium.launchPersistentContext(path.join(this.dir,'browser'),{executablePath:'/usr/bin/chromium',headless:false,chromiumSandbox:true,viewport:{width:1100,height:760},acceptDownloads:false,serviceWorkers:'block',locale:'zh-CN',timezoneId:'Asia/Shanghai',args:['--disable-dev-shm-usage','--disable-background-networking','--disable-features=Translate','--renderer-process-limit=3','--disable-breakpad']});
    this.context.setDefaultTimeout(10000);
    await this.context.routeWebSocket('**/*',ws=>{this.record('websocket_blocked',ws.url(),'policy');ws.close();});
    await this.context.route('**/*',async route=>{
     const request=route.request(),url=request.url();
     if(!allowedBrowserURL(url)||request.resourceType()==='media'){this.record('blocked',url,request.resourceType());return route.abort('blockedbyclient');}
     if(request.isNavigationRequest()&&request.frame()===request.frame().page().mainFrame()&&!['www.nodeseek.com','nodeseek.com'].includes(new URL(url).hostname))return route.abort('blockedbyclient');
     try{await route.continue();}catch{this.record('route_error',url,request.resourceType());}
    });
    this.page=this.context.pages()[0]||await this.context.newPage();
    for(const p of this.context.pages())if(p!==this.page)await p.close();
    this.context.on('page',p=>{if(p!==this.page)p.close().catch(()=>{});});
    this.context.on('close',()=>{this.context=null;this.page=null;this.account=null;this.phase='stopped';});
    this.page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
    this.page.on('requestfailed',r=>{const code=String(r.failure()?.errorText||'').match(/net::[A-Z_]+/)?.[0]||'request_failed';this.record('failed',r.url(),code);});
    this.page.on('response',r=>{if(r.status()>=400)this.record('http_error',r.url(),String(r.status()));});
    this.page.on('pageerror',()=>{this.jsErrors++;});
    await this.page.goto(ORIGIN,{waitUntil:'domcontentloaded',timeout:35000}).catch(()=>{});
    this.phase='ready';await this.diagnostics();return this.state();
   }catch{this.phase='error';if(this.context)await this.context.close().catch(()=>{});this.context=null;this.page=null;throw new Error('服务器浏览器启动失败，请稍后重试');}
   finally{this.launching=null;}
  })();return this.launching;
 }
 async identity(){
  if(!this.page||this.page.isClosed())return null;
  if(new URL(this.page.url()).origin!==ORIGIN){this.account=null;this.phase='login_required';return null;}
  let result;
  try{result=await this.page.evaluate(async()=>{
   const response=await fetch('/',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok)return {blocked:true};
   const doc=new DOMParser().parseFromString(await response.text(),'text/html');
   if(doc.querySelector('#challenge-form,#cf-challenge-running')||/Just a moment|验证您是真人/.test(doc.title))return {blocked:true};
   const raw=doc.querySelector('#temp-script')?.textContent?.trim();
   if(raw){try{const cfg=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw),c=>c.charCodeAt(0))));if(Object.hasOwn(cfg,'user')){const id=Number(cfg.user?.member_id??cfg.user?.id);return Number.isSafeInteger(id)&&id>0?{id,name:String(cfg.user.member_name??cfg.user.name??id)}:{guest:true};}}catch{}}
   for(const card of doc.querySelectorAll('.user-card:not(.hover-user-card)')){
    if(!card.querySelector('a[href^="/notification"]'))continue;
    for(const link of card.querySelectorAll('a[href]')){const match=/^\/space\/([1-9]\d*)\/?$/.exec(link.getAttribute('href'));if(match)return {id:Number(match[1]),name:link.textContent.trim()||link.querySelector('img')?.alt||match[1]};}
   }
   return {guest:true};
  });}catch{this.phase='verification_required';throw new Error('无法确认论坛登录状态，请打开远程浏览器检查');}
  if(result.blocked){this.account=null;this.phase='verification_required';throw new Error('论坛需要验证，请在远程浏览器中手动完成');}
  this.account=Number.isSafeInteger(result.id)&&result.id>0?{id:result.id,name:String(result.name).slice(0,100)}:null;
  this.phase=this.account?'logged_in':'login_required';return this.account;
 }
 async api(apiPath){
  if(!allowedAPI(apiPath))throw new Error('不允许的论坛接口');
  if(!this.page||new URL(this.page.url()).origin!==ORIGIN)throw new Error('请先登录论坛');
  const response=await this.page.evaluate(async p=>{
   try{const r=await fetch(p,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});return {status:r.status,data:await r.json().catch(()=>null)};}catch{return {status:0,data:null};}
  },apiPath);
  if(response.status!==200||response.data?.success!==true)throw new Error('论坛接口未成功，可能需要登录或验证');
  return response.data;
 }
 async postText(postId,floor){
  const id=Number(postId),f=Number(String(floor??'').replace(/^#/,''));
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(f)||f<1||f>1000000)return '';
  if(!this.page||new URL(this.page.url()).origin!==ORIGIN)return '';
  const pathname='/post-'+id+'-'+Math.max(1,Math.ceil(f/10));
  return this.page.evaluate(async ({pathname,f})=>{
   try{const r=await fetch(pathname,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)return '';const d=new DOMParser().parseFromString(await r.text(),'text/html');const node=d.getElementById(String(f))||d.getElementById('comment-'+f);const content=node?.querySelector('.post-content,.content,.markdown-body')||node;return content?.textContent?.trim().slice(0,2000)||'';}catch{return '';}
  },{pathname,f});
 }
 async login(username,password){
  if(typeof username!=='string'||username.length<1||username.length>150||typeof password!=='string'||!password.length||password.length>256)throw new Error('请输入有效的用户名和密码');
  await this.open();
  let passwordField=this.page.locator('input[type="password"]').first();
  if(!await passwordField.isVisible().catch(()=>false)){
   const links=await this.page.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>({href:n.getAttribute('href'),text:n.textContent.trim()})).filter(n=>/^(登录|登入|Log in|Sign in)$/i.test(n.text)));
   const entry=links.find(n=>{try{const u=new URL(n.href,'https://www.nodeseek.com');return u.origin==='https://www.nodeseek.com'&&!u.hash;}catch{return false;}});
   if(entry)await this.page.goto(new URL(entry.href,ORIGIN).href,{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
   passwordField=this.page.locator('input[type="password"]').first();
  }
  if(!await passwordField.isVisible().catch(()=>false))throw new Error('请先在远程画面中完成验证并打开登录页面，再点击填写并登录');
  const userField=this.page.locator('input[autocomplete="username"],input[name="username"],input[name="account"],input[name="email"],input[type="email"],input[type="text"]').filter({visible:true}).first();
  if(!await userField.count())throw new Error('未识别账号输入框，请在远程画面中直接输入');
  await userField.fill(username);await passwordField.fill(password);password='';
  const form=passwordField.locator('xpath=ancestor::form[1]');
  let submit=form.locator('button[type="submit"],input[type="submit"]').first();
  if(!await submit.count())submit=this.page.getByRole('button',{name:/^(登录|登入|Sign in|Log in)$/i}).first();
  if(await submit.count())await submit.click({timeout:5000}).catch(()=>{});else await passwordField.press('Enter');
  this.phase='login_submitted';return {message:'登录已提交；如有验证码，请在远程画面完成后检查登录状态'};
 }
 async screenshot(){if(!this.page||this.page.isClosed())throw new Error('浏览器尚未启动');await this.diagnostics();return this.page.screenshot({type:'jpeg',quality:70,timeout:10000});}
 async input(action){
  if(!this.page||this.page.isClosed())throw new Error('浏览器尚未启动');
  if(!action||typeof action!=='object')throw new Error('操作无效');
  if(action.type==='click'){
   if(!Number.isFinite(action.x)||!Number.isFinite(action.y)||action.x<0||action.x>1100||action.y<0||action.y>760)throw new Error('坐标无效');
   await this.page.mouse.click(action.x,action.y);
  }else if(action.type==='text'){
   if(typeof action.text!=='string'||action.text.length>2000)throw new Error('输入过长');await this.page.keyboard.insertText(action.text);
  }else if(action.type==='key'){
   if(!['Enter','Tab','Backspace','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Delete'].includes(action.key))throw new Error('不支持的按键');await this.page.keyboard.press(action.key);
  }else if(action.type==='scroll'){
   if(!Number.isFinite(action.deltaY))throw new Error('滚动无效');await this.page.mouse.wheel(0,Math.max(-1500,Math.min(1500,action.deltaY)));
  }else throw new Error('不支持的操作');
 }
 async close(){if(this.context)await this.context.close();this.context=null;this.page=null;this.account=null;this.phase='stopped';}
}

