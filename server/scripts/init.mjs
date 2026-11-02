import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { passwordRecord } from '../lib/auth.js';
function exists(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function privateDirectory(dir){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const stat=fs.lstatSync(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700)throw new Error('DATA_DIR must be a private directory with mode 0700');
}
function key(file){
 if(!exists(file))fs.writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==32)throw new Error('Existing application key must be a regular 32-byte file');
 fs.chmodSync(file,0o600);
}
export function initialize(config=loadConfig(),{write=line=>process.stdout.write(line)}={}){
 const admin=path.join(config.dataDir,'admin.json');
 if(exists(admin))throw new Error('Administrator already exists; initialization will not overwrite it');
 const oldMask=process.umask(0o077);let store=null,temp=null;
 try{
  privateDirectory(config.dataDir);
  if(exists(admin))throw new Error('Administrator already exists; initialization will not overwrite it');
  key(path.join(config.dataDir,'master.key'));key(path.join(config.dataDir,'browser-bridge.key'));
  store=new Store(config.dataDir);store.close();store=null;
  fs.chmodSync(path.join(config.dataDir,'state.sqlite'),0o600);
  const password=randomBytes(24).toString('base64url');
  temp=path.join(config.dataDir,'.admin-'+randomBytes(12).toString('hex')+'.tmp');
  fs.writeFileSync(temp,JSON.stringify(passwordRecord(password))+'\n',{flag:'wx',mode:0o600});
  // Linking publishes a complete file atomically and refuses an existing admin.
  fs.linkSync(temp,admin);fs.unlinkSync(temp);temp=null;
  write('Administrator password (shown once): '+password+'\n');
  return {dataDir:config.dataDir};
 }finally{
  store?.close();if(temp)try{fs.unlinkSync(temp);}catch{}
  process.umask(oldMask);
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==2)throw new Error('Usage: node scripts/init.mjs (configure APP_ORIGIN, SERVER_PORT and DATA_DIR through the environment)');
  initialize();
 }catch(error){
  const known=error instanceof Error&&/^(Administrator already exists|DATA_DIR must|Existing application key|APP_ORIGIN must|SERVER_PORT |SERVER_PORT and|DATA_DIR must|Usage:)/.test(error.message);
  process.stderr.write((known?error.message:'Initialization failed; check the private data directory and its permissions')+'\n');process.exitCode=1;
 }
}
