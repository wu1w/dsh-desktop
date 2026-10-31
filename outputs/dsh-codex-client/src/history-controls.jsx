import React from 'react';
import {LoaderCircle,ChevronUp,RefreshCw} from 'lucide-react';

export function HistoryControls({snapshot,t,onEarlier,onRetry}){
  const {history,loadingEarlier,loadingInitial,reloadRequired}=snapshot;
  if(history.error)return <div className="history-controls history-retry"><span role="status">{loadingInitial&&reloadRequired?t('reloadingHistory'):history.error}</span><button type="button" className="history-load-button" disabled={loadingEarlier||loadingInitial} onClick={onRetry}>{loadingEarlier||loadingInitial?<LoaderCircle size={13} className="spinner"/>:<RefreshCw size={13}/>}<span>{t(loadingEarlier||loadingInitial?'loadingHistory':reloadRequired?'reloadHistory':'retryHistory')}</span></button></div>;
  if(!history.hasMore&&!loadingEarlier)return null;
  return <div className="history-controls"><button type="button" className="history-load-button" disabled={loadingEarlier} onClick={onEarlier}>{loadingEarlier?<LoaderCircle size={13} className="spinner"/>:<ChevronUp size={13}/>}<span>{t(loadingEarlier?'loadingHistory':'loadEarlier')}</span></button></div>;
}
