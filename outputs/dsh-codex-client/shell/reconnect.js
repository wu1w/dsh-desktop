// One transport at a time. Reconnection never resends a user mutation.
export class ReconnectController {
  constructor({connect,onStatus=()=>{},onError=()=>{},baseDelayMs=1000,maxDelayMs=30000,random=Math.random,schedule=(fn,ms)=>globalThis.setTimeout(fn,ms),cancel=id=>globalThis.clearTimeout(id)}) {
    Object.assign(this,{connect,onStatus,onError,baseDelayMs,maxDelayMs,random,schedule,cancel});
    this.epoch=0;this.stopped=true;this.timer=null;this.controller=null;this.failures=0;this.status='idle';
  }
  _status(value){this.status=value;this.onStatus(value);}
  start(){if(!this.stopped)return;this.stopped=false;this.failures=0;void this._connect();}
  stop(){this.stopped=true;this.epoch++;this.cancel(this.timer);this.timer=null;this.controller?.abort();this.controller=null;}
  wake(){if(this.stopped||this.status==='connected'||this.controller)return;this.cancel(this.timer);this.timer=null;void this._connect();}
  async _connect(){
    if(this.stopped||this.controller)return;
    const epoch=++this.epoch,controller=this.controller=new AbortController();let openedAt=null;
    const current=()=>!this.stopped&&epoch===this.epoch&&!controller.signal.aborted;
    this._status(this.failures?'reconnecting':'connecting');
    try{await this.connect({signal:controller.signal,onOpen:()=>{if(current()){openedAt=Date.now();this._status('connected');}}});}
    catch(error){if(current())this.onError(error);}
    finally{
      if(this.controller===controller)this.controller=null;
      if(current()){
        controller.abort();this._status('reconnecting');
        if(openedAt!==null&&Date.now()-openedAt>=30000)this.failures=0;
        this.failures=Math.min(this.failures+1,30);
        const ceiling=Math.min(this.maxDelayMs,this.baseDelayMs*2**(this.failures-1)),delay=Math.round(ceiling*(0.75+this.random()*0.25));
        this.timer=this.schedule(()=>{this.timer=null;void this._connect();},delay);
      }
    }
  }
}
