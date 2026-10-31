import React,{useEffect,useState} from 'react';
import {Plus,Play,Trash2,RefreshCw,ExternalLink,LoaderCircle} from 'lucide-react';
import {api} from '../api.js';
import {AutomationsController,automationDraft,automationPayload} from '../lib/automations-controller.js';
import './local-tools.css';

export function AutomationsPanel({state,t,locale,onOpenChat}){
  const [snapshot,setSnapshot]=useState({automations:[],loading:true}),[selected,setSelected]=useState(null),[draft,setDraft]=useState(()=>automationDraft(null,state)),[dirty,setDirty]=useState(false),[formError,setFormError]=useState('');
  const [controller]=useState(()=>new AutomationsController({request:(route,body)=>api(route,body),onChange:setSnapshot}));
  useEffect(()=>{void controller.load();const timer=setInterval(()=>void controller.load({quiet:true}),2000);return()=>{clearInterval(timer);controller.dispose();};},[]);
  const task=snapshot.automations.find(row=>row.id===selected),running=task?.lastStatus==='running'||task?.runs?.some(run=>run.status==='running'),pending=snapshot.pending;
  const change=(key,value)=>{setDraft(old=>({...old,[key]:value}));setDirty(true);setFormError('');};
  const choose=row=>{if(dirty&&!window.confirm(t('automationDiscard')))return;setSelected(row?.id??null);setDraft(automationDraft(row,state));setDirty(false);setFormError('');};
  const date=value=>{if(!value)return'—';const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'—':new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(parsed);};
  const status=value=>t('automationStatus_'+(value??'paused'));
  const engineName=id=>{const key='engineName_'+id.replaceAll('-','_'),name=t(key);return name===key?id:name;};
  async function save(event){event.preventDefault();let payload;try{payload=automationPayload(draft);}catch{setFormError(t('automationInvalid'));return;}const result=await controller.mutate(selected,'update',payload);if(result?.automation){setSelected(result.automation.id);setDraft(automationDraft(result.automation,state));setDirty(false);}}
  const providers=(state.engineProviders??[]).filter(row=>(state.plugins??[]).some(plugin=>plugin.id===row.pluginId&&plugin.active));
  return <div className="automations-surface">
    <p className="local-tool-note automation-disclosure">{t('automationLocalHelp')}</p>
    <div className="automation-toolbar"><button type="button" className="subtle-button" onClick={()=>choose(null)} disabled={pending}><Plus size={14}/>{t('automationNew')}</button><button type="button" className="icon-button" aria-label={t('refresh')} disabled={pending||snapshot.loading} onClick={()=>controller.load()}><RefreshCw size={14}/></button></div>
    {snapshot.error?<p className="local-tool-error" role="alert">{snapshot.error.message}</p>:null}
    <div className="automation-layout"><nav aria-label={t('automation')} className="automation-list">
      {snapshot.loading&&!snapshot.automations.length?<p className="local-tool-note" role="status">{t('loading')}</p>:null}
      {!snapshot.loading&&!snapshot.automations.length?<p className="local-tool-note">{t('automationEmpty')}</p>:null}
      {snapshot.automations.map(row=><button className={selected===row.id?'selected':''} type="button" key={row.id} onClick={()=>choose(row)}><strong>{row.title}</strong><span>{status(row.lastStatus??(row.enabled?'scheduled':'paused'))}</span><small>{row.enabled?t('automationNext',{time:date(row.nextRunAt)}):t('automationPaused')}</small></button>)}
    </nav><div className="automation-editor"><form className="dialog-form" onSubmit={save}>
      <div className="automation-editor-heading"><h3>{task?t('automationEdit'):t('automationNew')}</h3>{task?<label className="automation-toggle"><input type="checkbox" checked={Boolean(task.enabled)} disabled={pending||dirty||(running&&!task.enabled)} onChange={event=>controller.mutate(task.id,'update',{enabled:event.target.checked})}/>{t('automatic')}</label>:null}</div>
      {task?<p className="local-tool-note">{task.enabled?t('automationEnabledHelp'):t('automationEnableHelp')}</p>:null}
      <fieldset disabled={pending||running}>
        <label>{t('automationTitle')}<input required maxLength={100} value={draft.title} onChange={event=>change('title',event.target.value)}/></label>
        <label>{t('automationProject')}<select required value={draft.projectId} onChange={event=>change('projectId',event.target.value)}><option value="" disabled>{t('chooseProject')}</option>{state.projects.map(project=><option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        <label>{t('automationPrompt')}<textarea required rows={5} maxLength={16000} value={draft.prompt} onChange={event=>change('prompt',event.target.value)}/></label>
        <div className="automation-fields"><label>{t('engines')}<select value={draft.engineId} onChange={event=>change('engineId',event.target.value)}>{!providers.some(row=>row.id===draft.engineId)?<option value={draft.engineId}>{engineName(draft.engineId)}</option>:null}{providers.map(row=><option key={row.id} value={row.id}>{engineName(row.id)}</option>)}</select></label><label>{t('models')}<select value={draft.model} onChange={event=>change('model',event.target.value)}>{(state.models??[{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'}]).map(model=><option key={model.id} value={model.id}>{model.name}</option>)}</select></label></div>
        <div className="automation-fields"><label>{t('automationEffort')}<select value={draft.effort} onChange={event=>change('effort',event.target.value)}>{['low','high','max'].map(value=><option key={value} value={value}>{t(value)}</option>)}</select></label><label>{t('automationPermission')}<select value={draft.permission} onChange={event=>change('permission',event.target.value)}><option value="read-only">{t('readOnly')}</option><option value="workspace-write">{t('workspaceWrite')}</option></select></label></div>
        <div className="automation-fields"><label>{t('automationSchedule')}<select value={draft.scheduleType} onChange={event=>change('scheduleType',event.target.value)}><option value="interval">{t('automationInterval')}</option><option value="daily">{t('automationDaily')}</option></select></label>{draft.scheduleType==='daily'?<label>{t('automationLocalTime')}<input type="time" required value={draft.time} onChange={event=>change('time',event.target.value)}/></label>:<label>{t('automationMinutes')}<input type="number" required min={15} max={10080} step={1} value={draft.minutes} onChange={event=>change('minutes',event.target.value)}/></label>}</div>
      </fieldset>
      {draft.engineId!==state.selectedEngine?<p className="local-tool-note">{t('automationEngineHelp')}</p>:null}
      {formError?<p className="local-tool-error" role="alert">{formError}</p>:null}
      <div className="dialog-actions">{task?<button type="button" aria-label={t('remove')} disabled={pending||running} onClick={async()=>{if(window.confirm(t('automationDelete'))){const result=await controller.mutate(task.id,'delete');if(result){setSelected(null);setDraft(automationDraft(null,state));setDirty(false);}}}}><Trash2 size={14}/></button>:null}<button type="submit" className="primary-button" disabled={pending||running||(!dirty&&Boolean(task))}>{pending?<LoaderCircle size={13} className="spinner"/>:t(task?'save':'automationCreatePaused')}</button>{task?<button type="button" className="subtle-button" disabled={pending||running||dirty} onClick={()=>controller.mutate(task.id,'run')}><Play size={13}/>{t('automationRun')}</button>:null}</div>
    </form>
    {task?<section className="automation-runs"><h3>{t('automationHistory')}</h3>{!(task.runs??[]).length?<p className="local-tool-note">{t('automationNoRuns')}</p>:null}{[...(task.runs??[])].reverse().map(run=><div className="automation-run" key={run.id}><div><span>{status(run.status)}</span><small>{date(run.startedAt??run.claimedAt??run.at)}</small>{run.errorCode?<small>{t(run.errorCode)!==run.errorCode?t(run.errorCode):t('automationRunError',{code:run.errorCode})}</small>:null}</div>{run.sessionId?<button type="button" className="subtle-button" onClick={()=>onOpenChat(run.sessionId)}><ExternalLink size={13}/>{t('openChat')}</button>:null}</div>)}</section>:null}
    </div></div>
  </div>;
}
