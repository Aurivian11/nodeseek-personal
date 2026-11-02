import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const PROJECT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function originValue(value){
 const invalid=()=>{throw new Error('APP_ORIGIN must be an HTTPS origin without credentials, query, hash, or a non-root path');};
 if(typeof value!=='string'||/[\s\x00-\x20\x7f\\@]/.test(value)||!/^https:\/\/[^/?#]+\/?$/i.test(value))invalid();
 let url;try{url=new URL(value);}catch{invalid();}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.port==='0')invalid();
 const host=url.hostname;
 const domain=host.length<=253&&host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
 if(!domain&&!/^\[[0-9a-f:]+\]$/i.test(host))invalid();
 return url;
}
function portValue(value){
 if(typeof value!=='string'||/\s/.test(value)||!/^[1-9]\d{0,4}$/.test(value)||Number(value)>65535)throw new Error('SERVER_PORT (or legacy PORT) must be an integer from 1 to 65535');
 return Number(value);
}
export function loadConfig(env=process.env,{projectRoot=PROJECT_ROOT}={}){
 const root=path.resolve(projectRoot),url=originValue(env.APP_ORIGIN);
 const primary=env.SERVER_PORT===undefined?null:portValue(env.SERVER_PORT);
 const legacy=env.PORT===undefined?null:portValue(env.PORT);
 if(primary!==null&&legacy!==null&&primary!==legacy)throw new Error('SERVER_PORT and PORT must agree when both are set');
 if(env.DATA_DIR!==undefined&&(typeof env.DATA_DIR!=='string'||!env.DATA_DIR.length||env.DATA_DIR.includes('\0')))throw new Error('DATA_DIR must be a non-empty filesystem path');
 return Object.freeze({origin:url.origin,hostname:url.hostname,port:primary??legacy??8767,dataDir:path.resolve(root,env.DATA_DIR??'data'),projectRoot:root});
}
