export class TerminalController {
  constructor({request,onChange=()=>{},onOutput=()=>{},schedule=(...args)=>globalThis.setTimeout(...args),cancel=(...args)=>globalThis.clearTimeout(...args)}) {
    Object.assign(this,{request,onChange,onOutput,schedule,cancel});this.epoch=0;this.projectEpoch=0;this.state={projectId:null,terminals:[],selected:null,busy:false,error:null};this.inputTail=Promise.resolve();this.pendingInput=0;
  }
  publish(patch={}){Object.assign(this.state,patch);this.onChange({...this.state});}
  route(id=this.state.selected){return `projects/${encodeURIComponent(this.state.projectId)}/pty${id?'/'+encodeURIComponent(id):''}`;}
  stopPolling(){this.epoch++;this.abort?.abort();this.cancel(this.timer);this.cancel(this.resizeTimer);}
  async project(id){
    this.stopPolling();const projectEpoch=++this.projectEpoch;this.publish({projectId:id,terminals:[],selected:null,terminal:null,busy:Boolean(id),error:null,inputError:null,resizeError:null});this.onOutput('',{reset:true});if(!id)return;
    try{const result=await this.request(this.route(null));if(projectEpoch!==this.projectEpoch)return;this.publish({terminals:result.terminals??[],busy:false});const available=(result.terminals??[]).filter(row=>row.status==='running');if(available.length)this.select(available[0].id);}
    catch(error){if(projectEpoch===this.projectEpoch)this.publish({busy:false,error});}
  }
  async create({cols=90,rows=12}={}){
    if(!this.state.projectId||this.state.busy)return;
    const projectEpoch=this.projectEpoch,route=this.route(null);this.publish({busy:true,error:null});
    try{
      // Do not abort creation: a late server-created shell must be explicitly
      // stopped if its initiating panel/project has gone away.
      const terminal=await this.request(route,{cols,rows});
      if(projectEpoch!==this.projectEpoch){await this.request(route+'/'+encodeURIComponent(terminal.id)+'/stop',{}).catch(()=>{});return;}
      this.publish({busy:false,terminals:[...this.state.terminals,terminal]});this.select(terminal.id);
    }catch(error){if(projectEpoch===this.projectEpoch)this.publish({busy:false,error});}
  }
  select(id){
    this.stopPolling();this.cursor=0;this.publish({selected:id,terminal:this.state.terminals.find(row=>row.id===id)??null,error:null,inputError:null,resizeError:null});this.onOutput('',{reset:true});if(id)void this.poll(this.epoch);
  }
  async poll(epoch){
    if(epoch!==this.epoch||!this.state.selected)return;
    this.abort=new AbortController();
    try{
      const result=await this.request(this.route()+'?after='+this.cursor,undefined,{signal:this.abort.signal});
      if(epoch!==this.epoch)return;
      if(!Number.isSafeInteger(result.nextCursor)||result.nextCursor<this.cursor)throw Object.assign(Error('PTY_PROTOCOL'),{code:'PTY_PROTOCOL'});
      if(result.output||result.truncated)this.onOutput(result.output??'',{reset:Boolean(result.truncated),truncated:Boolean(result.truncated)});
      this.cursor=result.nextCursor;
      this.publish({terminal:result,error:result.error?Object.assign(Error(result.error),{code:result.error}):null,terminals:this.state.terminals.map(row=>row.id===result.id?{...row,...result,output:undefined}:row)});
      if(result.status==='exited')return;
      this.timer=this.schedule(()=>this.poll(epoch),result.output?100:250);
    }catch(error){if(epoch!==this.epoch||error.name==='AbortError')return;this.publish({error});this.timer=this.schedule(()=>this.poll(epoch),1500);}
  }
  input(data){
    if(!data||!this.state.selected||this.state.terminal?.status!=='running')return Promise.resolve(false);
    const size=new TextEncoder().encode(data).length;
    if(size>65536||this.pendingInput+size>65536){this.publish({inputError:Object.assign(Error('PTY_INPUT_LIMIT'),{code:'PTY_INPUT_LIMIT'})});return Promise.resolve(false);}
    const epoch=this.epoch,route=this.route()+'/input';this.pendingInput+=size;
    // A failed chunk is not retried: doing so could execute the same command
    // twice. All remaining chunks from that input are left unsent.
    const run=this.inputTail.then(async()=>{
      if(epoch!==this.epoch)return false;let chunk='',bytes=0;
      const send=async()=>{if(epoch!==this.epoch)throw Object.assign(Error('PTY_INPUT_CANCELLED'),{code:'PTY_INPUT_CANCELLED'});await this.request(route,{data:chunk});chunk='';bytes=0;};
      for(const point of data){const length=new TextEncoder().encode(point).length;if(bytes+length>8192)await send();chunk+=point;bytes+=length;}
      if(chunk)await send();if(epoch===this.epoch)this.publish({inputError:null});return true;
    });
    this.inputTail=run.catch(()=>{});
    return run.catch(error=>{if(epoch===this.epoch)this.publish({inputError:error});return false;}).finally(()=>{this.pendingInput-=size;});
  }
  resize(cols,rows){
    if(!this.state.selected||this.state.terminal?.status!=='running')return;this.cancel(this.resizeTimer);const epoch=this.epoch,route=this.route()+'/resize';
    this.resizeTimer=this.schedule(()=>{if(epoch===this.epoch)void this.request(route,{cols,rows}).then(()=>{if(epoch===this.epoch)this.publish({resizeError:null});},error=>{if(epoch===this.epoch)this.publish({resizeError:error});});},100);
  }
  async stop(){
    if(!this.state.selected||this.state.busy)return;const route=this.route()+'/stop';this.stopPolling();const epoch=this.epoch;this.publish({busy:true,error:null});
    try{await this.request(route,{});if(epoch===this.epoch){this.publish({busy:false});this.cancel(this.timer);void this.poll(epoch);}}
    catch(error){if(epoch===this.epoch)this.publish({busy:false,error});}
  }
  dispose(){this.projectEpoch++;this.stopPolling();}
}
