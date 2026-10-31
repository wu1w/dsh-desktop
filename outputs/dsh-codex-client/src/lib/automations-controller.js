export class AutomationsController {
  constructor({request,onChange=()=>{}}){this.request=request;this.onChange=onChange;this.epoch=0;this.state={automations:[],loading:false,pending:false,error:null};}
  publish(patch){Object.assign(this.state,patch);this.onChange({...this.state});}
  async load({quiet=false}={}){
    const epoch=this.epoch,revision=this.revision=(this.revision??0)+1;if(!quiet)this.publish({loading:true,error:null});
    try{const data=await this.request('automations');if(epoch===this.epoch&&revision===this.revision)this.publish({...data,loading:false,error:null});return data;}
    catch(error){if(epoch===this.epoch&&revision===this.revision)this.publish({loading:false,error});return null;}
  }
  async mutate(id,action,body={}){
    if(this.state.pending)return null;const epoch=this.epoch;this.publish({pending:true,error:null});
    try{const result=await this.request('automations'+(id?'/'+encodeURIComponent(id)+'/'+action:''),body);if(epoch!==this.epoch)return null;await this.load({quiet:true});return result;}
    catch(error){if(epoch===this.epoch)this.publish({error});return null;}
    finally{if(epoch===this.epoch)this.publish({pending:false});}
  }
  dispose(){this.epoch++;}
}

export function automationDraft(task,state){
  return {title:task?.title??'',projectId:task?.projectId??state.projects?.[0]?.id??'',prompt:task?.prompt??'',engineId:task?.engineId??state.selectedEngine??'codex',model:task?.model??'deepseek-v4.1-flash',effort:task?.effort??'high',permission:task?.permission??'read-only',scheduleType:task?.schedule?.type??'interval',minutes:String(task?.schedule?.minutes??60),time:task?.schedule?.time??'09:00'};
}
export function automationPayload(draft){
  if(!draft.title.trim()||!draft.projectId||!draft.prompt.trim()||new TextEncoder().encode(draft.prompt).length>16000||!draft.engineId||!draft.model||!['low','high','max'].includes(draft.effort)||!['read-only','workspace-write'].includes(draft.permission))throw Object.assign(Error('INVALID_AUTOMATION'),{code:'INVALID_AUTOMATION'});
  const minutes=Number(draft.minutes);
  if(draft.scheduleType==='interval'&&(!Number.isInteger(minutes)||minutes<15||minutes>10080))throw Object.assign(Error('INVALID_AUTOMATION'),{code:'INVALID_AUTOMATION'});
  if(draft.scheduleType==='daily'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time))throw Object.assign(Error('INVALID_AUTOMATION'),{code:'INVALID_AUTOMATION'});
  return{title:draft.title.trim(),projectId:draft.projectId,prompt:draft.prompt.trim(),engineId:draft.engineId,model:draft.model,effort:draft.effort,permission:draft.permission,schedule:draft.scheduleType==='daily'?{type:'daily',time:draft.time}:{type:'interval',minutes}};
}
