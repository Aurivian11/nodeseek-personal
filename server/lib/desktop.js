import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
export function desktopAsset(urlPath,root){
 const pages={'/desktop':'desktop.html','/desktop.js':'desktop.js','/desktop.css':'desktop.css'};
 if(pages[urlPath])return path.join(root,'public',pages[urlPath]);
 if(!urlPath.startsWith('/desktop-assets/'))return null;
 const rel=urlPath.slice('/desktop-assets/'.length);
 if(!/^(core|vendor)\/[A-Za-z0-9_./-]+\.js$/.test(rel)||rel.split('/').some(p=>p==='.'||p==='..'||!p))return null;
 return path.join('/usr/share/novnc',rel);
}
export function attachDesktop(server,{auth,origin,socketPath='/run/nodeseek-desktop/vnc.sock',checkInterval=5000,maxClients=2}){
 const sockets=new Map(),limit=2*1024*1024;
 const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
 const deny=(s,status)=>{s.end('HTTP/1.1 '+status+'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};
 server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/api/desktop/socket'){deny(socket,'404 Not Found');return;}
  if(req.headers.host!==new URL(origin).host||req.headers.origin!==origin){deny(socket,'403 Forbidden');return;}
  const session=auth.find(req);
  if(!session){deny(socket,'401 Unauthorized');return;}
  if(sockets.size>=maxClients){deny(socket,'429 Too Many Requests');return;}
  wss.handleUpgrade(req,socket,head,ws=>{
   const upstream=net.createConnection({path:socketPath});let drainTimer=null,closed=false;
   const close=()=>{if(closed)return;closed=true;clearInterval(authTimer);clearTimeout(drainTimer);sockets.delete(ws);upstream.destroy();ws.terminate();};
   const authTimer=setInterval(()=>{if(!auth.find(req))close();},checkInterval);authTimer.unref();
   sockets.set(ws,{key:session.key,close});
   upstream.setTimeout(120000,()=>{if(ws.readyState===WebSocket.OPEN)ws.ping();});
   const resume=()=>{if(closed)return;if(ws.bufferedAmount>limit)return close();if(ws.bufferedAmount>512*1024)drainTimer=setTimeout(resume,25);else upstream.resume();};
   upstream.on('data',data=>{
    if(ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>limit)return close();
    ws.send(data,{binary:true},err=>{if(err)close();});
    if(ws.bufferedAmount>512*1024){upstream.pause();drainTimer=setTimeout(resume,25);}
   });
   ws.on('message',(data,isBinary)=>{
    if(!auth.find(req)||!isBinary||upstream.writableLength+data.length>limit)return close();
    if(!upstream.write(data))ws.pause();
   });
   upstream.on('drain',()=>{if(!closed)ws.resume();});
   upstream.on('error',close);upstream.on('close',close);
   ws.on('error',close);ws.on('close',close);
  });
 });
 const revoke=key=>{for(const s of sockets.values())if(s.key===key)s.close();};
 const close=()=>{for(const s of sockets.values())s.close();wss.close();};
 server.on('close',close);
 return {revoke,close,connections:()=>sockets.size};
}
