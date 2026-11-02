import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, PROJECT_ROOT } from '../lib/config.js';
function privateDirectory(dir){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const stat=fs.lstatSync(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700)throw new Error('Bridge output directory must be private with mode 0700');
}
function readKey(file){
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.size!==32||(stat.mode&0o077)!==0)throw new Error('Invalid bridge key');
  const bytes=fs.readFileSync(fd);if(bytes.length!==32)throw new Error('Invalid bridge key');return bytes;
 }catch{throw new Error('Bridge key must be a private regular file containing exactly 32 bytes');}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function renderBridge({env=process.env,projectRoot=PROJECT_ROOT,output,templatePath}={}){
 const config=loadConfig(env,{projectRoot});
 const secret=readKey(path.join(config.dataDir,'browser-bridge.key'));
 let source;try{source=fs.readFileSync(templatePath??path.join(config.projectRoot,'userscripts','nodeseek-monitor-bridge.template.js'),'utf8');}
 catch{throw new Error('Bridge template could not be read');}
 const replacements={__BRIDGE_HOST__:config.hostname,__BRIDGE_ORIGIN__:config.origin,__BRIDGE_TOKEN__:secret.toString('base64url')};
 for(const marker of Object.keys(replacements))if(!source.includes(marker))throw new Error('Bridge template is missing required placeholders');
 for(const [marker,value]of Object.entries(replacements))source=source.replaceAll(marker,value);
 secret.fill(0);
 const target=output?path.resolve(output):path.join(config.dataDir,'nodeseek-monitor-bridge.user.js');
 const dir=path.dirname(target);privateDirectory(dir);
 try{const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Bridge output must be a regular file');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 const temp=path.join(dir,'.bridge-'+randomBytes(12).toString('hex')+'.tmp');let fd;
 try{
  fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,source,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(temp,target);
 }finally{
  if(fd!==undefined)fs.closeSync(fd);
  try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return target;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--output'&&args[1]))throw new Error('Usage: node scripts/render-bridge.mjs [--output private-path]');
  renderBridge({output:args[1]});process.stdout.write('Bridge script rendered into its private output file.\n');
 }catch(error){
  const known=error instanceof Error&&/^(APP_ORIGIN must|SERVER_PORT |SERVER_PORT and|DATA_DIR must|Bridge |Usage:)/.test(error.message);
  process.stderr.write((known?error.message:'Bridge rendering failed; check the private paths and permissions')+'\n');process.exitCode=1;
 }
}
