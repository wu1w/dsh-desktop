// Restart only the local execution service. User messages and approvals are
// never replayed by this supervisor.
export class EngineSupervisor {
  constructor({restart,allowed=()=>true,onChange=()=>{},baseDelayMs=1000,maxDelayMs=30000,stableMs=60000,now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}) {
    Object.assign(this,{restart,allowed,onChange,baseDelayMs,maxDelayMs,stableMs,now,setTimer,clearTimer});
    this.attempt=0;this.generation=0;this.timer=null;this.stableTimer=null;this.closed=false;this.current={status:'idle',attempt:0,nextRetryAt:null};
  }
  snapshot(){return {...this.current};}
  _publish(status,nextRetryAt=null){this.current={status,attempt:this.attempt,nextRetryAt};if(!this.closed)this.onChange(this.snapshot());}
  cancel(){this.generation++;this.clearTimer(this.timer);this.clearTimer(this.stableTimer);this.timer=null;this.stableTimer=null;this.attempt=0;this._publish('idle');}
  healthy(){
    this.clearTimer(this.timer);this.timer=null;this.clearTimer(this.stableTimer);this._publish('idle');
    const generation=this.generation;
    this.stableTimer=this.setTimer(()=>{if(generation!==this.generation||this.closed)return;this.stableTimer=null;this.attempt=0;this._publish('idle');},this.stableMs);this.stableTimer?.unref?.();
  }
  failed(){
    if(this.closed||this.timer||!this.allowed())return;
    this.clearTimer(this.stableTimer);this.stableTimer=null;
    const generation=this.generation,delay=Math.min(this.maxDelayMs,this.baseDelayMs*2**Math.min(this.attempt,20));
    this.attempt=Math.min(Number.MAX_SAFE_INTEGER,this.attempt+1);this._publish('waiting',new Date(this.now()+delay).toISOString());
    this.timer=this.setTimer(async()=>{
      this.timer=null;if(this.closed||generation!==this.generation||!this.allowed())return;
      this._publish('restarting');
      try{await this.restart();if(!this.closed&&generation===this.generation&&this.allowed())this.healthy();}
      catch{if(!this.closed&&generation===this.generation)this.failed();}
    },delay);this.timer?.unref?.();
  }
  close(){this.closed=true;this.cancel();}
}
