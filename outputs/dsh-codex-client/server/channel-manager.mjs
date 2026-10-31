import {randomUUID} from 'node:crypto';
import {mkdir,realpath,lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {ChannelStore,channelFault} from './channel-store.mjs';
import {ChannelProcess} from './channel-process.mjs';
import {channelText} from '../shared/channel-locales.js';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const idText=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f]/.test(value);
const commands=new Set(['/status','/stop','/resume','/new']);
const knownCode=error=>String(error?.code??'').startsWith('ERR_SQLITE')?'CHANNEL_STORAGE_FAILED':/^CHANNEL_[A-Z_]+$/.test(error?.code)?error.code:'CHANNEL_RUNTIME_FAILED';
export class ChannelManager{
  constructor({host,platform,Process=ChannelProcess,tickMs=750}){
    Object.assign(this,{host,platform,Process,tickMs});this.store=new ChannelStore({dataDir:host.dataDir,platform});this.closed=false;this.stopping=false;this.worker=null;this.state='idle';this.error=null;this.attempt=0;this.nextConnect=0;this.serial=Promise.resolve();this.operations=new Set();this.pendingPeers=new Map();this.qrSession=null;
    this.home=path.join(host.dataDir,'channels','accounts',platform);
    this.runtimeRoot=path.join(host.appRoot,'channel-runtime');
  }
  async start(){await this.store.open();await mkdir(this.home,{recursive:true,mode:0o700});if(await realpath(this.home)!==this.home)throw channelFault('CHANNEL_STORAGE_UNSAFE');this.config=this.store.config();this.store.prune();this.timer=setInterval(()=>this.tick(),this.tickMs);this.timer.unref?.();return this;}
  text(key,values){return channelText(this.config?.locale??this.host.state.preferences?.locale,key,values);}
  snapshot(){
    const c=this.config;
    return {platform:this.platform,configured:!!c,config:c?{projectId:c.projectId,engineId:this.host.getSelectedEngine(),model:c.model,permission:c.permission,locale:c.locale,appId:c.appId??'',allowedUsers:c.allowedUsers,allowedGroups:c.allowedGroups,enabled:c.enabled,hasSecret:!!c.secret,hasToken:!!c.token,accountId:c.accountId??'',domain:c.domain??'feishu'}:null,
      pairing:[...this.pendingPeers.values()],runtime:{state:this.state,error:this.error,nextRetryAt:this.nextConnect?new Date(this.nextConnect).toISOString():null},counts:this.store.counts(),deliveries:this.store.pending(),executions:this.store.rows(['running','paused','unknown'],20).map(row=>({id:row.id,status:row.status,sessionId:row.session_id,error:row.error}))};
  }
  sequence(work){if(this.closed||this.stopping)return Promise.reject(channelFault('CHANNEL_STOPPED'));const result=this.serial.then(()=>{if(this.stopping||this.closed)throw channelFault('CHANNEL_STOPPED');return work();});this.serial=result.catch(()=>{});return result;}
  validateConfig(input){
    if(!input||typeof input!=='object')throw channelFault('CHANNEL_INVALID_CONFIG');
    const allowed=list=>{if(!Array.isArray(list)||list.length>200||list.some(v=>!idText(v)))throw channelFault('CHANNEL_INVALID_CONFIG');return [...new Set(list)];};
    if(input.projectId!=null&&!this.host.state.projects.some(p=>p.id===input.projectId)||!this.host.state.models.some(m=>m.id===input.model)||!['read-only','workspace-write'].includes(input.permission))throw channelFault('CHANNEL_INVALID_CONFIG');
    if(this.platform!=='weixin'&&((input.appId!==''&&!idText(input.appId))||typeof input.secret!=='string'||input.secret.length>8192))throw channelFault('CHANNEL_INVALID_CONFIG');
    if(this.config?.appId&&input.appId!==this.config.appId&&this.store.db.prepare('SELECT count(*) AS n FROM bindings').get().n)throw channelFault('CHANNEL_ACCOUNT_CHANGED');
    return {...this.config,projectId:input.projectId??null,model:input.model,permission:input.permission,locale:typeof input.locale==='string'&&input.locale.startsWith('zh')?'zh-CN':'en',engineId:this.host.getSelectedEngine(),allowedUsers:allowed(input.allowedUsers),allowedGroups:this.platform==='weixin'?[]:allowed(input.allowedGroups??[]),appId:this.platform==='weixin'?'':input.appId??'',secret:this.platform==='weixin'?'':input.secret||(input.appId===this.config?.appId?this.config?.secret:'')||'',...this.manualToken(input),enabled:false};
  }
  manualToken(input){
    if(this.platform!=='weixin'||!input.token)return {};
    if(typeof input.token!=='string'||input.token.length>8192||!idText(input.accountId))throw channelFault('CHANNEL_INVALID_CONFIG');
    if(this.config?.accountId&&this.config.accountId!==input.accountId)throw channelFault('CHANNEL_ACCOUNT_CHANGED');
    return {token:input.token,accountId:input.accountId,baseUrl:'https://ilinkai.weixin.qq.com'};
  }
  async saveConfig(input){return this.sequence(async()=>{if(this.config?.enabled||this.store.rows(['creating','starting','running'],1).length)throw channelFault('CHANNEL_BUSY');const c=this.validateConfig(input);await this.stopWorker();this.qrSession=null;this.pendingPeers.clear();this.store.saveConfig(c);this.config=c;this.state='disabled';this.error=null;return this.snapshot();});}
  extra(){const c=this.config;return {dsh_pairing:!c.allowedUsers.length,domain:c.domain??'feishu',send_chunk_retries:0,client_id:c.appId,bot_id:c.appId,secret:c.secret,allowed_users:c.allowedUsers,allowed_chats:c.allowedGroups,app_id:c.appId,app_secret:c.secret,client_secret:c.secret,account_id:c.accountId,base_url:c.baseUrl,allow_from:c.allowedUsers,group_allow_from:c.allowedGroups,dm_policy:'allowlist',group_policy:c.allowedGroups.length?'allowlist':'disabled',connection_mode:'websocket',require_mention:true,default_group_policy:'disabled',group_rules:Object.fromEntries(c.allowedGroups.map(id=>[id,{policy:'allowlist',allowlist:c.allowedUsers,require_mention:true}]))};}
  async createWorker({connect=true}={}){
    if(this.worker)await this.stopWorker();
    const worker=new this.Process({root:this.runtimeRoot,home:this.home,platform:this.platform,locale:this.config.locale,onIncoming:message=>this.receive(message)});this.worker=worker;
    worker.on('status',status=>{if(this.worker!==worker)return;if(status.state==='connected'){this.state='connected';this.error=null;this.attempt=0;}else if(status.state==='error'){this.state='error';this.error=knownCode({code:status.code});}});
    worker.on('exit',()=>{if(this.worker!==worker)return;this.worker=null;if(!this.closed&&!this.stopping&&this.config?.enabled)this.scheduleReconnect('CHANNEL_PROCESS_EXITED');});
    try{
      const result=await worker.start({extra:this.extra(),token:this.config.token??''},{connect});
      if(this.worker!==worker||this.closed||this.stopping){await worker.stop();return;}
      if(connect&&!result.connected){await this.stopWorker();this.scheduleReconnect(result.code??'CHANNEL_CONNECTION_FAILED');}
      else if(connect){this.state='connected';this.error=null;this.attempt=0;this.nextConnect=0;}
    }catch(error){if(this.worker===worker)await this.stopWorker();if(error.code==='ENOENT')this.scheduleReconnect('CHANNEL_RUNTIME_MISSING');else this.scheduleReconnect(knownCode(error));throw error;}
  }
  scheduleReconnect(code){this.state='retrying';this.error=code;this.nextConnect=Date.now()+Math.min(300000,5000*2**Math.min(this.attempt++,8));}
  async connect(){return this.sequence(async()=>{const c=this.config;if(!c||this.platform!=='weixin'&&(!c.secret||!idText(c.appId)))throw channelFault('CHANNEL_INVALID_CONFIG');if(this.platform==='weixin'&&!c.token)throw channelFault('CHANNEL_QR_REQUIRED');if(c.projectId!=null)this.host.getProject(c.projectId);this.store.saveConfig({...c,enabled:true});this.config={...c,enabled:true};this.nextConnect=0;this.state='connecting';await this.createWorker();return this.snapshot();});}
  async stopWorker(){const worker=this.worker;if(!worker)return;await worker.stop();if(this.worker===worker)this.worker=null;}
  async disconnect(){return this.sequence(async()=>{if(this.config){this.config={...this.config,enabled:false};this.store.saveConfig(this.config);}this.nextConnect=0;this.qrSession=null;this.pendingPeers.clear();await this.stopWorker();this.state='disabled';this.error=null;return this.snapshot();});}
  async qrStart(input){return this.sequence(async()=>{
    if(!['feishu','qq','weixin'].includes(this.platform))throw channelFault('CHANNEL_QR_UNSUPPORTED');
    if(this.config?.enabled||this.store.rows(['creating','starting','running'],1).length)throw channelFault('CHANNEL_BUSY');
    if(input){this.config=this.validateConfig({...input,appId:input.appId??'',secret:input.secret??''});this.store.saveConfig(this.config);}
    if(!this.config)throw channelFault('CHANNEL_INVALID_CONFIG');
    this.qrSession=null;this.pendingPeers.clear();await this.createWorker({connect:false});
    try{const result=await this.worker.request('qr/start',{},40000);const id=randomUUID();this.qrSession={id,expiresAt:result.expiresAt};return {...result,id};}
    catch{await this.stopWorker();throw channelFault('CHANNEL_QR_FAILED');}
  });}
  async qrCancel(id){const cancelled=this.qrSession?.id===id,worker=cancelled?this.worker:null;if(cancelled)this.qrSession=null;return this.sequence(async()=>{if(cancelled&&this.worker===worker)await this.stopWorker();return this.snapshot();});}
  async qrPoll(id){return this.sequence(async()=>{
    if(!this.qrSession||this.qrSession.id!==id||!this.worker)return {status:'expired'};
    if(Date.now()>=this.qrSession.expiresAt){this.qrSession=null;await this.stopWorker();return {status:'expired'};}
    const result=await this.worker.request('qr/poll',{},30000);
    if(this.closed||this.stopping||this.qrSession?.id!==id)return {status:'expired'};
    if(['expired','denied'].includes(result.status)){this.qrSession=null;await this.stopWorker();return {status:result.status};}
    if(result.status!=='confirmed')return {status:result.status};
    const credentials=result.credentials;
    if(this.platform==='weixin'){
      if(!credentials?.token||typeof credentials.token!=='string'||credentials.token.length>8192||!idText(credentials.account_id))throw channelFault('CHANNEL_QR_FAILED');
      if(this.config.accountId&&credentials.account_id!==this.config.accountId)throw channelFault('CHANNEL_ACCOUNT_CHANGED');
      let url;try{url=new URL(credentials.base_url);}catch{throw channelFault('CHANNEL_QR_FAILED');}
      if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname==='ilinkai.weixin.qq.com'||url.hostname.endsWith('.ilinkai.weixin.qq.com')))throw channelFault('CHANNEL_QR_FAILED');
      this.config={...this.config,token:credentials.token,accountId:credentials.account_id,baseUrl:url.origin};
    }else{
      if(!idText(credentials?.appId)||typeof credentials.secret!=='string'||!credentials.secret||credentials.secret.length>8192)throw channelFault('CHANNEL_QR_FAILED');
      if(this.config.appId&&credentials.appId!==this.config.appId&&this.store.db.prepare('SELECT count(*) AS n FROM bindings').get().n)throw channelFault('CHANNEL_ACCOUNT_CHANGED');
      this.config={...this.config,appId:credentials.appId,secret:credentials.secret,domain:credentials.domain==='lark'?'lark':'feishu'};
    }
    if(!this.config.allowedUsers.length&&idText(credentials.owner_id))this.config.allowedUsers=[credentials.owner_id];
    this.store.saveConfig(this.config);this.qrSession=null;await this.stopWorker();return {status:'confirmed',channel:this.snapshot()};
  });}
  async approvePeer(id){return this.sequence(async()=>{
    const peer=this.pendingPeers.get(id);if(!peer||!this.config?.enabled||this.config.allowedUsers.length)throw channelFault('CHANNEL_NOT_FOUND');
    this.config={...this.config,allowedUsers:[peer.senderId]};this.store.saveConfig(this.config);this.pendingPeers.clear();await this.createWorker();return this.snapshot();
  });}
  receive(message){const operation=this.admit(message).catch(error=>{if(['CHANNEL_ATTACHMENT_LIMIT','CHANNEL_UNSUPPORTED_ATTACHMENT'].includes(error.code)){this.error=error.code;return {accepted:true,rejected:true};}throw error;});this.operations.add(operation);operation.finally(()=>this.operations.delete(operation)).catch(()=>{});return operation;}
  async admit(message){
    if(this.closed||this.stopping||this.storageFailed||!this.config?.enabled)throw channelFault('CHANNEL_STOPPED');
    if(!message||!idText(message.messageId)||!idText(message.chatId)||!idText(message.senderId)||typeof message.text!=='string'||message.text.length>100000||!['dm','group','channel','thread'].includes(message.chatType)||message.threadId!=null&&!idText(message.threadId)||message.scopeId!=null&&!idText(message.scopeId))throw channelFault('CHANNEL_PROTOCOL_FAILED');
    if(!message.isBot&&!this.config.allowedUsers.length&&message.chatType==='dm'){
      const id=message.senderId;this.pendingPeers.set(id,{id,senderId:id,name:typeof message.senderName==='string'?message.senderName.slice(0,100):id});
      while(this.pendingPeers.size>20)this.pendingPeers.delete(this.pendingPeers.keys().next().value);
      return {accepted:true,rejected:true};
    }
    if(message.isBot||!this.config.allowedUsers.includes(message.senderId)&&!this.config.allowedUsers.includes(message.senderAlt))return {accepted:true,rejected:true};
    if(message.chatType!=='dm'&&(this.platform==='weixin'||!this.config.allowedGroups.includes(message.chatId)))return {accepted:true,rejected:true};
    if(!Array.isArray(message.attachments??[])||(message.attachments??[]).length>8)throw channelFault('CHANNEL_ATTACHMENT_LIMIT');
    const safe={messageId:message.messageId,chatId:message.chatId,senderId:message.senderId,scopeId:message.scopeId??null,threadId:message.threadId??null,chatType:message.chatType,text:message.text,senderName:typeof message.senderName==='string'?message.senderName.slice(0,100):null,chatName:typeof message.chatName==='string'?message.chatName.slice(0,100):null,transportType:this.platform==='qq'&&['c2c','group','guild','dm'].includes(message.transportType)?message.transportType:null,attachments:[],metadata:message.threadId?{thread_id:message.threadId}:{}};
    let total=0;
    for(const attachment of message.attachments??[]){
      if(typeof attachment.path!=='string'||typeof attachment.mime!=='string')throw channelFault('CHANNEL_UNSUPPORTED_ATTACHMENT');
      const file=await realpath(attachment.path),directory=path.join(this.home,'media');
      if(!file.startsWith(directory+path.sep))throw channelFault('CHANNEL_UNSUPPORTED_ATTACHMENT');
      const info=await lstat(attachment.path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw channelFault('CHANNEL_UNSUPPORTED_ATTACHMENT');
      if((total+=info.size)>10*1024*1024)throw channelFault('CHANNEL_ATTACHMENT_LIMIT');
      safe.attachments.push({path:file,mime:attachment.mime});
    }
    const accepted=this.store.accept(safe);
    if(['dingtalk','wecom'].includes(this.platform))this.store.db.prepare("UPDATE outbox SET next_retry=0 WHERE binding=? AND status='pending' AND error='CHANNEL_REPLY_WINDOW'").run(accepted.binding);
    this.tick();return {accepted:true,duplicate:accepted.duplicate};
  }
  async command(row,command){
    this.store.updateInbox(row.id,{status:'command'});
    const binding=this.store.binding(row.binding),active=this.store.active(row.binding),session=binding?this.host.state.sessions.find(s=>s.id===binding.session_id):null;
    let reply='channelNoTask';
    if(command==='/status'){reply=this.text('channelStatus',{status:this.text('channelRun_'+(session?.runRecovery?.status??'idle'))});this.store.finish(row,reply);return;}
    if(command==='/stop'){
      this.store.pauseBinding(row.binding);
      if(session)await this.host.taskRecovery.stop(session);
      if(active)this.store.updateInbox(active.id,{status:'paused'});
      reply='channelStopped';
    }else if(command==='/new'){
      if(active&&['running','starting','creating'].includes(active.status))reply='channelNeedStop';
      else{
        let verified=true;
        if(session&&['running','waiting','uncertain'].includes(session.runRecovery?.status)){
          try{const native=await this.host.requireEngine(session).readTurnState(session.id,session.runRecovery.turnId);verified=native.known&&native.turnId===session.runRecovery.turnId&&['completed','failed','interrupted'].includes(native.status);}catch{verified=false;}
        }
        if(!verified)reply='CHANNEL_EXECUTION_UNCERTAIN';
        else{if(active)this.store.updateInbox(active.id,{status:'stopped'});this.store.db.prepare('DELETE FROM bindings WHERE id=?').run(row.binding);reply='channelNew';}
      }
    }else if(command==='/resume'&&session&&active){
      if(session.runRecovery?.id!==active.run_id){this.store.finish(row,this.text('CHANNEL_EXECUTION_UNCERTAIN'));return;}
      this.store.db.prepare('UPDATE bindings SET paused=0 WHERE id=?').run(row.binding);this.store.updateInbox(active.id,{status:'running'});
      try{await this.host.taskRecovery.resume(session,this.config.locale);this.store.updateInbox(active.id,{run_id:session.runRecovery.id});reply=this.text('channelStatus',{status:this.text('channelRun_'+session.runRecovery.status)});}
      catch(error){this.store.updateInbox(active.id,{status:'paused',error:'CHANNEL_EXECUTION_UNCERTAIN'});reply='CHANNEL_EXECUTION_UNCERTAIN';}
      this.store.finish(row,this.text(reply));return;
    }
    this.store.finish(row,this.text(reply));
  }
  tick(){
    if(this.closed||this.stopping||this.storageFailed||this.ticking)return;
    const operation=this.work().catch(error=>{this.error=knownCode(error);if(['CHANNEL_STORAGE_FAILED','CHANNEL_STORAGE_UNSAFE'].includes(this.error)){this.state='error';this.storageFailed=true;void this.stopWorker().catch(()=>{});}}).finally(()=>{this.ticking=null;});this.ticking=operation;
  }
  async work(){
    if(this.qrSession&&Date.now()>=this.qrSession.expiresAt)await this.qrCancel(this.qrSession.id);
    if(!this.config?.enabled)return;
    if(!this.lastPrune||Date.now()-this.lastPrune>3600000){this.store.prune();this.lastPrune=Date.now();}
    if(!this.worker&&Date.now()>=this.nextConnect){this.state='connecting';await this.sequence(()=>this.createWorker()).catch(()=>{});}
    if(this.closed||this.stopping||!this.config?.enabled)return;
    if(this.worker&&(!this.lastHealth||Date.now()-this.lastHealth>10000)){
      this.lastHealth=Date.now();try{const health=await this.worker.request('status');if(health.fatal){if(['CHANNEL_QR_REQUIRED','CHANNEL_CONNECTION_CONFLICT'].includes(health.fatalCode)){this.config={...this.config,enabled:false};this.store.saveConfig(this.config);await this.stopWorker();this.state='error';this.error=health.fatalCode;this.nextConnect=0;return;}await this.stopWorker();this.scheduleReconnect('CHANNEL_CONNECTION_FAILED');}else if(!health.connected){this.state='retrying';this.offlineSince??=Date.now();if(Date.now()-this.offlineSince>=30000){await this.stopWorker();this.offlineSince=null;this.scheduleReconnect('CHANNEL_CONNECTION_FAILED');}}else{this.state='connected';this.offlineSince=null;if(health.rejected)this.error='CHANNEL_INBOUND_REJECTED';}}catch{await this.stopWorker();this.scheduleReconnect('CHANNEL_PROCESS_EXITED');}
    }
    for(const row of this.store.rows(['running','paused'],2000)){
      if(this.closed||this.stopping)return;
      const session=this.host.state.sessions.find(s=>s.id===row.session_id),run=session?.runRecovery;
      if(!session||!run||run.id!==row.run_id){this.store.updateInbox(row.id,{status:'unknown',error:'CHANNEL_EXECUTION_UNCERTAIN'});continue;}
      if(row.status==='paused'&&run.status!=='completed'&&(run.userStopped||['failed','interrupted'].includes(run.status)))continue;
      if(row.status==='paused')this.store.updateInbox(row.id,{status:'running'});
      if(run.status==='completed'){
        try{const transcript=await this.host.readTranscript(session,this.config.locale);const text=transcript.items.filter(item=>item.turnId===run.turnId&&item.type==='agentMessage'&&item.phase!=='commentary').map(item=>item.text??'').join('\n\n');this.store.finish(row,text||this.text('channelDone'));}
        catch(error){if(error.code==='CHANNEL_RESPONSE_LIMIT')this.store.finish(row,this.text(error.code));}
      }else if(['failed','interrupted'].includes(run.status))this.store.finish(row,this.text('channelPaused'),'paused','paused');
      else if(run.status==='uncertain'&&run.reason==='start_unverified')this.store.updateInbox(row.id,{status:'unknown',error:'CHANNEL_EXECUTION_UNCERTAIN'});
    }
    // Commands must bypass a running conversation; ordinary messages queue per binding.
    const queued=this.store.rows(['accepted'],2000);
    for(const row of queued.filter(row=>commands.has(row.message.text.trim()))){
      if(this.closed||this.stopping)return;try{await this.command(row,row.message.text.trim());}catch(error){this.store.updateInbox(row.id,{status:'unknown',error:knownCode(error)});}
    }
    if(this.host.hasFeature('feature-chat')){
      for(const row of this.store.rows(['accepted'],25)){
        if(this.closed||this.stopping||!this.config?.enabled)break;
        if(commands.has(row.message.text.trim())){try{await this.command(row,row.message.text.trim());}catch(error){this.store.updateInbox(row.id,{status:'unknown',error:knownCode(error)});}continue;}
        if(this.store.active(row.binding)||this.store.binding(row.binding)?.paused)continue;
        await this.execute(row);
      }
    }
    if(this.worker?.connected){
      for(const row of this.store.deliveries()){
        if(this.closed||this.stopping||!this.config?.enabled||!this.worker?.connected)break;
        this.store.updateDelivery(row.id,{status:'sending',attempts:row.attempts+1});
        try{const result=await this.worker.request('send',row.message,30000);if(result.success)this.store.updateDelivery(row.id,{status:'delivered',remote_id:result.messageId??null,error:null});
          else if(result.delivery==='not_sent')this.store.updateDelivery(row.id,{status:'pending',next_retry:Date.now()+Math.min(300000,5000*2**Math.min(row.attempts,8)),error:['CHANNEL_REPLY_WINDOW','CHANNEL_RATE_LIMIT'].includes(result.code)?result.code:'CHANNEL_OFFLINE'});
          else this.store.updateDelivery(row.id,{status:'unknown',error:'CHANNEL_DELIVERY_UNCERTAIN'});
        }catch{this.store.updateDelivery(row.id,{status:'unknown',error:'CHANNEL_DELIVERY_UNCERTAIN'});}
      }
    }
  }
  async execute(row){
    this.executions??=new Set();this.executions.add(row.id);try{
    let engine,project;try{engine=this.host.requireEngine();project=this.config.projectId==null?null:this.host.getProject(this.config.projectId);}catch{return;}
    let session;const binding=this.store.binding(row.binding);
    if(binding){session=this.host.state.sessions.find(s=>s.id===binding.session_id);if(!session||session.archived||session.projectId!==(project?.id??null)){this.store.updateInbox(row.id,{status:'unknown',error:'CHANNEL_EXECUTION_UNCERTAIN'});return;}if(engine.activeTurns.has(session.id)||['running','waiting','uncertain'].includes(session.runRecovery?.status))return;}
    const inputs=[];
    if(row.message.text.trim())inputs.push({type:'text',text:row.message.text,text_elements:[]});
    for(const attachment of row.message.attachments){
      const info=await lstat(attachment.path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(attachment.path)!==attachment.path||info.size>10*1024*1024)throw channelFault('CHANNEL_UNSUPPORTED_ATTACHMENT');
      if(attachment.mime.startsWith('image/'))inputs.push({type:'localImage',path:attachment.path});
      else if(attachment.mime.startsWith('text/')||['application/json'].includes(attachment.mime)){
        const bytes=await readFile(attachment.path);if(bytes.length>200000){this.store.finish(row,this.text('CHANNEL_UNSUPPORTED_ATTACHMENT'),'rejected');return;}
        let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{this.store.finish(row,this.text('CHANNEL_UNSUPPORTED_ATTACHMENT'),'rejected');return;}
        inputs.push({type:'text',text,text_elements:[]});
      }else{this.store.finish(row,this.text('channelUnsupported'),'rejected');return;}
    }
    if(!inputs.length){this.store.finish(row,this.text('channelUnsupported'),'rejected');return;}
    try{
      if(!session){
        this.store.updateInbox(row.id,{status:'creating'});
        const id=randomUUID(),cwd=await this.host.ensureSessionWorkspace({id,projectId:project?.id??null}),mapped=await engine.createSession(id,{cwd,model:this.config.model});
        session={id,projectId:project?.id??null,engineId:this.host.getSelectedEngine(),kind:'chat',channel:{platform:this.platform,binding:row.binding,chatType:row.message.chatType,peer:row.message.senderName||row.message.senderId,chat:row.message.chatName||row.message.chatId},model:mapped.model,threadId:mapped.threadId,instructionProfile:mapped.instructionProfile??null,title:(row.message.chatType==='dm'?(row.message.senderName||row.message.senderId):(row.message.chatName||row.message.chatId)+' · '+(row.message.senderName||row.message.senderId)).slice(0,100),archived:false,pinned:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        this.host.state.sessions.unshift(session);this.host.transcripts.set(id,[]);await this.host.save();this.store.bind(row.binding,id);this.host.broadcastState();
      }
      if(this.closed||this.stopping||!this.config?.enabled){this.store.updateInbox(row.id,{status:'accepted',session_id:session.id});return;}
      this.store.updateInbox(row.id,{status:'starting',session_id:session.id});
      await this.host.taskRecovery.start(session,inputs,{sandbox:this.config.permission,effort:'high'},()=>{
        if(this.closed||this.stopping||!this.config?.enabled)throw channelFault('CHANNEL_STOPPED');
        this.store.updateInbox(row.id,{status:'running',run_id:session.runRecovery.id});
        return engine.startTurn(session.id,inputs,{sandbox:this.config.permission,effort:'high'});
      });
      this.store.updateInbox(row.id,{turn_id:session.runRecovery?.turnId??null});
    }catch(error){
      const current=this.store.inbox(row.id);
      if(current.run_id&&session?.runRecovery?.id===current.run_id)return;
      this.store.updateInbox(row.id,{status:'unknown',error:'CHANNEL_EXECUTION_UNCERTAIN'});
    }
    }finally{this.executions.delete(row.id);}
  }
  async deliveryAction(id,action){return this.sequence(async()=>{const row=this.store.delivery(id);if(!row)throw channelFault('CHANNEL_NOT_FOUND');if(row.status==='sending')throw channelFault('CHANNEL_BUSY');if(action==='retry'&&row.status==='unknown')this.store.updateDelivery(id,{status:'pending',next_retry:0,error:null});else if(action==='delivered')this.store.updateDelivery(id,{status:'delivered',error:null});else if(action==='drop')this.store.updateDelivery(id,{status:'delivered',error:'CHANNEL_DELIVERY_DROPPED'});else throw channelFault('CHANNEL_INVALID_CONFIG');return this.snapshot();});}
  activities(){return [...[...(this.executions??[])].map(id=>({id:id+'-admission',kind:'unknown',count:1})),...this.store.rows(['creating','starting','running'],100).map(row=>({id:row.id,kind:'unknown',count:1})),...(this.config?.enabled?[{id:this.platform+'-connection',kind:'unknown',count:1}]:[])];}
  async close(){
    if(this.closed)return;if(this.closing)return this.closing;this.stopping=true;clearInterval(this.timer);
    this.closing=(async()=>{
      await this.stopWorker();
      await Promise.allSettled([...this.operations]);
      if(this.ticking)await this.ticking;
      await this.serial;
      for(const row of this.store.rows(['running'],100)){
        const session=this.host.state.sessions.find(s=>s.id===row.session_id);if(session)await this.host.taskRecovery.stop(session,'channel_disabled');
      }
      const deadline=Date.now()+10000;
      while(this.store.rows(['running'],100).some(row=>{try{return this.host.requireEngine().activeTurns.has(row.session_id);}catch{return false;}})){
        if(Date.now()>deadline)throw channelFault('CHANNEL_STOP_UNCONFIRMED');await wait(50);
      }
      this.store.close();this.closed=true;
    })().catch(error=>{this.closing=null;throw error;});return this.closing;
  }
}
