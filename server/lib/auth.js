import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
export const COOKIE='__Host-nspconsole';
export function passwordRecord(password){const salt=randomBytes(16).toString('hex');return {salt,hash:scryptSync(password,salt,32).toString('hex')};}
export class Auth {
 constructor(record){this.record=record;this.sessions=new Map();this.failures=[];this.blockedUntil=0;}
 authenticate(password){
  const now=Date.now();this.failures=this.failures.filter(t=>now-t<300000);
  if(now<this.blockedUntil)return {limited:true};
  if(this.failures.length>=6){this.blockedUntil=now+300000;return {limited:true};}
  this.failures.push(now);
  const pass=typeof password==='string'&&password.length<=256?password:'';
  const actual=scryptSync(pass,this.record.salt,32),expected=Buffer.from(this.record.hash,'hex');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
  this.failures=[];
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url'),expires=now+12*3600000;
  const key=this.key(token);
  for(const [id,s] of this.sessions)if(s.expires<now)this.sessions.delete(id);
  if(this.sessions.size>=20)this.sessions.delete(this.sessions.keys().next().value);
  this.sessions.set(key,{csrf,expires});
  return {token,csrf};
 }
 key(token){return createHash('sha256').update(token).digest('hex');}
 find(req){const raw=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='));const token=raw?.slice(COOKIE.length+1);if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;const key=this.key(token),s=this.sessions.get(key);if(!s||s.expires<Date.now()){this.sessions.delete(key);return null;}return {...s,key};}
 remove(session){if(session)this.sessions.delete(session.key);}
}

