import {randomUUID} from 'node:crypto';

const errorCode=error=>/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code??error?.message??'')?(error.code??error.message):'AUTOMATION_FAILED';

// Scheduled runs use the same actual engine and event pipeline as a chat. A
// successful start acknowledgement is never reported as a completed run.
export function createAutomationRunner({state,save,broadcastState,transcripts,getProject,requireEngine,getSelectedEngine,canChat=()=>true,maxRunMs=process.env.DSH_AUTOMATION_MAX_RUN_MS??0,clock={}}) {
  const runLimit=Number(maxRunMs);
  if(!Number.isSafeInteger(runLimit)||runLimit<0||runLimit>2147483647)throw Object.assign(Error('INVALID_AUTOMATION'),{code:'INVALID_AUTOMATION'});
  const setTimer=clock.setTimeout??setTimeout,clearTimer=clock.clearTimeout??clearTimeout;
  let reserved=false;
  const execute=async function runAutomation(task,{signal,onSession=async()=>{}}={}) {
    if(signal?.aborted)return{status:'cancelled',errorCode:'AUTOMATION_CANCELLED'};
    let engine,project;
    try{
      if(!canChat())throw Error('PLUGIN_DISABLED');
      if(!['low','high','max'].includes(task.effort)||!['read-only','workspace-write'].includes(task.permission)||!(state.models??[]).some(model=>model.id===task.model))throw Error('INVALID_AUTOMATION');
      if(task.engineId!==getSelectedEngine())throw Error('ENGINE_MISMATCH');
      project=getProject(task.projectId);engine=requireEngine();
      if(engine.activeTurns.size)throw Error('ENGINE_BUSY');
    }catch(error){return{status:'blocked',errorCode:errorCode(error)};}
    let session;
    try{
      const id=randomUUID(),mapped=await engine.createSession(id,{cwd:project.path,model:task.model});
      session={id,projectId:project.id,engineId:task.engineId,kind:'chat',automationId:task.id,model:mapped.model,instructionProfile:mapped.instructionProfile??null,title:task.title.slice(0,100),threadId:mapped.threadId,archived:false,pinned:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      state.sessions.unshift(session);transcripts.set(id,[]);await save();await onSession(id);broadcastState();
      if(signal?.aborted)return{sessionId:id,status:'cancelled',errorCode:'AUTOMATION_CANCELLED'};
    }catch(error){return{sessionId:session?.id,status:'failed',errorCode:errorCode(error)};}
    const id=session.id;let expectedTurn=null,settled=false,abortRequested=false,startAttempted=false;
    let resolveTerminal;
    const terminal=new Promise(resolve=>{resolveTerminal=resolve;});
    const finish=value=>{if(settled)return;settled=true;resolveTerminal({sessionId:id,...value});};
    const interrupt=()=>{
      abortRequested=true;
      if(engine.activeTurns.has(id))void engine.interrupt(id).catch(()=>{});
    };
    const notification=note=>{
      if(note.params?.threadId!==session.threadId)return;
      const turn=note.params.turn;
      if(note.method==='turn/started'&&!expectedTurn)expectedTurn=turn?.id??null;
      if(note.method!=='turn/completed'||!turn?.id||(expectedTurn&&turn.id!==expectedTurn))return;
      if(turn.status==='completed')finish({status:'completed'});
      else if(turn.status==='interrupted')finish({status:'cancelled',errorCode:abortRequested?'AUTOMATION_CANCELLED':'AUTOMATION_INTERRUPTED'});
      else if(turn.status==='failed')finish({status:'failed',errorCode:'AUTOMATION_FAILED'});
    };
    const exited=()=>finish({status:'unknown',errorCode:'AUTOMATION_ENGINE_EXITED'});
    engine.on('notification',notification);engine.on('exit',exited);signal?.addEventListener('abort',interrupt,{once:true});
    // Long runs have no implicit wall-clock limit. An explicitly configured
    // cap requests an interrupt; only the native terminal event ends the run.
    const timer=runLimit>0?setTimer(interrupt,runLimit):null;timer?.unref?.();
    try{
      if(signal?.aborted){finish({status:'cancelled',errorCode:'AUTOMATION_CANCELLED'});return await terminal;}
      if(!canChat())throw Error('PLUGIN_DISABLED');
      if(task.engineId!==getSelectedEngine()||engine!==requireEngine())throw Error('ENGINE_MISMATCH');
      getProject(task.projectId);
      if(!(state.models??[]).some(model=>model.id===task.model))throw Error('INVALID_AUTOMATION');
      if(engine.activeTurns.size)throw Error('ENGINE_BUSY');
      startAttempted=true;
      const started=await engine.startTurn(id,[{type:'text',text:task.prompt,text_elements:[]}],{sandbox:task.permission,effort:task.effort});
      expectedTurn??=started?.turn?.id??null;
      if(signal?.aborted||abortRequested)interrupt();
      return await terminal;
    }catch(error){
      // A start error can be ambiguous. Preserve the chat; never retry the
      // prompt automatically after an interrupted connection.
      const code=errorCode(error);
      return{sessionId:id,status:startAttempted?'unknown':['PLUGIN_DISABLED','ENGINE_MISMATCH','ENGINE_BUSY','ENGINE_DISABLED','INVALID_AUTOMATION','NOT_FOUND'].includes(code)?'blocked':'failed',errorCode:code};
    }finally{
      if(timer!==null)clearTimer(timer);engine.off('notification',notification);engine.off('exit',exited);signal?.removeEventListener('abort',interrupt);
    }
  };
  return async function runAutomation(...args){
    // Reserve before the first await, including native creation and durable
    // binding, so simultaneous schedule claims cannot both see an idle engine.
    if(reserved)return{status:'blocked',errorCode:'ENGINE_BUSY'};
    reserved=true;try{return await execute(...args);}finally{reserved=false;}
  };
}
