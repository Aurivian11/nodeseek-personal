import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export class Store {
  constructor(dir) {
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const keyFile=path.join(dir,'master.key');
    if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'});
    this.key=fs.readFileSync(keyFile);
    if(this.key.length!==32)throw new Error('Invalid storage key');
    this.db=new DatabaseSync(path.join(dir,'state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  get(key,fallback=null){const row=this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  set(key,value){this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  encrypt(text){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);const data=Buffer.concat([cipher.update(String(text),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
  decrypt(value){const data=Buffer.from(value,'base64');if(data.length<28)throw new Error('Invalid ciphertext');const decipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');}
  close(){this.db.close();}
}
