import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {channelFault} from './channel-store.mjs';

export class ChannelProcess extends EventEmitter{
  constructor({root,home,platform,locale,onIncoming,spawnProcess=spawn}){super();Object.assign(this,{root,home,platform,locale,onIncoming,spawnProcess});this.pending=new Map();this.child=null;this.stopping=false;this.connected=false;}
  async start(config,{connect=true}={}){
    const python=path.join(this.root,'python/runtime/bin/python3');await access(python);await access(path.join(this.root,'bridge.py'));
    if(this.child)throw channelFault('CHANNEL_BUSY');
    this.stopping=false;this.buffer='';this.decoder=new StringDecoder('utf8');this.child=this.spawnProcess(python,['-I','-B','-u',path.join(this.root,'bridge.py')],{cwd:this.root,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:this.home,TMPDIR:this.home,DSH_CHANNEL_HOME:this.home,DSH_LOCALE:this.locale,...Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))}});
    const child=this.child;
    this.exited=new Promise(resolve=>{this.resolveExit=resolve;});
    const ready=new Promise((resolve,reject)=>{this.ready={resolve,reject};});
    child.stdout.on('data',data=>this._data(child,data));child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>{if(this.child===child){this.connected=false;this._rejectAll('CHANNEL_PROCESS_EXITED');}});
    child.on('error',()=>{if(child.pid==null)this._exit(child);});child.once('exit',()=>this._exit(child));
    const timer=setTimeout(()=>{this.ready?.reject(channelFault('CHANNEL_RUNTIME_TIMEOUT'));},15000);
    try{await ready;await this.request('configure',{platform:this.platform,...config});if(connect){const result=await this.request('connect',{},50000);this.connected=result.connected;return result;}return {configured:true};}
    catch(error){await this.stop().catch(()=>{});throw error;}
    finally{clearTimeout(timer);this.ready=null;}
  }
  _rejectAll(code){this.ready?.reject(channelFault(code));for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(channelFault(code));}this.pending.clear();}
  _exit(child){if(child!==this.child)return;this.child=null;this.connected=false;this._rejectAll('CHANNEL_PROCESS_EXITED');this.resolveExit?.();this.emit('exit');}
  _data(child,data){
    if(child!==this.child)return;this.buffer+=this.decoder.write(data);
    if(Buffer.byteLength(this.buffer)>2*1024*1024){this._rejectAll('CHANNEL_PROTOCOL_LIMIT');void this.stop().catch(()=>{});return;}
    for(;;){const index=this.buffer.indexOf('\n');if(index<0)break;const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);let message;try{message=JSON.parse(line);}catch{this._rejectAll('CHANNEL_PROTOCOL_FAILED');void this.stop().catch(()=>{});return;}
      if(message.event==='ready'){if(message.protocol===1)this.ready?.resolve();else this.ready?.reject(channelFault('CHANNEL_PROTOCOL_FAILED'));}
      else if(message.event==='status'){this.connected=message.state==='connected';this.emit('status',{state:message.state,code:message.code});}
      else if(message.event==='incoming'){
        if(this.stopping)continue;
        Promise.resolve().then(()=>this.onIncoming(message.message)).then(result=>{if(this.child===child&&!this.stopping)this._write({method:'incoming/ack',id:message.id,result});},()=>{if(this.child===child&&!this.stopping)this._write({method:'incoming/ack',id:message.id,result:{accepted:false}});}).catch(()=>{this.connected=false;void this.stop().catch(()=>{});});
      }else if(message.id){const pending=this.pending.get(message.id);if(!pending)continue;this.pending.delete(message.id);clearTimeout(pending.timer);if(message.error)pending.reject(channelFault(/^CHANNEL_[A-Z_]+$/.test(message.error.code)?message.error.code:'CHANNEL_RUNTIME_FAILED'));else pending.resolve(message.result);}
    }
  }
  _write(value){const line=JSON.stringify(value)+'\n';if(!this.child||this.child.stdin.destroyed)throw channelFault('CHANNEL_PROCESS_EXITED');if(Buffer.byteLength(line)>2*1024*1024||this.child.stdin.writableLength>2*1024*1024)throw channelFault('CHANNEL_BACKPRESSURE');this.child.stdin.write(line);}
  request(method,params={},timeout=15000){
    if(!this.child||this.stopping) return Promise.reject(channelFault('CHANNEL_OFFLINE'));
    if(this.pending.size>=32)return Promise.reject(channelFault('CHANNEL_BACKPRESSURE'));
    const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(channelFault('CHANNEL_RUNTIME_TIMEOUT'));},timeout);this.pending.set(id,{resolve,reject,timer});try{this._write({id,method,params});}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}});
  }
  async stop(){
    const child=this.child;if(!child)return;
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;this.connected=false;this._rejectAll('CHANNEL_STOPPED');
    this.stopPromise=(async()=>{
      child.stdin.end();
      let timer;const wait=ms=>Promise.race([this.exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]).finally(()=>clearTimeout(timer));
      if(!await wait(18000)){try{child.kill('SIGTERM');}catch{}if(!await wait(2000)){try{child.kill('SIGKILL');}catch{}if(!await wait(2000))throw channelFault('CHANNEL_STOP_UNCONFIRMED');}}
    })().finally(()=>{this.stopPromise=null;});return this.stopPromise;
  }
}
