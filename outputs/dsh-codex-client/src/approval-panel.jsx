import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown,ChevronUp,LoaderCircle,ShieldCheck,X} from 'lucide-react';
import {approvalDetails,isQuestionRequest,isElicitationRequest,canApproveRequest} from './lib/approval-controller.js';
import {isComposing} from './lib/keyboard.js';

export function ApprovalPanel(props){return isElicitationRequest(props.snapshot.current)?<ElicitationPanel {...props}/>:<QuestionApprovalPanel {...props}/>;}

function QuestionApprovalPanel({snapshot,t,locale,contextName,onChoose,onType,onMove,onSkip,onSubmit}){
  const {current,question,index,questions,answer,pending,error,isBlocking,count,canContinue,answered}=snapshot;
  const [collapsed,setCollapsed]=useState(false),element=useRef(null),questionHeading=useRef(null),focusStep=useRef(false),composing=useRef(false),blockedCancel=useRef(false);
  const isInput=isQuestionRequest(current),last=index===questions.length-1,supported=canApproveRequest(current);
  const submitRef=useRef(onSubmit);submitRef.current=onSubmit;
  useEffect(()=>{
    if(!isBlocking)return;
    const prior=document.activeElement,dialog=element.current;dialog.showModal();
    (dialog.querySelector('.approval-question input,.approval-question textarea')??dialog.querySelector('button:not(:disabled)'))?.focus();
    const cancel=event=>{event.preventDefault();if(composing.current||blockedCancel.current)return;submitRef.current(false);};dialog.addEventListener('cancel',cancel);
    return()=>{dialog.removeEventListener('cancel',cancel);dialog.close();if(prior?.isConnected)prior.focus();};
  },[isBlocking,current.id]);
  useEffect(()=>{composing.current=false;blockedCancel.current=false;if(focusStep.current){focusStep.current=false;questionHeading.current?.focus();}},[index,current.id,snapshot.generation]);
  const number=value=>new Intl.NumberFormat(locale).format(value);
  const move=direction=>{focusStep.current=true;onMove(direction);};
  const skip=()=>{if(last)onSubmit(true,{skipCurrent:true});else{focusStep.current=true;onSkip();}};
  const Container=isBlocking?'dialog':'section';
  return <Container ref={element} className={`dialog approval-panel ${isBlocking?'approval-blocking':'approval-floating'} ${collapsed?'approval-collapsed':''}`} aria-label={t(isInput?'inputRequest':'approval')} aria-modal={isBlocking?'true':'false'} role={isBlocking?undefined:'dialog'} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDownCapture={event=>{blockedCancel.current=event.key==='Escape'&&isComposing(event);}} onPointerDownCapture={()=>{if(!composing.current)blockedCancel.current=false;}}>
    <div className="dialog-heading approval-heading"><ShieldCheck size={17}/><h2>{t(isInput?'inputRequest':'approval')}</h2>{pending?<LoaderCircle size={13} className="spinner" aria-label={t('sending')}/>:null}{count>1?<span className="approval-pending-count">{t('pendingApprovalCount',{count:number(count)})}</span>:null}{!isBlocking?<button type="button" className="icon-button" title={t(collapsed?'expandQuestions':'minimizeQuestions')} aria-label={t(collapsed?'expandQuestions':'minimizeQuestions')} onClick={()=>setCollapsed(!collapsed)}>{collapsed?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</button>:null}<button type="button" className="icon-button" title={t(isInput?'declineQuestions':'deny')} aria-label={t(isInput?'declineQuestions':'deny')} disabled={pending} onClick={()=>onSubmit(false)}><X size={17}/></button></div>
    {!collapsed?<><p className="approval-status">{contextName?<span>{t('approvalForChat',{name:contextName})}</span>:null}{t(isBlocking?'approvalBlocking':'approvalNonBlocking')}</p><form onSubmit={event=>{event.preventDefault();if(pending)return;if(isInput){if(!canContinue)return;last?onSubmit(true):move(1);}else onSubmit(true);}}>
      {isInput?<>{question?<fieldset className="approval-question" key={question.id} disabled={pending}><div className="approval-question-progress"><span>{t('questionProgress',{current:number(index+1),total:number(questions.length)})}</span>{question.header?<span>{question.header}</span>:null}</div><h3 ref={questionHeading} tabIndex={-1}>{question.question}</h3>{question.options.length>0?<div className="approval-options" role="radiogroup" aria-label={question.question}>{question.options.map((option,optionIndex)=><label className={`approval-option ${answer.selection===optionIndex?'selected':''}`} key={`${optionIndex}:${option.label}`}><input type="radio" name={`answer-${current.id}-${question.id}`} checked={answer.selection===optionIndex} onChange={()=>onChoose(optionIndex)}/><span><strong>{option.label}</strong>{option.description?<small>{option.description}</small>:null}</span></label>)}{question.isOther?<label className={`approval-option ${answer.selection==='other'?'selected':''}`}><input type="radio" name={`answer-${current.id}-${question.id}`} checked={answer.selection==='other'} onChange={()=>onChoose('other')}/><span><strong>{t('answerOther')}</strong><small>{t('answerOtherDescription')}</small></span></label>:null}</div>:null}
        {question.options.length===0||answer.selection==='other'?<label className="approval-custom-answer"><span>{t(question.isSecret?'secretAnswer':'answer')}</span>{question.isSecret?<input type="password" autoComplete="new-password" spellCheck={false} value={answer.text} onChange={event=>onType(event.target.value)}/>:<textarea rows={3} autoComplete="off" value={answer.text} onChange={event=>onType(event.target.value)}/>}<small>{t(question.isSecret?'secretAnswerHelp':'answerEmptyHelp')}</small></label>:null}
      </fieldset>:<p className="dialog-description">{t('noInputQuestions')}</p>}</>:<div className="approval-content"><p className="dialog-description">{t(supported?'approveDescription':'approvalUnsupported')}</p><ApprovalDetails request={current} t={t}/></div>}
      {error?<p className="approval-error" role="alert">{error}</p>:null}
      <div className="approval-footer"><button type="button" className="approval-decline" disabled={pending} onClick={()=>onSubmit(false)}>{t(isInput?'declineQuestions':'deny')}</button><div className="dialog-actions">{isInput?<><button type="button" disabled={pending||index===0} onClick={()=>move(-1)}>{t('previousQuestion')}</button>{question?<button type="button" disabled={pending} onClick={skip}>{t(last?(answered>0?'skipAndSendAnswers':'skipLastQuestion'):'skipQuestion')}</button>:null}<button type="submit" className="primary-button" disabled={pending||!canContinue}>{pending?<LoaderCircle size={13} className="spinner"/>:t(last?'sendAnswers':'nextQuestion')}</button></>:supported?<button type="submit" className="primary-button" disabled={pending}>{pending?<LoaderCircle size={13} className="spinner"/>:t('approve')}</button>:null}</div></div>
    </form></>:null}
  </Container>;
}

export function ElicitationPanel({snapshot,t,locale,contextName,onFormType=()=>{},onSubmit,formsEnabled=true}){
  const {current,pending,error,count,elicitation}=snapshot,element=useRef(null),composing=useRef(false),blockedSubmit=useRef(false),blockedCancel=useRef(false),submit=useRef(onSubmit);
  submit.current=onSubmit;
  const enabled=formsEnabled!==false&&elicitation?.enabled===true&&elicitation?.supported===true,values=enabled?elicitation.values:{},fields=elicitation?.fields??[],validation=elicitation?.validation??{valid:false};
  const number=value=>new Intl.NumberFormat(locale,{maximumSignificantDigits:21}).format(value);
  const constraintPlural=new Intl.PluralRules(locale?.startsWith('zh')?'zh-CN':'en');
  useEffect(()=>{
    const prior=document.activeElement,dialog=element.current;dialog.showModal();
    (dialog.querySelector('.approval-form-field input,.approval-form-field select,.approval-form-field textarea')??dialog.querySelector('button:not(:disabled)'))?.focus();
    const cancel=event=>{event.preventDefault();if(composing.current||blockedCancel.current)return;submit.current(false,{elicitationAction:'cancel'});};dialog.addEventListener('cancel',cancel);
    return()=>{composing.current=false;blockedSubmit.current=false;blockedCancel.current=false;dialog.removeEventListener('cancel',cancel);dialog.close();if(prior?.isConnected)prior.focus();};
  },[current.id]);
  useEffect(()=>{composing.current=false;blockedSubmit.current=false;blockedCancel.current=false;},[current.id,elicitation?.generation,enabled]);
  const respond=action=>{if(pending||action==='accept'&&(!enabled||!validation.valid))return;onSubmit(action==='accept',{elicitationAction:action});};
  const invalidField=fields.find(field=>field.name===validation.field);
  function hint(field){const rows=[];for(const [key,label]of[['minLength','elicitationMinLength'],['maxLength','elicitationMaxLength'],['minimum','elicitationMinimum'],['maximum','elicitationMaximum'],['minItems','elicitationMinItems'],['maxItems','elicitationMaxItems']])if(field[key]!==undefined)rows.push(t(key==='minLength'||key==='maxLength'?`${label}_${constraintPlural.select(field[key])}`:label,{count:number(field[key])}));return rows.join(t('elicitationConstraintSeparator'));}
  function defaultText(field){const label=value=>field.options?.find(option=>option.value===value)?.label??(typeof value==='boolean'?t(value?'elicitationYes':'elicitationNo'):typeof value==='number'?number(value):String(value));return Array.isArray(field.default)?new Intl.ListFormat(locale,{style:'short',type:'conjunction'}).format(field.default.map(label)):label(field.default);}
  return <dialog ref={element} className="dialog approval-panel approval-blocking approval-elicitation" aria-label={t('elicitationTitle')} aria-modal="true">
    <div className="dialog-heading approval-heading"><ShieldCheck size={17}/><h2>{t('elicitationTitle')}</h2>{pending?<LoaderCircle size={13} className="spinner" aria-label={t('sending')}/>:null}{count>1?<span className="approval-pending-count">{t('pendingApprovalCount',{count:number(count)})}</span>:null}<button type="button" className="icon-button" title={t('cancel')} aria-label={t('cancel')} disabled={pending} onClick={()=>respond('cancel')}><X size={17}/></button></div>
    <form noValidate onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onPointerDownCapture={()=>{if(!composing.current){blockedSubmit.current=false;blockedCancel.current=false;}}} onKeyDownCapture={event=>{blockedSubmit.current=event.key==='Enter'&&isComposing(event);blockedCancel.current=event.key==='Escape'&&isComposing(event);}} onSubmit={event=>{event.preventDefault();if(composing.current||blockedSubmit.current||isComposing(event))return;respond('accept');}}>
      <div className="approval-form-scroll">
        <div className="approval-form-source"><span>{t('elicitationServer')}</span><strong>{elicitation?.serverName||t('elicitationUnknownServer')}</strong>{contextName?<small>{t('approvalForChat',{name:contextName})}</small>:null}<p>{elicitation?.message}</p><small>{t('elicitationPurpose')}</small></div>
        {!enabled?<p className="dialog-description" role="status">{t(formsEnabled===false||elicitation?.enabled!==true?'elicitationDisabled':'elicitationUnsupported')}</p>:<>
          <p className="approval-form-help">{t('elicitationOmissionHelp')}</p>
          <fieldset className="approval-form-fields" disabled={pending}>
            {fields.map((field,index)=>{
              const title=field.title||field.name,id=`dsh-mcp-field-${index}`,has=Object.hasOwn(values,field.name),value=values[field.name],bad=!validation.valid&&validation.field===field.name&&has,help=hint(field),emptyString=field.type==='string'&&(!has||value==='')&&(field.minLength??0)===0,emptyArray=field.type==='multiselect'&&(!has||Array.isArray(value)&&value.length===0)&&(field.minItems??0)===0;
              const described=[field.description||help||Object.hasOwn(field,'default')?`${id}-help`:null,bad?`${id}-error`:null].filter(Boolean).join(' ')||undefined;
              return <div className="approval-form-field" key={field.name}>
                <label htmlFor={field.type==='multiselect'?undefined:id} id={`${id}-label`}><span>{title}</span><small>{t(field.required?'elicitationRequired':'elicitationOptional')}</small></label>
                {field.type==='boolean'?<select id={id} aria-required={field.required} aria-invalid={bad||undefined} aria-describedby={described} value={has?String(value):''} onChange={event=>onFormType(field.name,event.target.value===''?undefined:event.target.value==='true')}><option value="">{t('elicitationUnselected')}</option><option value="true">{t('elicitationYes')}</option><option value="false">{t('elicitationNo')}</option></select>
                  :field.type==='enum'?<select id={id} aria-required={field.required} aria-invalid={bad||undefined} aria-describedby={described} value={has?String(field.options.findIndex(option=>option.value===value)):''} onChange={event=>onFormType(field.name,event.target.value===''?undefined:field.options[Number(event.target.value)].value)}><option value="">{t('elicitationUnselected')}</option>{field.options.map((option,optionIndex)=><option key={option.value} value={String(optionIndex)}>{option.label||t('elicitationEmptyText')}</option>)}</select>
                    :field.type==='multiselect'?<div id={id} className="approval-form-options" role="group" aria-labelledby={`${id}-label`} aria-required={field.required} aria-invalid={bad||undefined} aria-describedby={described}>{field.options.map((option,optionIndex)=><label key={option.value} htmlFor={`${id}-option-${optionIndex}`}><input id={`${id}-option-${optionIndex}`} type="checkbox" checked={Array.isArray(value)&&value.includes(option.value)} onChange={event=>{const previous=Array.isArray(value)?value:[];onFormType(field.name,event.target.checked?[...previous,option.value]:previous.filter(choice=>choice!==option.value));}}/><span>{option.label||t('elicitationEmptyText')}</span></label>)}</div>
                      :<input id={id} type="text" inputMode={field.type==='integer'?'numeric':field.type==='number'?'decimal':undefined} autoComplete="off" spellCheck={false} aria-required={field.required} aria-invalid={bad||undefined} aria-describedby={described} value={has?String(value):''} onChange={event=>onFormType(field.name,!field.required&&event.target.value===''?undefined:event.target.value)}/>}
                {emptyString||emptyArray?<label className="approval-form-empty" htmlFor={`${id}-empty`}><input id={`${id}-empty`} type="checkbox" checked={has} onChange={event=>onFormType(field.name,event.target.checked?(emptyArray?[]:''):undefined)}/><span>{t(emptyArray?'elicitationProvideEmptyList':'elicitationProvideEmptyText')}</span></label>:null}
                {field.description||help||Object.hasOwn(field,'default')?<div className="approval-form-field-help" id={`${id}-help`}>{field.description?<p>{field.description}</p>:null}{help?<p>{help}</p>:null}{Object.hasOwn(field,'default')?<p>{t('elicitationSuggestedDefault',{value:defaultText(field)})}</p>:null}</div>:null}
                {bad?<p className="approval-field-error" role="status" id={`${id}-error`}>{t('elicitationFieldInvalid',{name:title})}</p>:null}
                {has&&!field.required?<button type="button" className="subtle-button approval-form-omit" onClick={()=>onFormType(field.name,undefined)}>{t('elicitationOmit')}</button>:null}
              </div>;
            })}
          </fieldset>
        </>}
      </div>
      <div className="approval-elicitation-bottom">{error?<p className="approval-error" role="alert">{error}</p>:null}{enabled&&!validation.valid&&Object.keys(values).length>0?<p className="approval-form-validation" role="status">{invalidField?t('elicitationFieldInvalid',{name:invalidField.title||invalidField.name}):t('elicitationInvalidContent')}</p>:null}<div className="approval-footer"><button type="button" className="approval-decline" disabled={pending} onClick={()=>respond('decline')}>{t('elicitationDecline')}</button><div className="dialog-actions"><button type="button" disabled={pending} onClick={()=>respond('cancel')}>{t('cancel')}</button>{enabled?<button type="submit" className="primary-button" disabled={pending||!validation.valid}>{pending?<LoaderCircle size={13} className="spinner"/>:t('elicitationAccept')}</button>:null}</div></div></div>
    </form>
  </dialog>;
}

function ApprovalDetails({request,t}){
  const details=approvalDetails(request);
  return details.length?<dl className="approval-details">{details.map((detail,index)=><div key={`${detail.key}:${index}`}><dt>{t(detail.key)}</dt><dd>{detail.preview!==undefined?<><details className="approval-change-preview" open={detail.preview.length<=1400&&(detail.preview.length>0||detail.empty===true)}><summary>{t('approvalPreviewText')}</summary><pre>{detail.empty?t('approvalEmptyContent'):detail.preview||t('approvalEmptyPreview')}</pre></details>{detail.truncated?<p className="approval-preview-truncated" role="note">{t('approvalPreviewTruncated')}</p>:null}</>:detail.key==='approvalCommand'?<pre>{detail.value}</pre>:detail.valueKey?<>{t(detail.valueKey)}{detail.suffix?<span> / {detail.suffix}</span>:null}</>:detail.value??t('enabled')}</dd></div>)}</dl>:<p className="dialog-description">{t('approvalNoDetails')}</p>;
}
