const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const locales = { en: require('./locales/en.json'), 'zh-CN': require('./locales/zh-CN.json') };

function normalizeLocale(locale) { return typeof locale === 'string' && locale.startsWith('zh') ? 'zh-CN' : 'en'; }
function translator(locale) { return (key,params={}) => (locales[normalizeLocale(locale)][key] ?? locales.en[key] ?? key).replace(/\{(\w+)\}/g,(match,name)=>Object.hasOwn(params,name)?String(params[name]):match); }
function activitySummary(state,{rendererRunning=false}={}) {
  const entries=new Map();
  const add=(kind,id,pluginId,count)=>{const key=JSON.stringify([kind,pluginId,id]);const previous=entries.get(key);entries.set(key,{key,kind,count:Math.max(previous?.count??0,count)});};
  for(const [index,session] of (Array.isArray(state?.sessions)?state.sessions:[]).entries()) {
    if(!session)continue;
    const sessionId=typeof session.id==='string'?session.id:'session-'+index;
    if(session.running===true) {
      const identity=typeof session.activeTurnId==='string'&&session.activeTurnId.trim()?JSON.stringify([sessionId,session.activeTurnId]):sessionId;
      add('model',identity,'engine',1);
    } else if(session.runRecovery?.status==='waiting'&&session.runRecovery.managed===true&&session.runRecovery.userStopped!==true) {
      add('recovery',JSON.stringify([sessionId,session.runRecovery.id??null]),'task-recovery',1);
    }
  }
  if(['waiting','restarting'].includes(state?.engine?.recovery?.status))add('recovery',state.engine.id??'current-engine','engine-supervisor',1);
  if(![...entries.values()].some(item=>item.kind==='model')&&rendererRunning)add('model','legacy-renderer-busy','renderer',1);
  for(const [index,item] of (Array.isArray(state?.activities)?state.activities:[]).entries()) {
    if(item&&typeof item.id==='string'&&item.id&&typeof item.pluginId==='string'&&item.pluginId&&['terminal','command','automation','unknown'].includes(item.kind)&&Number.isSafeInteger(item.count)&&item.count>0) add(item.kind,item.id,item.pluginId,item.count);
    else add('unknown','invalid-activity-'+index,'host',1);
  }
  if(state?.activities!=null&&!Array.isArray(state.activities))add('unknown','invalid-activity-snapshot','host',1);
  if(state?.sessions!=null&&!Array.isArray(state.sessions))add('unknown','invalid-model-snapshot','host',1);
  const result={model:0,recovery:0,terminal:0,command:0,automation:0,unknown:0,entries:[...entries.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)};
  for(const item of result.entries)result[item.kind]+=item.count;
  result.total=result.model+result.recovery+result.terminal+result.command+result.automation+result.unknown;
  return result;
}
function confirmationFingerprint(summary) {return JSON.stringify(summary.entries.map(item=>[item.key,item.count]));}
function hasNewActivities(summary,approved) {return summary.entries.some(item=>item.count>(approved.get(item.key)??0));}
function approveActivities(summary,approved) {for(const item of summary.entries)approved.set(item.key,Math.max(item.count,approved.get(item.key)??0));}
function activityDetail(summary,locale) {
  const t=translator(locale),number=new Intl.NumberFormat(normalizeLocale(locale));
  return ['model','recovery','terminal','command','automation','unknown'].filter(kind=>summary[kind]>0).map(kind=>t('activity_'+kind,{count:number.format(summary[kind])})).join('\n');
}
function isMainDocument(url, expectedOrigin) {
  try { const parsed = new URL(url); return parsed.origin === expectedOrigin && parsed.pathname === '/' && !parsed.username && !parsed.password; }
  catch { return false; }
}
function isTrustedSender(event, window, expectedOrigin) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isMainDocument(event.senderFrame?.url, expectedOrigin));
}
function isExternalWebUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.includes('%')) return false;
    if (net.isIP(host) === 4) {
      const [a,b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
    }
    // IPv6 literals can encode loopback and IPv4-mapped private addresses.
    if (net.isIP(host) === 6) return false;
    return true;
  } catch { return false; }
}
function restoreWindowState(saved, displays) {
  const primary = displays[0]?.workArea ?? {x:0,y:0,width:1512,height:886};
  const fallback = {width:Math.min(1512,primary.width),height:Math.min(886,primary.height)};
  const raw = saved?.bounds;
  if (!raw || !['x','y','width','height'].every(key=>Number.isFinite(raw[key])) || raw.width < 100 || raw.height < 100 || raw.width > 20000 || raw.height > 20000) return { ...fallback, maximized:false, fullScreen:false };
  const area = displays.map(display=>display.workArea).find(area => raw.x + Math.min(raw.width,150) > area.x && raw.x < area.x + area.width - 150 && raw.y >= area.y && raw.y < area.y + area.height - 100) ?? primary;
  const width = Math.max(Math.min(860,area.width),Math.min(Math.round(raw.width),area.width));
  const height = Math.max(Math.min(580,area.height),Math.min(Math.round(raw.height),area.height));
  return {x:Math.max(area.x,Math.min(Math.round(raw.x),area.x+area.width-width)),y:Math.max(area.y,Math.min(Math.round(raw.y),area.y+area.height-height)),width,height,maximized:saved.maximized===true,fullScreen:saved.fullScreen===true};
}
class DesktopStateStore {
  constructor(file) { this.file=file;this.writing=Promise.resolve(); }
  read() {
    try { if(fs.statSync(this.file).size > 32768)return {}; const data=JSON.parse(fs.readFileSync(this.file,'utf8')); return data?.version===1 ? data : {}; }
    catch { return {}; }
  }
  save(state) {
    const data=JSON.stringify({version:1,...state})+'\n';
    const next=this.writing.then(async()=>{
      await fsp.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      const tmp=this.file+'.'+randomUUID()+'.tmp';
      try {await fsp.writeFile(tmp,data,{mode:0o600});await fsp.rename(tmp,this.file);}
      finally {await fsp.rm(tmp,{force:true}).catch(()=>{});}
    });
    this.writing=next.catch(()=>{});return next;
  }
  async flush() { await this.writing; }
}
class CloseHandshake {
  constructor({send,timeoutMs=10000}) {this.send=send;this.timeoutMs=timeoutMs;this.pending=null;}
  request(reason,{discardDocument=false,expectedDirtyRevision}={}) {
    if(this.pending)return this.pending.promise;
    const requestId=randomUUID();let finish;
    const promise=new Promise(resolve=>{finish=resolve;});
    const timer=setTimeout(()=>this.finish({requestId,allow:false,timedOut:true}),this.timeoutMs);
    this.pending={requestId,promise,finish,timer};
    try {this.send({requestId,reason,discardDocument:discardDocument===true,...(Number.isSafeInteger(expectedDirtyRevision)&&expectedDirtyRevision>=0?{expectedDirtyRevision}:{})});}catch {this.finish({requestId,allow:false});}
    return promise;
  }
  finish(result) {
    if(!this.pending || result?.requestId!==this.pending.requestId || typeof result.allow!=='boolean')return false;
    const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.finish({allow:result.allow,timedOut:result.timedOut===true});return true;
  }
  cancel() {if(this.pending)this.finish({requestId:this.pending.requestId,allow:false});}
}
function menuTemplate({locale,send,requestReload,appName='DSH',platform=process.platform}) {
  const t=translator(locale);
  const action=(label,id,accelerator)=>({label:t(label),...(accelerator?{accelerator}:{}),click:()=>send(id)});
  const role=(label,id,accelerator)=>({label:t(label),role:id,...(accelerator?{accelerator}:{})});
  const sep={type:'separator'};
  const menus=[];
  if(platform==='darwin')menus.push({label:appName,submenu:[role('about','about'),sep,action('settings','open-settings','CmdOrCtrl+,'),sep,role('services','services'),sep,role('hide','hide','Command+H'),role('hideOthers','hideOthers','Command+Alt+H'),role('showAll','unhide'),sep,role('quit','quit','CmdOrCtrl+Q')]});
  menus.push({label:t('file'),submenu:[action('newChat','new-chat','CmdOrCtrl+N'),action('openProject','open-project','CmdOrCtrl+Shift+O'),sep,action('saveDocument','save-document','CmdOrCtrl+S'),sep,action('closePanel','close-panel','CmdOrCtrl+W'),role('closeWindow','close','CmdOrCtrl+Shift+W'),...(platform==='darwin'?[]:[sep,action('settings','open-settings','CmdOrCtrl+,'),role('quit','quit','CmdOrCtrl+Q')])]});
  menus.push({label:t('edit'),submenu:[role('undo','undo'),role('redo','redo'),sep,role('cut','cut'),role('copy','copy'),role('paste','paste'),role('pastePlain','pasteAndMatchStyle'),role('delete','delete'),role('selectAll','selectAll'),sep,action('findDocument','find-document','CmdOrCtrl+F'),action('find','find','CmdOrCtrl+K')]});
  menus.push({label:t('view'),submenu:[action('sidebar','toggle-sidebar','CmdOrCtrl+B'),action('document','toggle-document','CmdOrCtrl+Shift+D'),action('terminal','toggle-terminal','CmdOrCtrl+`'),action('focusComposer','focus-composer','CmdOrCtrl+L'),sep,{label:t('reload'),accelerator:'CmdOrCtrl+R',click:requestReload},sep,role('actualSize','resetZoom'),role('zoomIn','zoomIn'),role('zoomOut','zoomOut'),sep,role('fullScreen','togglefullscreen',platform==='darwin'?'Control+Command+F':'F11')]});
  menus.push({label:t('chat'),submenu:[action('back','back','CmdOrCtrl+['),action('forward','forward','CmdOrCtrl+]'),sep,action('renameChat','rename-chat'),action('copyChat','copy-chat','CmdOrCtrl+Shift+C'),action('archiveChat','archive-chat')]});
  menus.push({label:t('window'),role:'windowMenu',submenu:[role('minimize','minimize'),role('zoom','zoom'),...(platform==='darwin'?[sep,role('front','front')]:[])]});
  menus.push({label:t('help'),role:'help',submenu:[action('shortcuts','open-shortcuts'),action('about','open-about')]});
  return menus;
}
module.exports={normalizeLocale,translator,activitySummary,confirmationFingerprint,hasNewActivities,approveActivities,activityDetail,isMainDocument,isTrustedSender,isExternalWebUrl,restoreWindowState,DesktopStateStore,CloseHandshake,menuTemplate};
