const {activitySummary}=require('./support.cjs');

// The host remains alive while only its renderer is reloaded. Keep the crash
// budget across reloads; repeatedly broken application code must not spin.
class RendererRecovery {
  constructor({now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,delays=[250,1000,5000],windowMs=300000}={}) {
    this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;this.delays=delays;this.windowMs=windowMs;this.attempts=[];this.timer=null;
  }
  schedule(reload) {
    if(this.timer!==null)return true;
    const now=this.now();this.attempts=this.attempts.filter(at=>now-at<this.windowMs);
    if(this.attempts.length>=this.delays.length)return false;
    const delay=this.delays[this.attempts.length];this.attempts.push(now);
    this.timer=this.setTimer(()=>{this.timer=null;reload();},delay);this.timer?.unref?.();return true;
  }
  cancel() {if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
}

// prevent-app-suspension permits display sleep, screen locks and explicit
// system sleep. It only protects admitted work from idle system suspension.
class ActivityPowerGuard {
  constructor({blocker,readState,powerMonitor,setTimer=setTimeout,clearTimer=clearTimeout,pollMs=5000}) {
    this.blocker=blocker;this.readState=readState;this.powerMonitor=powerMonitor;this.setTimer=setTimer;this.clearTimer=clearTimer;this.pollMs=pollMs;this.id=null;this.timer=null;this.running=false;this.resume=()=>this.update();
  }
  update() {
    if(!this.running)return;
    try {
      const active=activitySummary(this.readState()).total>0;
      if(active&&(this.id===null||!this.blocker.isStarted(this.id)))this.id=this.blocker.start('prevent-app-suspension');
      else if(!active&&this.id!==null){this.blocker.stop(this.id);this.id=null;}
    }catch{/* Keep an existing guard if the activity snapshot is temporarily unavailable. */}
  }
  start() {
    if(this.running||!this.blocker)return;this.running=true;
    this.powerMonitor?.on('resume',this.resume);
    const tick=()=>{if(!this.running)return;this.update();this.timer=this.setTimer(tick,this.pollMs);this.timer?.unref?.();};tick();
  }
  stop() {
    this.running=false;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
    this.powerMonitor?.removeListener('resume',this.resume);
    if(this.id!==null){try{this.blocker.stop(this.id);}catch{/* OS cleanup failures must not strand a completed application quit. */}finally{this.id=null;}}
  }
}

module.exports={RendererRecovery,ActivityPowerGuard};
