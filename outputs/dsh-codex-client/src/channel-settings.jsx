import React,{useEffect,useRef,useState} from 'react';
import {MessageCircle,Send,MessageSquare,MessagesSquare,Radio,ArrowUpRight,RefreshCw,Link2,Unplug,Check,Building2,Zap,QrCode,KeyRound,LoaderCircle} from 'lucide-react';
import {api} from './api.js';

export const channelPlatforms=['feishu','qq','weixin','dingtalk','wecom'];
export function ChannelMark({platform,t}){const Icon=platform==='feishu'?Send:platform==='qq'?MessageSquare:platform==='dingtalk'?Zap:platform==='wecom'?Building2:MessagesSquare;return <span className={`channel-mark channel-${platform}`} title={t('channel_'+platform)} aria-hidden="true"><Icon size={14}/></span>;}
export function ChannelSessions({sessions,renderSession,t,onSettings,locale}){
  const count=sessions.length;
  return <section className="im-sidebar"><div className="section-heading"><span><Radio size={12}/> {t('imConversations')}</span><button className="icon-button" aria-label={t('channels')} title={t('channels')} onClick={onSettings}><Link2 size={14}/></button></div>
    {count?channelPlatforms.map(platform=>{const rows=sessions.filter(s=>s.channel?.platform===platform);return rows.length?<details open className="im-platform" key={platform}><summary><ChannelMark platform={platform} t={t}/><span>{t('channel_'+platform)}</span><small>{new Intl.NumberFormat(locale).format(rows.length)}</small></summary>{rows.map(renderSession)}</details>:null;}):<button className="im-empty" onClick={onSettings}><MessageCircle size={16}/><span>{t('channelEmpty')}<small>{t('channelEmptyHint')}</small></span><ArrowUpRight size={13}/></button>}
  </section>;
}
function ChannelPanel({platform,t,locale,state,onOpenChat}){
  const supportsQr=['feishu','qq','weixin'].includes(platform);
  const [snapshot,setSnapshot]=useState(null),[form,setForm]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[qr,setQr]=useState(null),[notice,setNotice]=useState(''),[mode,setMode]=useState(supportsQr?'qr':'manual'),[qrStatus,setQrStatus]=useState('wait');
  const alive=useRef(true),pending=useRef(false),qrRef=useRef(null),qrCard=useRef(null);
  useEffect(()=>{if(qr)qrCard.current?.scrollIntoView({block:'nearest'});},[qr]);
  const enabled=state.features?.includes('channel-'+platform),route='channels/'+platform;
  function fill(data){const c=data.config;setForm({projectId:c?.projectId??'',model:c?.model??state.models?.[0]?.id??'',permission:c?.permission??'read-only',appId:c?.appId??'',secret:'',accountId:c?.accountId??'',token:'',allowedUsers:(c?.allowedUsers??[]).join('\n'),allowedGroups:(c?.allowedGroups??[]).join('\n')});}
  useEffect(()=>{alive.current=true;if(!enabled)return;const controller=new AbortController();let timer,initial=true;
    async function poll(){try{const data=await api(route,undefined,'GET',{signal:controller.signal});if(alive.current){setSnapshot(data);if(initial){fill(data);initial=false;}}}catch(e){if(alive.current&&!controller.signal.aborted)setError(e.message);}finally{if(!controller.signal.aborted)timer=setTimeout(poll,3000);}}
    void poll();return()=>{alive.current=false;clearTimeout(timer);controller.abort();if(qrRef.current)void api(route+'/qr/cancel',{id:qrRef.current.id}).catch(()=>{});};
  },[platform,enabled]);
  async function run(action){if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(e){if(alive.current)setError(e.message);}finally{pending.current=false;if(alive.current)setBusy(false);}}
  function setActiveQr(value){qrRef.current=value;setQr(value);}
  const update=(key,value)=>setForm(old=>({...old,[key]:value}));
  const payload=()=>({...form,projectId:form.projectId||null,locale,allowedUsers:form.allowedUsers.split(/[\n,]/).map(s=>s.trim()).filter(Boolean),allowedGroups:form.allowedGroups.split(/[\n,]/).map(s=>s.trim()).filter(Boolean)});
  const mutate=async(action,body={})=>{const data=await api(route+'/'+action,body);if(alive.current)setSnapshot(data);return data;};
  async function save(){const data=await mutate('configure',payload());if(alive.current)fill(data);return data;}
  async function cancelQr(){const value=qrRef.current;setActiveQr(null);if(value)await mutate('qr/cancel',{id:value.id});}
  useEffect(()=>{if(!qr)return;let cancelled=false,timer;
    async function poll(){if(cancelled)return;if(Date.now()>=qr.expiresAt){setActiveQr(null);setNotice(t('channelQrExpired'));void api(route+'/qr/cancel',{id:qr.id}).catch(()=>{});return;}
      try{const result=await api(route+'/qr/poll',{id:qr.id});if(cancelled)return;
        if(result.status==='confirmed'){setActiveQr(null);fill(result.channel);setSnapshot(result.channel);setNotice(t('channelSetupConfirmed'));void run(()=>mutate('connect'));return;}
        if(['expired','denied'].includes(result.status)){setActiveQr(null);setNotice(t(result.status==='denied'?'channelQrDenied':'channelQrExpired'));return;}
        setQrStatus(result.status);
      }catch(e){if(!cancelled)setError(e.message);}
      if(!cancelled)timer=setTimeout(poll,qr.intervalMs??2000);
    }timer=setTimeout(poll,qr.intervalMs??2000);return()=>{cancelled=true;clearTimeout(timer);};
  },[qr]);
  if(!enabled)return <p className="muted">{t('channelDisabled')}</p>;
  if(!snapshot||!form)return <p className="muted" role="status">{error||t('loading')}</p>;
  const locked=busy||snapshot.config?.enabled||!!qr,status=snapshot.runtime.state;
  const consoleUrl={feishu:'https://open.feishu.cn/app',qq:'https://q.qq.com/',dingtalk:'https://open-dev.dingtalk.com/',wecom:'https://work.weixin.qq.com/'}[platform];
  return <div className="channel-panel">
    <div className="channel-panel-heading"><div><ChannelMark platform={platform} t={t}/><h3>{t('channel_'+platform)}</h3></div><span className="channel-status" role="status"><span className={'status-dot '+(status==='connected'?'ready':'')}/>{t('channelState_'+status)}</span></div>
    {error||snapshot.runtime.error?<div className="settings-error" role="alert">{error||t(snapshot.runtime.error)}</div>:null}
    {notice?<p role="status" className="channel-notice"><Check size={14}/>{notice}</p>:null}
    {snapshot.config?.enabled?<div className="channel-connected"><div><strong>{t(status==='connected'?'channelReady':'channelConnecting')}</strong><p>{t('channelConnectedHelp')}</p></div><button disabled={busy} className="subtle-button" onClick={()=>run(async()=>{const data=await mutate('disconnect');fill(data);})}><Unplug size={14}/>{t('channelEditConnection')}</button></div>:null}
    {!snapshot.config?.enabled?<>
      {supportsQr?<div className="channel-setup-modes" role="group" aria-label={t('channelSetupMethod')}><button disabled={busy||!!qr} aria-pressed={mode==='qr'} onClick={()=>setMode('qr')}><QrCode size={16}/>{t('channelScanSetup')}</button><button disabled={busy||!!qr} aria-pressed={mode==='manual'} onClick={()=>setMode('manual')}><KeyRound size={16}/>{t('channelManualSetup')}</button></div>:null}
      <form hidden={Boolean(qr)} className="dialog-form channel-form" onSubmit={event=>{event.preventDefault();run(async()=>{await save();await mutate('connect');});}}>
      <fieldset disabled={locked}>
        <div className="channel-step-heading"><span>1</span><h4>{t(mode==='qr'?'channelScanSetup':'channelCredentials')}</h4></div>
        {mode==='manual'?<><ol className="channel-setup-steps">{[1,2,3].map(n=><li key={n}>{t('channelGuide_'+platform+'_'+n)}</li>)}</ol>{consoleUrl?<a className="channel-console-link" href={consoleUrl} target="_blank" rel="noreferrer">{t('channelOpenConsole')}<ArrowUpRight size={13}/></a>:null}
        {platform==='weixin'?<div className="channel-form-grid"><label>{t('channelAccountId')}<input value={form.accountId} required onChange={e=>update('accountId',e.target.value)}/></label><label>{t('channelToken')}<input type="password" autoComplete="new-password" value={form.token} required={!snapshot.config?.hasToken} placeholder={snapshot.config?.hasToken?t('channelSecretSaved'):''} onChange={e=>update('token',e.target.value)}/></label></div>:<div className="channel-form-grid"><label>{t(platform==='dingtalk'?'channelClientId':platform==='wecom'?'channelBotId':'channelAppId')}<input required value={form.appId} autoComplete="off" onChange={e=>update('appId',e.target.value)}/></label><label>{t(platform==='wecom'?'channelBotSecret':'channelSecret')}<input type="password" required={!snapshot.config?.hasSecret} autoComplete="new-password" value={form.secret} placeholder={snapshot.config?.hasSecret?t('channelSecretSaved'):''} onChange={e=>update('secret',e.target.value)}/></label></div>}</>:<p className="channel-setup-description">{t('channelScanHelp',{platform:t('channel_'+platform)})}</p>}
        <div className="channel-step-heading"><span>2</span><h4>{t('channelConversation')}</h4></div>
        <div className="channel-form-grid"><label>{t('channelProject')}<select value={form.projectId} onChange={e=>update('projectId',e.target.value)}><option value="">{t('casualNoWorkspace')}</option>{state.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>{t('channelModel')}<select required value={form.model} onChange={e=>update('model',e.target.value)}>{(state.models??[]).map(m=><option key={m.id} value={m.id}>{m.name??m.id}</option>)}</select></label></div>
        <details className="channel-advanced"><summary>{t('channelAdvanced')}</summary><p className="muted">{t('channelPairHelp')}</p><div className="channel-form-grid"><label>{t('channelAllowedUsers')}<textarea rows={2} value={form.allowedUsers} onChange={e=>update('allowedUsers',e.target.value)}/><small>{t('channelIdHelp_'+platform)}</small></label><label>{t('channelAllowedGroups')}<textarea disabled={platform==='weixin'} rows={2} value={form.allowedGroups} onChange={e=>update('allowedGroups',e.target.value)}/></label></div><label>{t('channelPermission')}<select value={form.permission} onChange={e=>update('permission',e.target.value)}><option value="read-only">{t('channelReadOnly')}</option><option value="workspace-write">{t('channelWorkspaceWrite')}</option></select></label></details>
      </fieldset>
      {!qr?<div className="channel-actions">{mode==='qr'?<button type="button" className="primary-button" disabled={busy||!form.model} onClick={()=>run(async()=>{const data=await api(route+'/qr/start',{config:payload()});if(alive.current){setQrStatus('wait');setActiveQr(data);}else void api(route+'/qr/cancel',{id:data.id}).catch(()=>{});})}>{busy?<LoaderCircle size={14} className="spinner"/>:<QrCode size={14}/>} {t('channelGenerateQr')}</button>:<button type="submit" className="primary-button" disabled={busy||!form.model}>{busy?<LoaderCircle size={14} className="spinner"/>:<Link2 size={14}/>} {t('channelSaveConnect')}</button>}<button type="button" className="subtle-button" disabled={busy} onClick={()=>run(async()=>{await save();setNotice(t('channelSaved'));})}>{t('channelSave')}</button>{snapshot.config&&(snapshot.config.hasSecret||snapshot.config.hasToken)?<button type="button" disabled={busy} onClick={()=>run(()=>mutate('connect'))}>{t('channelUseSaved')}</button>:null}</div>:null}
      </form>
      {qr?<div ref={qrCard} className="channel-qr"><img src={qr.image} alt={t('channelScanSetup')} width="208" height="208"/><strong>{t(qrStatus==='scaned'||qrStatus==='scanned'?'channelConfirmPhone':'channelScanWith',{platform:t('channel_'+platform)})}</strong><p>{t('channelQrLifetime',{time:new Intl.DateTimeFormat(locale,{timeStyle:'short'}).format(new Date(qr.expiresAt))})}</p><button className="subtle-button" onClick={()=>run(cancelQr)}>{t('cancel')}</button></div>:null}
    </>:null}
    {snapshot.config?.enabled&&!snapshot.config.allowedUsers.length?<div className="channel-pairing"><h4>{t('channelPairTitle')}</h4><p>{t('channelPairHelp')}</p>{(snapshot.pairing??[]).map(peer=><div className="channel-pair-row" key={peer.id}><span>{peer.name}<small>{peer.senderId}</small></span><button disabled={busy} onClick={()=>run(async()=>{const data=await mutate('pair',{id:peer.id});fill(data);setNotice(t('channelPairDone'));})}>{t('channelPairApprove')}</button></div>)}</div>:null}
    <p className="muted channel-footnote">{t('channelRestartHint')}</p>
    <div className="channel-queue"><p>{t('channelQueueSummary',{pending:new Intl.NumberFormat(locale).format(snapshot.counts.accepted??0),running:new Intl.NumberFormat(locale).format(snapshot.counts.running??0),unknown:new Intl.NumberFormat(locale).format(snapshot.counts.unknown??0)})}</p>
      {snapshot.executions.map(row=><div className="channel-queue-row" key={row.id}><span>{t(row.error??(row.status==='paused'?'channelPaused':'running'))}</span>{row.sessionId?<button onClick={()=>onOpenChat(row.sessionId)}>{t('channelOpenChat')}<ArrowUpRight size={13}/></button>:null}</div>)}
      {snapshot.deliveries.length?<h4>{t('channelPending')}</h4>:null}{snapshot.deliveries.map(row=><div className="channel-delivery" key={row.id}><div><strong>{t('channelDelivery_'+row.status)}</strong><small>{new Intl.DateTimeFormat(locale,{dateStyle:'short',timeStyle:'short'}).format(new Date(row.created))}</small></div>{row.error?<p className="muted">{t(row.error)}</p>:null}{row.status==='unknown'?<div className="channel-actions"><button disabled={busy} onClick={()=>run(async()=>{if(window.confirm(t('channelConfirmRetry')))await mutate('deliveries/'+row.id+'/retry');})}><RefreshCw size={12}/>{t('channelRetry')}</button><button disabled={busy} onClick={()=>run(()=>mutate('deliveries/'+row.id+'/delivered'))}>{t('channelConfirmDelivered')}</button></div>:null}{row.status!=='sending'?<button disabled={busy} onClick={()=>run(async()=>{if(window.confirm(t('channelConfirmDrop')))await mutate('deliveries/'+row.id+'/drop');})}>{t('channelDrop')}</button>:null}</div>)}
    </div><p className="muted channel-footnote">{t('channelCommands')}</p>
  </div>;
}
export function ChannelSettings(props){const [platform,setPlatform]=useState('feishu');return <><h3>{props.t('channels')}</h3><p className="muted">{props.t('channelSetupIntro')}</p><div className="channel-tabs" role="group" aria-label={props.t('channels')}>{channelPlatforms.map(id=><button key={id} aria-pressed={platform===id} className={platform===id?'selected':''} onClick={()=>setPlatform(id)}><ChannelMark platform={id} t={props.t}/>{props.t('channel_'+id)}</button>)}</div><ChannelPanel key={platform} platform={platform} {...props}/></>;}
