// Subscribe before refreshing. Only reads retry, with a finite budget per stream.
export class StreamRecovery {
  constructor({readState,applyState,getSelected,refreshSelected,onRestored=()=>{},onError=()=>{},onStatus=()=>{},timeoutMs=15000,maxRetries=3,retryBaseMs=1000,retryMaxMs=10000,schedule=(fn,ms)=>globalThis.setTimeout(fn,ms),cancel=id=>globalThis.clearTimeout(id)}) {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maxRetries)||maxRetries<0)throw new TypeError('INVALID_RECOVERY_TIMEOUT');
    Object.assign(this,{readState,applyState,getSelected,refreshSelected,onRestored,onError,onStatus,timeoutMs,maxRetries,retryBaseMs,retryMaxMs,schedule,cancel});
    this.stateRevision=0;this.sequence=0;this.active=null;
  }
  observeState(){this.stateRevision++;}
  stop(){const active=this.active;this.active=null;if(active){this.cancel(active.timer);this.cancel(active.retryTimer);active.abort?.abort();active.finish?.({aborted:true});}}
  opened(){this.stop();const token={id:++this.sequence,attempt:0};this.active=token;return this._attempt(token);}
  _attempt(token){
    const abort=token.abort=new AbortController(),revision=this.stateRevision;
    const current=()=>this.active===token&&token.abort===abort&&!abort.signal.aborted;
    this.onStatus({status:'syncing',attempt:token.attempt});
    const interrupted=new Promise(resolve=>{token.finish=resolve;token.timer=this.schedule(()=>{const error=Object.assign(new Error('STREAM_RECOVERY_TIMEOUT'),{code:'STREAM_RECOVERY_TIMEOUT'});abort.abort(error);resolve({aborted:false,errors:[error]});},this.timeoutMs);});
    const state=Promise.resolve().then(()=>current()?this.readState(abort.signal):undefined).then(value=>{if(current()&&revision===this.stateRevision)this.applyState(value);});
    const session=Promise.resolve().then(async()=>{if(!current())return;const id=this.getSelected();if(id)await this.refreshSelected(id,abort.signal);});
    const restored=Promise.resolve().then(()=>current()?this.onRestored({generation:token.id,signal:abort.signal}):undefined);
    const settled=Promise.allSettled([state,session,restored]).then(results=>({aborted:false,errors:results.filter(row=>row.status==='rejected').map(row=>row.reason)}));
    return Promise.race([settled,interrupted]).then(result=>{
      this.cancel(token.timer);token.timer=null;
      if(this.active!==token)return {aborted:true};
      if(result.errors?.length){
        this.onError(result.errors[0]);
        if(token.attempt<this.maxRetries){
          const delay=Math.min(this.retryMaxMs,this.retryBaseMs*2**token.attempt++);
          this.onStatus({status:'retrying',attempt:token.attempt});
          token.retryTimer=this.schedule(()=>{token.retryTimer=null;if(this.active===token)void this._attempt(token);},delay);
        }else this.onStatus({status:'failed',attempt:token.attempt});
      }else this.onStatus({status:'ready',attempt:token.attempt});
      return result;
    });
  }
}
