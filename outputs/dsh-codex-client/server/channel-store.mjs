import {DatabaseSync} from 'node:sqlite';
import {mkdir,chmod,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const channelFault=code=>Object.assign(new Error(code),{code});
export const channelKey=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decode=row=>row?{...row,message:row.message?JSON.parse(row.message):undefined}:null;

// Separate from the bounded chat index: inbox and reply obligations can grow
// without enlarging client.json. SQLite FULL synchronous commits precede ACKs.
export class ChannelStore{
  constructor({dataDir,platform}){this.root=path.join(dataDir,'channels');this.platform=platform;this.closed=false;}
  async open(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    const directory=await lstat(this.root);if(!directory.isDirectory()||directory.isSymbolicLink())throw channelFault('CHANNEL_STORAGE_UNSAFE');
    if(await realpath(this.root)!==this.root)throw channelFault('CHANNEL_STORAGE_UNSAFE');
    this.file=path.join(this.root,this.platform+'.sqlite');
    for(const suffix of ['','-wal','-shm']){try{const info=await lstat(this.file+suffix);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw channelFault('CHANNEL_STORAGE_UNSAFE');}catch(error){if(error.code!=='ENOENT')throw error;}}
    this.db=new DatabaseSync(this.file);await chmod(this.file,0o600);
    if(this.db.prepare('PRAGMA user_version').get().user_version>1||this.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw channelFault('CHANNEL_STORAGE_FAILED');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, binding TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL,
        session_id TEXT, run_id TEXT, turn_id TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL, inbox_id TEXT NOT NULL, binding TEXT NOT NULL, message TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_retry INTEGER NOT NULL DEFAULT 0,
        remote_id TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_status ON inbox(status,created);
      CREATE INDEX IF NOT EXISTS inbox_binding ON inbox(binding,status,created);
      CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status,next_retry,created);
      PRAGMA user_version=1;`);
    for(const suffix of ['-wal','-shm'])await chmod(this.file+suffix,0o600).catch(error=>{if(error.code!=='ENOENT')throw error;});
    // A process crash can occur after a remote send succeeds and before its
    // receipt commits. Never turn that interval into an automatic resend.
    this.db.prepare("UPDATE outbox SET status='unknown', error='CHANNEL_DELIVERY_UNCERTAIN' WHERE status='sending'").run();
    this.db.prepare("UPDATE inbox SET status='unknown', error='CHANNEL_EXECUTION_UNCERTAIN' WHERE status IN ('creating','starting','command') AND run_id IS NULL").run();
    return this;
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  config(){const row=this.db.prepare('SELECT value FROM settings WHERE id=1').get();return row?JSON.parse(row.value):null;}
  saveConfig(value){this.db.prepare('INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));}
  binding(id){return this.db.prepare('SELECT * FROM bindings WHERE id=?').get(id);}
  bind(id,sessionId){this.db.prepare('INSERT INTO bindings(id,session_id) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,paused=0').run(id,sessionId);}
  pauseBinding(id){this.db.prepare('UPDATE bindings SET paused=1 WHERE id=?').run(id);this.db.prepare("UPDATE inbox SET status='stopped',updated=? WHERE binding=? AND status='accepted'").run(Date.now(),id);}
  inbox(id){return decode(this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id));}
  accept(message){
    const binding=channelKey([message.scopeId??'',message.chatType,message.chatId,message.threadId??'',message.senderId]);
    const id=channelKey([binding,message.messageId]);const now=Date.now();
    if(this.inbox(id))return {accepted:true,duplicate:true,id,binding};
    if(this.db.prepare("SELECT count(*) AS n FROM inbox WHERE status IN ('accepted','creating','starting','running','paused','unknown')").get().n>=2000)throw channelFault('CHANNEL_BACKPRESSURE');
    this.db.prepare('INSERT INTO inbox(id,binding,message,status,created,updated) VALUES(?,?,?,\'accepted\',?,?)').run(id,binding,JSON.stringify(message),now,now);
    return {accepted:true,duplicate:false,id,binding};
  }
  updateInbox(id,patch){
    const allowed=new Set(['status','session_id','run_id','turn_id','error']);const entries=Object.entries(patch);
    if(entries.some(([key])=>!allowed.has(key)))throw channelFault('CHANNEL_STORAGE_FAILED');
    this.db.prepare('UPDATE inbox SET '+entries.map(([key])=>key+'=?').join(',')+',updated=? WHERE id=?').run(...entries.map(([,value])=>value??null),Date.now(),id);
  }
  rows(statuses,limit=100){return this.db.prepare('SELECT * FROM inbox WHERE status IN ('+statuses.map(()=>'?').join(',')+') ORDER BY created,rowid LIMIT ?').all(...statuses,limit).map(decode);}
  active(binding){return decode(this.db.prepare("SELECT * FROM inbox WHERE binding=? AND status IN ('creating','starting','running','paused','unknown') ORDER BY created DESC LIMIT 1").get(binding));}
  finish(row,text,status='completed',kind='final'){
    const codepoints=Array.from(text);const chunks=[];
    for(let i=0;i<codepoints.length;i+=1000)chunks.push(codepoints.slice(i,i+1000).join(''));
    if(chunks.length>100)throw channelFault('CHANNEL_RESPONSE_LIMIT');
    this.transaction(()=>{
      for(let index=0;index<chunks.length;index++){
        const message={chatId:row.message.chatId,chatType:row.message.transportType??(row.message.chatType==='dm'?'c2c':row.message.chatType),
          replyTo:row.message.messageId,metadata:row.message.metadata??{},text:chunks[index]};
        const now=Date.now();
        this.db.prepare("INSERT OR IGNORE INTO outbox(id,inbox_id,binding,message,status,created,updated) VALUES(?,?,?,?, 'pending',?,?)")
          .run(channelKey([row.id,kind,index]),row.id,row.binding,JSON.stringify(message),now,now);
      }
      this.updateInbox(row.id,{status});
    });
  }
  deliveries(){return this.db.prepare("SELECT * FROM outbox AS o WHERE status='pending' AND next_retry<=? AND NOT EXISTS(SELECT 1 FROM outbox AS previous WHERE previous.binding=o.binding AND previous.sequence<o.sequence AND previous.status!='delivered') ORDER BY sequence LIMIT 10").all(Date.now()).map(decode);}
  updateDelivery(id,patch){const allowed=new Set(['status','attempts','next_retry','remote_id','error']);const entries=Object.entries(patch);if(entries.some(([key])=>!allowed.has(key)))throw channelFault('CHANNEL_STORAGE_FAILED');this.db.prepare('UPDATE outbox SET '+entries.map(([key])=>key+'=?').join(',')+',updated=? WHERE id=?').run(...entries.map(([,v])=>v??null),Date.now(),id);}
  delivery(id){return decode(this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id));}
  pending(){return this.db.prepare("SELECT id,inbox_id,status,error,created,updated FROM outbox WHERE status!='delivered' ORDER BY created DESC LIMIT 30").all();}
  counts(){return Object.fromEntries(this.db.prepare('SELECT status,count(*) AS n FROM inbox GROUP BY status').all().map(row=>[row.status,row.n]));}
  prune(){
    const cutoff=Date.now()-30*86400000;
    this.transaction(()=>{
      this.db.prepare("DELETE FROM outbox WHERE status='delivered' AND updated<?").run(cutoff);
      this.db.prepare("DELETE FROM inbox WHERE status IN ('completed','stopped','rejected') AND updated<? AND NOT EXISTS(SELECT 1 FROM outbox WHERE inbox_id=inbox.id)").run(cutoff);
    });
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }
  close(){if(this.closed)return;this.closed=true;this.db?.close();}
}
