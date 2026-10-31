// Own document identity and edit revisions independently of React render timing.
// Tokens can cross awaits; responses may commit only to the document they read.
export class DocumentSession {
  constructor({file=null,dirty=false}={}){
    this.file=file?{...file}:null;
    this.dirty=Boolean(file&&dirty);
    this.revision=0;
    this.generation=0;
    this.openSequence=0;
    this.saveSequence=0;
    this.activeSave=null;
    this.recoveryDiscarded=false;
  }
  snapshot(){return {file:this.file,dirty:this.dirty,saving:this.activeSave!==null};}
  identity(file=this.file){return file?`${file.projectId}\0${file.path}`:null;}
  beginOpen(){return Object.freeze({request:++this.openSequence,revision:this.revision});}
  isCurrentOpen(token){return token.request===this.openSequence&&token.revision===this.revision;}
  completeOpen(token,file,{dirty=false}={}){
    if(!this.isCurrentOpen(token))return false;
    this.file={...file};this.dirty=dirty===true;this.revision++;this.generation++;this.recoveryDiscarded=false;return true;
  }
  edit(content){
    if(!this.file)return false;
    this.file={...this.file,content};this.dirty=true;this.revision++;this.recoveryDiscarded=false;return true;
  }
  close(){this.file=null;this.dirty=false;this.revision++;this.generation++;this.openSequence++;this.recoveryDiscarded=false;}
  beginSave(){
    if(this.activeSave)return {status:'busy'};
    if(!this.file||!this.dirty)return {status:'clean'};
    const token=Object.freeze({id:++this.saveSequence,identity:this.identity(),generation:this.generation,revision:this.revision,file:Object.freeze({...this.file})});
    this.activeSave=token;return {status:'saving',token};
  }
  completeSave(token,file){
    if(this.activeSave?.id!==token.id)return {accepted:false,applied:false};
    this.activeSave=null;
    if(token.generation!==this.generation||token.identity!==this.identity()||this.identity(file)!==token.identity)return {accepted:true,applied:false};
    // The write may have succeeded before another process changed the file.
    // Keep the editor and its old optimistic version rather than accepting that
    // other process's content as the user's saved text.
    if(file.content!==token.file.content)return {accepted:true,applied:false,conflict:true};
    if(token.revision!==this.revision){
      this.file={...this.file,version:file.version};this.dirty=true;
      return {accepted:true,applied:true,clean:false};
    }
    this.file={...file};this.dirty=false;this.revision++;this.recoveryDiscarded=false;
    return {accepted:true,applied:true,clean:true};
  }
  failSave(token){if(this.activeSave?.id!==token.id)return false;this.activeSave=null;return true;}
  setRecoveryDiscarded(discarded){this.recoveryDiscarded=discarded===true;}
  recoveryDraft(){return this.file&&this.dirty&&!this.recoveryDiscarded?{file:{...this.file}}:null;}
}
