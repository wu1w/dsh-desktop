const timestamp=value=>typeof value==='string'?Date.parse(value):typeof value==='number'&&Number.isFinite(value)?value:null;
const valid=value=>Number.isFinite(value)&&value>=0;
export function transcriptTurns(items,session={},running=false){
  const groups=[];let group=null,previousUser=null;const keys=new Set();
  for(const item of items){
    if(item.type==='userMessage'){
      groups.push({kind:'user',id:item.id,item});group=null;previousUser=item.id;continue;
    }
    if(!group||(item.turnId&&group.turnId&&item.turnId!==group.turnId)){
      const base=item.turnId??previousUser??item.id;let id=String(base);if(keys.has(id))id+=':'+item.id;keys.add(id);
      group={kind:'turn',id,turnId:item.turnId??null,items:[]};groups.push(group);
    }
    group.items.push(item);
  }
  const turns=groups.filter(row=>row.kind==='turn'),activeId=session.activeTurnId??session.runRecovery?.turnId;
  const last=turns.at(-1);
  for(const turn of turns){
    const latest=turn===last,ownsLatest=Boolean(turn.turnId&&activeId===turn.turnId)||(!activeId&&latest);
    turn.active=Boolean(running&&(activeId?turn.turnId===activeId:latest));
    const meta=turn.items.find(item=>valid(item.turnStartedAtMs));
    turn.startedAt=meta?.turnStartedAtMs??(ownsLatest?timestamp(session.startedAt):null);
    turn.completedAt=turn.items.find(item=>valid(item.turnCompletedAtMs))?.turnCompletedAtMs??(ownsLatest?timestamp(session.completedAt):null);
    turn.status=turn.active?'running':turn.items.findLast(item=>item.turnStatus&&item.turnStatus!=='inProgress')?.turnStatus??(ownsLatest?session.runRecovery?.status:null)??'completed';
    // Explicit phases win; legacy engines have one or more trailing answer
    // blocks. Earlier unphased messages are progress when followed by tools.
    const nonErrors=turn.items.filter(item=>item.type!=='error');let boundary=nonErrors.length;
    while(boundary>0&&nonErrors[boundary-1].type==='agentMessage'&&nonErrors[boundary-1].phase!=='commentary')boundary--;
    const answers=new Set(nonErrors.slice(boundary).map(item=>item.id));
    turn.answers=turn.items.filter(item=>item.type==='error'||item.type==='agentMessage'&&(item.phase==='final_answer'||answers.has(item.id)));
    const outside=new Set(turn.answers.map(item=>item.id));
    turn.process=turn.items.filter(item=>!outside.has(item.id)&&(item.type!=='reasoning'||item.text?.trim()));
  }
  if(running&&!turns.some(turn=>turn.active)){
    const id=activeId??'pending';groups.push({kind:'turn',id,turnId:activeId,items:[],process:[],answers:[],active:true,status:'running',startedAt:timestamp(session.startedAt),completedAt:null});
  }
  return groups;
}
export function processBlocks(items){
  const rows=[];let bundle=null;
  for(const item of items){
    if(item.type==='agentMessage'){rows.push({kind:'commentary',id:item.id,item});bundle=null;}
    else{if(!bundle){bundle={kind:'activity',id:item.id,items:[]};rows.push(bundle);}bundle.items.push(item);}
  }
  return rows;
}
export function activityKind(item){
  if(item.type==='reasoning')return 'thinking';
  if(item.type==='fileChange')return 'edit';
  if(item.activity)return item.activity;
  if(item.type==='commandExecution'){
    const name=(item.command??'').trim().split(/\s+/)[0].toLowerCase();
    if(['read','read_file','cat','head','tail'].includes(name))return 'read';
    if(['rg','grep','find','ls','glob','search'].includes(name))return 'search';
    return 'command';
  }
  return 'tool';
}
export function activityKinds(items){const kinds=[...new Set(items.map(activityKind))];return kinds.length>1?kinds.filter(kind=>kind!=='thinking'):kinds;}
export function elapsedText(start,end,locale,t){
  if(!valid(start)||!valid(end)||end<start)return null;
  const seconds=Math.floor((end-start)/1000),format=new Intl.NumberFormat(locale),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;
  return hours?t('processHours',{hours:format.format(hours),minutes:format.format(minutes),seconds:format.format(rest)}):minutes?t('elapsedMinutes',{minutes:format.format(minutes),seconds:format.format(rest)}):t('elapsedSeconds',{seconds:format.format(rest)});
}
