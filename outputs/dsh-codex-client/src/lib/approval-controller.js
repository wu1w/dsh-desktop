import {elicitationForm,coerceElicitationContent} from '../../shared/mcp-elicitation.js';

export const isQuestionRequest=request=>request?.method==='item/tool/requestUserInput';
export const isElicitationRequest=request=>request?.method==='mcpServer/elicitation/request'&&(request.params?.requestedSchema!==undefined||request.params?.mode!==undefined);
const formFor=request=>{try{return elicitationForm(request);}catch{return{supported:false,fields:[],message:'',serverName:'',reasonCode:'MCP_ELICITATION_UNSUPPORTED'};}};
// Requests arrive as JSON. Own its graph once at admission, without recursive
// traversal or freezing the caller's schema; snapshots can reuse this safely.
function ownedJSON(value){
  const copies=new Map(),pending=[];
  const copy=source=>{if(source===null||typeof source!=='object')return source;if(copies.has(source))return copies.get(source);const target=Array.isArray(source)?new Array(source.length):Object.create(Object.getPrototypeOf(source));copies.set(source,target);pending.push(source);return target;};
  const result=copy(value);
  for(let index=0;index<pending.length;index++){
    const source=pending[index],target=copies.get(source);
    for(const key of Object.keys(source)){const descriptor=Object.getOwnPropertyDescriptor(source,key);if(descriptor&&Object.hasOwn(descriptor,'value'))Object.defineProperty(target,key,{value:copy(descriptor.value),enumerable:true,writable:false,configurable:false});}
    Object.freeze(target);
  }
  return result;
}
export const canApproveRequest=request=>isElicitationRequest(request)?formFor(request).supported:new Set(['item/tool/requestUserInput','item/permissions/requestApproval','item/commandExecution/requestApproval','item/fileChange/requestApproval','execCommandApproval','applyPatchApproval']).has(request?.method);
export function approvalQuestions(request){
  const seen=new Set();return (Array.isArray(request?.params?.questions)?request.params.questions:[]).filter(question=>{
    if(!question||typeof question.id!=='string'||!question.id||seen.has(question.id))return false;seen.add(question.id);return true;
  }).map(question=>({...question,header:typeof question.header==='string'?question.header:'',question:typeof question.question==='string'?question.question:'',isOther:question.isOther===true,isSecret:question.isSecret===true,options:(Array.isArray(question.options)?question.options:[]).filter(option=>option&&typeof option.label==='string'&&option.label.trim()).map(option=>({label:option.label,description:typeof option.description==='string'?option.description:''}))}));
}
function answerFor(question,state){
  if(!state)return null;
  if(question.options.length&&state.selection!=='other')return Number.isInteger(state.selection)?question.options[state.selection]?.label??null:null;
  if(question.options.length&&!question.isOther)return null;
  return typeof state.text==='string'&&state.text.trim()?state.text:null;
}

// Native approval IDs own their transient answers. They never enter draft or
// preference persistence; resolving one request clears only that request's data.
export class ApprovalController {
  constructor({elicitationEnabled=false}={}){this.order=[];this.requests=new Map();this.sequence=0;this.elicitationEnabled=elicitationEnabled===true;}
  setElicitationEnabled(enabled){
    enabled=enabled===true;if(enabled===this.elicitationEnabled)return false;this.elicitationEnabled=enabled;
    if(!enabled)for(const entry of this.requests.values())if(entry.form){entry.formValues.clear();entry.pending=null;entry.error=null;entry.generation=++this.sequence;}
    return true;
  }
  enqueue(request){
    if(!request||request.id===undefined||request.id===null)return false;
    const id=String(request.id),existing=this.requests.get(id),owned=request.method==='mcpServer/elicitation/request'?ownedJSON({...request,id}):{...request,id},form=isElicitationRequest(owned)?ownedJSON(formFor(owned)):null;
    const fingerprint=form?JSON.stringify([owned.engineId,owned.params?.threadId,owned.params?.conversationId,owned.params?.turnId,form]):null;
    if(existing&&existing.fingerprint===fingerprint){existing.request=owned;return true;}
    if(existing){existing.answers.clear();existing.skipped.clear();existing.formValues.clear();existing.pending=null;}
    this.requests.set(id,{request:owned,questions:approvalQuestions(owned),answers:new Map(),skipped:new Set(),form,formValues:new Map(),fingerprint,index:0,pending:null,error:null,generation:++this.sequence});if(!existing)this.order.push(id);return true;
  }
  resolve(id){
    id=String(id);const entry=this.requests.get(id);if(!entry)return false;
    entry.answers.clear();entry.skipped.clear();entry.formValues.clear();entry.pending=null;entry.error=null;
    this.requests.delete(id);this.order=this.order.filter(value=>value!==id);return true;
  }
  reconcile(requests){
    if(!Array.isArray(requests))return false;
    const order=[],present=new Set();
    for(const request of requests){
      if(!request||request.id===undefined||request.id===null)continue;
      const id=String(request.id);if(present.has(id))continue;
      present.add(id);order.push(id);this.enqueue(request);
    }
    for(const id of [...this.order])if(!present.has(id))this.resolve(id);
    // The server owns FIFO order after reconnect. Existing entries keep their
    // in-memory answers and submission token; absent entries have been scrubbed.
    this.order=order;return true;
  }
  snapshot(){
    const entry=this.requests.get(this.order[0]);if(!entry)return {current:null,count:0};
    const question=entry.questions[entry.index]??null;
    let elicitation=null;
    if(entry.form){
      const values=Object.fromEntries([...entry.formValues].map(([name,value])=>[name,Array.isArray(value)?[...value]:value]));let validation={valid:false};
      if(this.elicitationEnabled&&entry.form.supported)try{coerceElicitationContent(entry.request,values);validation={valid:true};}catch(error){validation={valid:false,code:error.code,field:typeof error.field==='string'?error.field:null};}
      elicitation={...entry.form,generation:entry.generation,enabled:this.elicitationEnabled,values,validation};
    }
    return {current:entry.request,generation:entry.generation,count:this.order.length,questions:entry.questions,index:entry.index,question,answer:question?{...(entry.answers.get(question.id)??{selection:null,text:''})}:null,answered:entry.questions.filter(q=>answerFor(q,entry.answers.get(q.id))!==null).length,canContinue:elicitation?elicitation.validation.valid:Boolean(question&&(answerFor(question,entry.answers.get(question.id))!==null||entry.skipped.has(question.id))),elicitation,pending:Boolean(entry.pending),error:entry.error,isBlocking:!isQuestionRequest(entry.request)||entry.request.params?.isBlocking!==false,skipped:question?entry.skipped.has(question.id):false};
  }
  _entry(id){const entry=this.requests.get(String(id));return entry&&!entry.pending?entry:null;}
  choose(id,questionId,selection){
    const entry=this._entry(id),question=entry?.questions.find(q=>q.id===questionId);if(!question)return false;
    if(selection==='other'?!question.isOther||!question.options.length:!Number.isInteger(selection)||!question.options[selection])return false;
    entry.answers.set(questionId,{selection,text:entry.answers.get(questionId)?.text??''});entry.skipped.delete(questionId);entry.error=null;return true;
  }
  type(id,questionId,text){
    const entry=this._entry(id),question=entry?.questions.find(q=>q.id===questionId);if(!question||typeof text!=='string'||(question.options.length&&!question.isOther))return false;
    entry.answers.set(questionId,{selection:question.options.length?'other':null,text});entry.skipped.delete(questionId);entry.error=null;return true;
  }
  formType(id,name,value){
    const entry=this._entry(id);if(!this.elicitationEnabled||!entry?.form?.supported||!entry.form.fields.some(field=>field.name===name))return false;
    if(value!==undefined&&typeof value!=='string'&&typeof value!=='boolean'&&typeof value!=='number'&&!(Array.isArray(value)&&value.every(item=>typeof item==='string')))return false;
    if(value===undefined)entry.formValues.delete(name);else entry.formValues.set(name,Array.isArray(value)?[...value]:value);entry.error=null;return true;
  }
  skip(id){const entry=this._entry(id),question=entry?.questions[entry.index];if(!question)return false;entry.answers.delete(question.id);entry.skipped.add(question.id);if(entry.index<entry.questions.length-1)entry.index++;return true;}
  move(id,direction){const entry=this._entry(id);if(!entry)return false;if(direction>0){const question=entry.questions[entry.index];if(question&&answerFor(question,entry.answers.get(question.id))===null&&!entry.skipped.has(question.id))return false;}entry.index=Math.max(0,Math.min(entry.questions.length-1,entry.index+direction));return true;}
  beginSubmit(id,allow,{skipCurrent=false,elicitationAction}={}){
    const entry=this._entry(id);if(!entry||this.order[0]!==String(id)||typeof allow!=='boolean')return null;
    if(entry.form){
      const action=elicitationAction??(allow?'accept':'decline');if(!['accept','decline','cancel'].includes(action)||(action==='accept')!==allow)return null;
      let content;if(action==='accept'){if(!this.elicitationEnabled||!entry.form.supported)return null;try{content=coerceElicitationContent(entry.request,Object.fromEntries(entry.formValues));}catch{return null;}}
      const token=Object.freeze({id:String(id),generation:entry.generation,request:++this.sequence,body:{allow,elicitationAction:action,...(action==='accept'?{content}:{})}});entry.pending=token;entry.error=null;return token;
    }
    if(allow&&!canApproveRequest(entry.request))return null;
    const question=entry.questions[entry.index];
    if(allow&&isQuestionRequest(entry.request)&&question){
      if(skipCurrent){entry.answers.delete(question.id);entry.skipped.add(question.id);}
      else if(answerFor(question,entry.answers.get(question.id))===null&&!entry.skipped.has(question.id))return null;
    }
    const answers={};if(allow&&isQuestionRequest(entry.request))for(const q of entry.questions){const answer=answerFor(q,entry.answers.get(q.id));if(answer!==null)Object.defineProperty(answers,q.id,{value:{answers:[answer]},enumerable:true});}
    const token=Object.freeze({id:String(id),generation:entry.generation,request:++this.sequence,body:{allow:allow===true,answers}});entry.pending=token;entry.error=null;return token;
  }
  complete(token){const entry=this.requests.get(token?.id);if(!entry||entry.generation!==token.generation||entry.pending?.request!==token.request)return false;return this.resolve(token.id);}
  fail(token,message){const entry=this.requests.get(token?.id);if(!entry||entry.generation!==token.generation||entry.pending?.request!==token.request)return false;entry.pending=null;entry.error=String(message);return true;}
  clear(){for(const id of [...this.order])this.resolve(id);}
}

export function approvalDetails(request){
  if(isQuestionRequest(request))return [];
  const params=request?.params??{},context=request?.displayContext??{},details=[],input=params.input??{};
  const add=(key,value)=>{if(typeof value==='string'&&value)details.push({key,value});};
  add('approvalReason',params.reason);add('approvalTool',params.tool);add('cwd',params.cwd??context.cwd);add('approvalCommand',Array.isArray(params.command)?params.command.join(' '):params.command??context.command);add('approvalWriteRoot',params.grantRoot);
  add('approvalNetworkHost',params.networkApprovalContext?.host);
  if(params.fileChanges&&typeof params.fileChanges==='object')for(const path of Object.keys(params.fileChanges))add('approvalChangedFiles',path);
  const paths=new Set([input.file_path,input.path,...(Array.isArray(context.paths)?context.paths:[])].filter(path=>typeof path==='string'&&path));for(const path of paths)add('approvalChangedFiles',path);
  const permissions=params.permissions??params.additionalPermissions;
  if(permissions?.network?.enabled===true)details.push({key:'approvalNetwork',value:null});
  const fs=permissions?.fileSystem;
  for(const [key,values] of [['approvalReadPaths',fs?.read],['approvalWritePaths',fs?.write]])if(Array.isArray(values))for(const value of values)add(key,value);
  for(const entry of Array.isArray(fs?.entries)?fs.entries:[]){
    if(!entry)continue;
    const key=entry.access==='read'?'approvalReadPaths':entry.access==='deny'?'approvalDeniedPaths':'approvalWritePaths',target=entry.path;
    if(typeof target==='string')add(key,target);
    else if(target?.type==='path')add(key,target.path);
    else if(target?.type==='glob_pattern')add(key,target.pattern);
    else if(target?.type==='special'){
      const kind=target.value?.kind;
      if(['root','minimal','project_roots','tmpdir','slash_tmp'].includes(kind))details.push({key,valueKey:`approvalPath_${kind}`,suffix:typeof target.value.subpath==='string'?target.value.subpath:null});
      else add(key,target.value?.path);
    }
  }
  add('approvalMessage',params.message);
  let remaining=40_000;
  for(const [key,text,truncated] of [['approvalBeforeEdit',input.old_string,false],['approvalAfterEdit',input.new_string,false],['approvalWriteContent',input.content,false],['approvalChangePreview',context.text,context.textTruncated===true]]){
    if(typeof text!=='string'||(key==='approvalChangePreview'&&!text&&!truncated))continue;
    const preview=text.slice(0,remaining);remaining-=preview.length;
    details.push({key,preview,truncated:truncated||preview.length<text.length,...(text.length===0?{empty:true}:{})});
  }
  return details;
}
