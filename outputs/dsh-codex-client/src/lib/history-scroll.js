export function captureHistoryAnchor(container){
  if(!container)return null;
  const top=container.getBoundingClientRect().top;
  const item=[...container.querySelectorAll('[data-history-id]')].find(row=>row.getBoundingClientRect().bottom>top+1);
  return {itemId:item?.dataset.historyId??null,offset:item?item.getBoundingClientRect().top-top:null,scrollTop:container.scrollTop,scrollHeight:container.scrollHeight};
}
export function restoreHistoryAnchor(container,anchor,{missing='height'}={}){
  if(!container||!anchor)return;
  const item=anchor.itemId?[...container.querySelectorAll('[data-history-id]')].find(row=>row.dataset.historyId===anchor.itemId):null;
  const position=item?container.scrollTop+item.getBoundingClientRect().top-container.getBoundingClientRect().top-anchor.offset:missing==='start'?0:anchor.scrollTop+container.scrollHeight-anchor.scrollHeight;
  container.scrollTop=Math.max(0,position);
}
