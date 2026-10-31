import React from 'react';
import {ExternalLink,FileText,LoaderCircle,RefreshCw,Copy} from 'lucide-react';
import './file-preview-fallback.css';
export function FilePreviewFallback({file,t,locale,opening=false,disabled=false,onOpen,onRetry,onCopyPath}){
 const bytes=new Intl.NumberFormat(locale,{style:'unit',unit:'byte',unitDisplay:'long',maximumFractionDigits:0}).format(file.size??0),modified=Number.isFinite(Date.parse(file.modifiedAt))?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(file.modifiedAt)):null;
 return <section className="file-preview-fallback" aria-label={t('filePreviewUnavailable')}>
  <div className="file-preview-fallback-icon"><FileText size={28} strokeWidth={1.4}/></div><h2>{file.name}</h2><p>{t(file.preview?.reason??'filePreviewUnavailable')}</p>
  <dl><div><dt>{t('filePreviewPath')}</dt><dd title={file.path}>{file.path}</dd></div><div><dt>{t('filePreviewSize')}</dt><dd>{bytes}</dd></div>{modified?<div><dt>{t('filePreviewModified')}</dt><dd>{modified}</dd></div>:null}</dl>
  <div className="file-preview-fallback-actions"><button type="button" className="primary-button" disabled={disabled||opening} onClick={onOpen}>{opening?<LoaderCircle size={15} className="spinner"/>:<ExternalLink size={15}/>} {t(opening?'docOpeningSystem':'filePreviewOpenSystem')}</button><button type="button" className="subtle-button" disabled={disabled} onClick={onRetry}><RefreshCw size={14}/>{t('retry')}</button><button type="button" className="subtle-button" onClick={onCopyPath}><Copy size={14}/>{t('filePreviewCopyPath')}</button></div>
 </section>;
}
