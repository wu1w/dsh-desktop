export class RendererCloseGuard{
  constructor({getRevision,getElement,flush,preserve,onError=()=>{},report}){Object.assign(this,{getRevision,getElement,flush,preserve,onError,report});this.pending=false;}
  lock(){
    if(this.element)return;
    this.element=this.getElement();if(!this.element)return;
    const locked=this.locked=new Map(),page=this.element.ownerDocument;this.focusTarget=page?.activeElement;
    const protect=element=>{if(!element||locked.has(element))return;locked.set(element,element.inert===true);element.inert=true;};
    protect(this.element);protect(page?.body);
    // Native dialog Escape cancellation still fires even on an inert modal;
    // CloseWatcher can also dispatch a non-cancelable cancel for late dialogs.
    this.cancelTarget=page;this.preventCancel=event=>{if(this.locked===locked&&event.target?.tagName==='DIALOG'){event.preventDefault();event.stopImmediatePropagation();}};
    this.preventEscape=event=>{if(this.locked===locked&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();}};
    page?.addEventListener?.('cancel',this.preventCancel,true);
    page?.addEventListener?.('keydown',this.preventEscape,true);
    // Portals live outside app-shell. Modal dialogs can escape ancestor inert,
    // so protect each top-layer dialog itself, including ones opened late.
    const protectDialogs=()=>{if(this.locked!==locked)return;for(const dialog of page?.querySelectorAll?.('dialog[open]')??[])protect(dialog);};
    protectDialogs();
    const Observer=page?.defaultView?.MutationObserver;
    if(page?.body&&typeof Observer==='function'){
      this.observer=new Observer(protectDialogs);
      this.observer.observe(page.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
    }
  }
  release(){
    const locked=this.locked,focusTarget=this.focusTarget;this.locked=null;this.focusTarget=null;
    this.cancelTarget?.removeEventListener?.('cancel',this.preventCancel,true);this.cancelTarget?.removeEventListener?.('keydown',this.preventEscape,true);this.cancelTarget=null;this.preventCancel=null;this.preventEscape=null;
    this.observer?.disconnect();this.observer=null;this.element=null;
    for(const [element,inert]of locked??[])element.inert=inert;
    // Cancellation should return the keyboard to its previous control. The
    // control may have unmounted; focus restoration must not block cleanup.
    try{if(focusTarget?.isConnected)focusTarget.focus?.({preventScroll:true});}catch{}
  }
  async request({requestId,discardDocument=false,expectedDirtyRevision}){
    if(this.pending){await this.report({requestId,allow:false});return false;}
    this.pending=true;let allow=false;
    try{
      this.lock();
      const revision=this.getRevision();
      if(Number.isSafeInteger(expectedDirtyRevision)&&expectedDirtyRevision!==revision)throw Object.assign(Error('CLOSE_DOCUMENT_CHANGED'),{code:'CLOSE_DOCUMENT_CHANGED'});
      await this.flush({discardDocument});
      if(this.getRevision()!==revision)throw Object.assign(Error('CLOSE_DOCUMENT_CHANGED'),{code:'CLOSE_DOCUMENT_CHANGED'});
      allow=true;
    }catch(error){this.preserve?.();this.onError(error);}
    finally{if(!allow)this.release();this.pending=false;await this.report({requestId,allow});}
    return allow;
  }
}
