import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadConfig, PROJECT_ROOT } from '../lib/config.js';
import { Auth } from '../lib/auth.js';
import { Store } from '../lib/store.js';
import { initialize } from '../scripts/init.mjs';
import { renderBridge } from '../scripts/render-bridge.mjs';
const ORIGIN='https://console.example.test:10443';
const mode=file=>fs.statSync(file).mode&0o777;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nsp-setup-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dataDir=path.join(root,'private-data');
 const env={APP_ORIGIN:ORIGIN,SERVER_PORT:'8767',DATA_DIR:dataDir,NODE_NO_WARNINGS:'1'};
 return {root,dataDir,env,config:loadConfig(env)};
}
function command(script,env,args=[]){
 return spawnSync(process.execPath,[path.join(PROJECT_ROOT,'scripts',script),...args],{cwd:PROJECT_ROOT,env,encoding:'utf8',timeout:10000,maxBuffer:256*1024});
}
function key(f,size=32){
 fs.mkdirSync(f.dataDir,{recursive:true,mode:0o700});const bytes=randomBytes(size);
 fs.writeFileSync(path.join(f.dataDir,'browser-bridge.key'),bytes,{mode:0o600});return bytes;
}

test('portable configuration canonicalizes HTTPS roots and resolves project-relative data',()=>{
 const projectRoot='/synthetic-project';
 assert.deepEqual(loadConfig({APP_ORIGIN:ORIGIN+'/'},{projectRoot}),{origin:ORIGIN,hostname:'console.example.test',port:8767,dataDir:'/synthetic-project/data',projectRoot});
 assert.equal(loadConfig({APP_ORIGIN:'https://EXAMPLE.test:443',DATA_DIR:'private',SERVER_PORT:'65535'},{projectRoot}).origin,'https://example.test');
 assert.equal(loadConfig({APP_ORIGIN:ORIGIN,DATA_DIR:'private'},{projectRoot}).dataDir,'/synthetic-project/private');
 assert.equal(loadConfig({APP_ORIGIN:'https://[::1]:10443',PORT:'1'}).hostname,'[::1]');
 assert.equal(loadConfig({APP_ORIGIN:ORIGIN,SERVER_PORT:'9000',PORT:'9000'}).port,9000);
});

test('origin validation rejects credential, path, query, fragment and script-context injection',()=>{
 for(const value of [undefined,'','http://example.test','https://user:secret@example.test','https://@example.test',
  'https://example.test/a','https://example.test/.','https://example.test/%2e','https://example.test/?','https://example.test/#',
  'https://example.test?token=secret','https://example.test#x','https://example.test\n','https://example.test\u0001',
  'https://example.test:0',"https://evil'host.test",'https://evil`host.test','https:\\example.test'])
  assert.throws(()=>loadConfig({APP_ORIGIN:value}),/APP_ORIGIN/);
});

test('server ports are bounded decimal integers and legacy aliases cannot conflict',()=>{
 for(const value of ['', '0','65536','-1','1.2','1e3',' 8767','08767','80\n']){
  assert.throws(()=>loadConfig({APP_ORIGIN:ORIGIN,SERVER_PORT:value}),/SERVER_PORT/);
  assert.throws(()=>loadConfig({APP_ORIGIN:ORIGIN,PORT:value}),/SERVER_PORT/);
 }
 assert.throws(()=>loadConfig({APP_ORIGIN:ORIGIN,SERVER_PORT:'8767',PORT:'9000'}),/must agree/);
 assert.throws(()=>loadConfig({APP_ORIGIN:ORIGIN,DATA_DIR:''}),/DATA_DIR/);
});

test('isolated initialization creates compatible private keys and admin, printing one random password once',t=>{
 const f=fixture(t),result=command('init.mjs',f.env);
 assert.equal(result.status,0,result.stderr);
 const match=/^Administrator password \(shown once\): ([A-Za-z0-9_-]{32})\n$/.exec(result.stdout);
 assert(match,'one password line only');const password=match[1];
 assert.equal(mode(f.dataDir),0o700);
 for(const name of ['master.key','browser-bridge.key']){
  assert.equal(fs.readFileSync(path.join(f.dataDir,name)).length,32);assert.equal(mode(path.join(f.dataDir,name)),0o600);
 }
 const admin=JSON.parse(fs.readFileSync(path.join(f.dataDir,'admin.json'),'utf8'));
 assert.equal(mode(path.join(f.dataDir,'admin.json')),0o600);assert.equal(mode(path.join(f.dataDir,'state.sqlite')),0o600);
 assert(!JSON.stringify(admin).includes(password));assert(new Auth(admin).authenticate(password));
 const store=new Store(f.dataDir);assert.equal(store.get('missing'),null);store.close();
 const prior=Object.fromEntries(['admin.json','master.key','browser-bridge.key'].map(name=>[name,fs.readFileSync(path.join(f.dataDir,name))]));
 const again=command('init.mjs',f.env);assert.equal(again.status,1);assert.equal(again.stdout,'');assert.match(again.stderr,/will not overwrite/);
 for(const [name,value]of Object.entries(prior))assert.deepEqual(fs.readFileSync(path.join(f.dataDir,name)),value);
});

test('initialization preserves existing valid keys and refuses invalid keys or non-private data directories',t=>{
 const f=fixture(t),bridge=key(f),master=randomBytes(32);
 fs.writeFileSync(path.join(f.dataDir,'master.key'),master,{mode:0o600});const output=[];
 initialize(f.config,{write:line=>output.push(line)});assert.equal(output.length,1);
 assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'master.key')),master);
 assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'browser-bridge.key')),bridge);
 const bad=fixture(t);key(bad,31);let leaked='';
 assert.throws(()=>initialize(bad.config,{write:line=>{leaked+=line;}}),/32-byte/);
 assert.equal(leaked,'');assert.equal(fs.existsSync(path.join(bad.dataDir,'admin.json')),false);
 // mkdir mode is filtered by the caller's umask; this rejection fixture must stay public.
 const publicDir=fixture(t);fs.mkdirSync(publicDir.dataDir,{mode:0o755});fs.chmodSync(publicDir.dataDir,0o755);
 assert.throws(()=>initialize(publicDir.config,{write:()=>assert.fail('no password expected')}),/0700/);
 assert.equal(mode(publicDir.dataDir),0o755);
});

test('rendering the actual template fills only validated endpoint data and writes private output without echoing the token',t=>{
 const f=fixture(t),bytes=key(f),token=bytes.toString('base64url');
 const result=command('render-bridge.mjs',f.env);assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout,'Bridge script rendered into its private output file.\n');assert(!result.stdout.includes(token));assert(!result.stderr.includes(token));
 const output=path.join(f.dataDir,'nodeseek-monitor-bridge.user.js'),source=fs.readFileSync(output,'utf8');
 assert.equal(mode(output),0o600);assert.equal(mode(f.dataDir),0o700);
 assert.match(source,/^\/\/ @connect\s+console\.example\.test$/m);
 assert(source.includes("const SERVER = '"+ORIGIN+"'"));assert(source.includes("const TOKEN = '"+token+"'"));
 assert(!/__BRIDGE_(?:HOST|ORIGIN|TOKEN)__/.test(source));
 const custom=path.join(f.root,'custom.user.js');fs.writeFileSync(custom,'old content',{mode:0o644});
 const second=command('render-bridge.mjs',f.env,['--output',custom]);assert.equal(second.status,0,second.stderr);
 assert.equal(mode(custom),0o600);assert.equal(fs.readFileSync(custom,'utf8'),source);
 assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'browser-bridge.key')),bytes);
});

test('render rejects malformed and symlink keys without modifying a prior output or printing secrets',t=>{
 const f=fixture(t);key(f,31);const output=path.join(f.dataDir,'nodeseek-monitor-bridge.user.js');
 fs.writeFileSync(output,'prior valid output',{mode:0o600});
 const bad=command('render-bridge.mjs',f.env);assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.match(bad.stderr,/exactly 32 bytes/);
 assert.equal(fs.readFileSync(output,'utf8'),'prior valid output');
 const target=path.join(f.root,'synthetic-key');fs.writeFileSync(target,randomBytes(32),{mode:0o600});
 fs.unlinkSync(path.join(f.dataDir,'browser-bridge.key'));fs.symlinkSync(target,path.join(f.dataDir,'browser-bridge.key'));
 assert.throws(()=>renderBridge({env:f.env}),/private regular file/);
 assert.equal(fs.readFileSync(output,'utf8'),'prior valid output');
});

test('template validation and atomic publication failures leave the previous file intact and clean temporary files',t=>{
 const f=fixture(t);key(f);const output=path.join(f.dataDir,'nodeseek-monitor-bridge.user.js');
 fs.writeFileSync(output,'prior valid output',{mode:0o600});
 const badTemplate=path.join(f.root,'missing.template.js');fs.writeFileSync(badTemplate,'__BRIDGE_HOST__ __BRIDGE_ORIGIN__');
 assert.throws(()=>renderBridge({env:f.env,templatePath:badTemplate}),/missing required placeholders/);
 assert.equal(fs.readFileSync(output,'utf8'),'prior valid output');
 t.mock.method(fs,'renameSync',()=>{throw new Error('synthetic publish failure');});
 assert.throws(()=>renderBridge({env:f.env}),/synthetic publish failure/);
 assert.equal(fs.readFileSync(output,'utf8'),'prior valid output');
 assert(!fs.readdirSync(f.dataDir).some(name=>name.startsWith('.bridge-')));
});

test('render refuses non-private output parents rather than changing a shared directory',t=>{
 const f=fixture(t);key(f);const dir=path.join(f.root,'shared');fs.mkdirSync(dir,{mode:0o755});fs.chmodSync(dir,0o755);
 assert.throws(()=>renderBridge({env:f.env,output:path.join(dir,'bridge.user.js')}),/0700/);
 assert.equal(mode(dir),0o755);assert.deepEqual(fs.readdirSync(dir),[]);
});
