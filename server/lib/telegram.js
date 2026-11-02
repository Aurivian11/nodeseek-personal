export const validToken = value => typeof value==='string' && /^[1-9]\d{4,15}:[A-Za-z0-9_-]{25,100}$/.test(value);
export const validChat = value => typeof value==='string' && /^[1-9]\d{3,15}$/.test(value);
export async function sendTelegram(config,text,{fetchImpl=fetch,signal}={}){
  if(!validToken(config.token)||!validChat(config.chatId))return {status:'rejected',message:'请先填写有效的 Bot Token 和私人 Chat ID'};
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)controller.abort();
  try{
    const response=await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`,{
      method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:config.chatId,text:String(text).slice(0,3900),link_preview_options:{is_disabled:true}})
    });
    const result=await response.json().catch(()=>null);
    if(response.ok&&result?.ok===true&&Number.isSafeInteger(result.result?.message_id))return {status:'sent'};
    if(response.status===429&&result?.ok===false)return {status:'rate_limited',retryAfter:Math.min(86400,Math.max(1,Number(result.parameters?.retry_after)||60)),message:'Telegram 限流，稍后重试'};
    if(result?.ok===false&&[400,401,403,404].includes(response.status))return {status:'rejected',message:'Telegram 拒绝发送，请检查 Bot Token、Chat ID，并先向机器人发送 /start'};
    return {status:'unknown',message:'发送结果未确认，请到 Telegram 核对'};
  }catch{return {status:'unknown',message:'网络异常或超时，发送结果未确认'};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
