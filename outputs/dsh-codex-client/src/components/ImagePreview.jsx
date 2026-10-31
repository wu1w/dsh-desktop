import React,{useEffect,useRef,useState} from 'react';
import {ZoomIn,ZoomOut} from 'lucide-react';
import {imageLocales} from '../image-locales.js';
import './image-preview.css';

const MAX_BYTES=16*1024*1024,MAX_PIXELS=32000000,MAX_EDGE=16384;
const validDimensions=(width,height)=>Number.isSafeInteger(width)&&width>0&&width<=MAX_EDGE&&Number.isSafeInteger(height)&&height>0&&height<=MAX_EDGE&&width*height<=MAX_PIXELS;
export function imagePreviewIdentity(file){
  const preview=file?.preview;
  if(typeof file?.projectId!=='string'||!file.projectId||typeof file?.path!=='string'||!file.path||!preview||preview.kind!=='image'||!['image/png','image/jpeg','image/webp'].includes(preview.mime)||typeof preview.version!=='string'||!/^[a-f0-9]{64}$/.test(preview.version)||!validDimensions(preview.width,preview.height)||!Number.isSafeInteger(preview.size)||preview.size<=0||preview.size>MAX_BYTES)return null;
  return JSON.stringify([file.projectId,file.path,preview.version,preview.mime,preview.width,preview.height,preview.size]);
}
export function imageFitScale(width,height,viewport){
  if(!validDimensions(width,height)||!(viewport?.width>32)||!(viewport?.height>32))return 1;
  return Math.min(1,(viewport.width-32)/width,(viewport.height-32)/height);
}
export function imageZoomScale(scale,direction){
  return Math.min(4,Math.max(.1,Math.round(scale*(direction>0?1.25:.8)*10000)/10000));
}
function localeFor(locale){try{return new Intl.NumberFormat(locale).resolvedOptions().locale;}catch{return 'en';}}
function translate(t,locale,key,params={}){
  let value;try{value=t?.(key,params);}catch{}
  if(typeof value!=='string'||value===key)value=imageLocales[locale]?.[key]??imageLocales[typeof locale==='string'&&locale.startsWith('zh')?'zh-CN':'en'][key]??imageLocales.en[key]??key;
  return value.replace(/\{(\w+)\}/g,(match,name)=>Object.hasOwn(params,name)?String(params[name]):match);
}
function errorCode(error){return typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)?error.code:'IMAGE_LOAD_FAILED';}
export function imagePreviewSize(bytes,locale){
  const unit=bytes>=1e6?'megabyte':bytes>=1e3?'kilobyte':'byte',divisor=unit==='megabyte'?1e6:unit==='kilobyte'?1e3:1;
  return new Intl.NumberFormat(localeFor(locale),{style:'unit',unit,unitDisplay:'short',maximumFractionDigits:divisor===1?0:1}).format(bytes/divisor);
}

export function ImagePreview({file,locale='en',t,loadImage,onRetry,enabled=true}){
  const identity=imagePreviewIdentity(file),canLoad=typeof loadImage==='function',stage=useRef(null),mounted=useRef(false),urls=useRef(new Set()),retryRequest=useRef(null),current=useRef(null);
  const [load,setLoad]=useState(null),[viewport,setViewport]=useState(null),[view,setView]=useState(null),[retryKey,setRetryKey]=useState(0),[retryState,setRetryState]=useState(null);
  current.current={identity,enabled};
  const text=(key,params)=>translate(t,locale,key,params),owned=load?.identity===identity?load:null;
  const status=!enabled?'disabled':!identity||!canLoad?'error':owned?.status??'loading',ready=status==='ready';
  const dimensions=owned?.dimensions??file?.preview??{},width=dimensions.width??1,height=dimensions.height??1;
  const available=viewport?.identity===identity?viewport:{width:0,height:0},currentView=view?.identity===identity?view:{mode:'fit',scale:1};
  const scale=currentView.mode==='fit'?imageFitScale(width,height,available):currentView.scale;
  const imageWidth=width*scale,imageHeight=height*scale,canvasWidth=Math.max(available.width,imageWidth+32),canvasHeight=Math.max(available.height,imageHeight+32);
  const zoomIn=ready&&scale<4,zoomOut=ready&&scale>.100001,retrying=retryState?.identity===identity&&retryState.busy;
  const number=new Intl.NumberFormat(localeFor(locale)),percent=new Intl.NumberFormat(localeFor(locale),{style:'percent',maximumFractionDigits:1}).format(scale);
  function release(url){if(url&&urls.current.delete(url))try{globalThis.URL.revokeObjectURL(url);}catch{}}
  function isCurrent(){return mounted.current&&current.current.identity===identity&&current.current.enabled;}
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;for(const url of [...urls.current])release(url);};
  },[]);
  useEffect(()=>{
    if(!enabled||!identity||!canLoad)return;
    const abort=new AbortController();let active=true,url=null;
    setLoad({identity,status:'loading'});
    void Promise.resolve().then(()=>{
      if(!active||abort.signal.aborted||!isCurrent())return null;
      return loadImage(abort.signal);
    }).then(blob=>{
      if(!active||abort.signal.aborted||!isCurrent())return;
      if(!(blob instanceof Blob)||blob.size<=0||blob.size>MAX_BYTES||blob.type!==file.preview.mime)throw Object.assign(new Error('IMAGE_LOAD_FAILED'),{code:'IMAGE_LOAD_FAILED'});
      url=globalThis.URL.createObjectURL(blob);urls.current.add(url);
      setLoad({identity,status:'decoding',url});
    }).catch(error=>{
      if(active&&!abort.signal.aborted&&isCurrent())setLoad({identity,status:'error',code:errorCode(error)});
    });
    return()=>{active=false;abort.abort();release(url);};
  },[identity,enabled,canLoad,retryKey]);
  useEffect(()=>{
    const element=stage.current;if(!element||!enabled||!identity)return;
    let active=true;
    const measure=()=>{
      if(!active||!isCurrent())return;
      const width=element.clientWidth,height=element.clientHeight;
      setViewport(previous=>previous?.identity===identity&&previous.width===width&&previous.height===height?previous:{identity,width,height});
    };
    measure();
    if(typeof globalThis.ResizeObserver==='function'){
      const observer=new globalThis.ResizeObserver(measure);observer.observe(element);
      return()=>{active=false;observer.disconnect();};
    }
    globalThis.addEventListener?.('resize',measure);
    return()=>{active=false;globalThis.removeEventListener?.('resize',measure);};
  },[identity,enabled]);
  useEffect(()=>{
    if(stage.current&&(currentView.mode==='fit'||currentView.mode==='actual')){stage.current.scrollLeft=0;stage.current.scrollTop=0;}
  },[identity,currentView.mode]);
  function mode(value){if(ready&&isCurrent())setView({identity,mode:value,scale:1});}
  function zoom(direction){if(!isCurrent()||!(direction>0?zoomIn:zoomOut))return;setView({identity,mode:'manual',scale:imageZoomScale(scale,direction)});}
  function decoded(event){
    const naturalWidth=event.currentTarget.naturalWidth,naturalHeight=event.currentTarget.naturalHeight,url=owned?.url;
    if(!isCurrent())return;
    if(!validDimensions(naturalWidth,naturalHeight)){failed(url,'IMAGE_LOAD_FAILED');return;}
    // Browsers apply JPEG EXIF orientation to natural dimensions. Use those
    // dimensions rather than rejecting a legitimate rotated image.
    setLoad(previous=>previous?.identity===identity&&previous.url===url?{...previous,status:'ready',dimensions:{width:naturalWidth,height:naturalHeight}}:previous);
  }
  function failed(url,code='IMAGE_LOAD_FAILED'){
    release(url);
    if(isCurrent())setLoad(previous=>previous?.identity===identity&&previous.url===url?{identity,status:'error',code}:previous);
  }
  async function retry(){
    if(!enabled||!identity||!canLoad||retryRequest.current?.identity===identity)return;
    const token={identity};retryRequest.current=token;setRetryState({identity,busy:true});
    try{
      await onRetry?.();
      if(isCurrent())setRetryKey(value=>value+1);
    }catch(error){if(isCurrent())setLoad({identity,status:'error',code:errorCode(error)});}
    finally{if(retryRequest.current===token){retryRequest.current=null;if(isCurrent())setRetryState({identity,busy:false});}}
  }
  function keyDown(event){
    if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||!ready||!enabled||!event.currentTarget.contains(event.target))return;
    if(event.target?.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(event.target?.tagName))return;
    const key=event.key;if(!['+','=','-','−','0','1'].includes(key))return;
    event.preventDefault();event.stopPropagation();
    if(key==='0')mode('fit');else if(key==='1')mode('actual');else zoom(key==='+'||key==='='?1:-1);
  }
  const code=owned?.code??'IMAGE_LOAD_FAILED',translated=text(code),errorMessage=translated===code?text('imageLoadFailed'):translated;
  let modified=null;try{if(file?.preview?.modifiedAt!=null){const date=new Date(file.preview.modifiedAt);if(Number.isFinite(date.getTime()))modified=new Intl.DateTimeFormat(localeFor(locale),{dateStyle:'medium',timeStyle:'short'}).format(date);}}catch{}
  return <section className="image-preview" tabIndex={0} aria-label={text('imagePreview')} title={text('imageKeyboardHelp')} onKeyDown={keyDown}>
    <div className="image-preview-toolbar" role="group" aria-label={text('imageControls')}>
      <button type="button" className="subtle-button" disabled={!ready} aria-pressed={currentView.mode==='fit'} onClick={()=>mode('fit')}>{text('imageFit')}</button>
      <button type="button" className="subtle-button" disabled={!ready} aria-pressed={currentView.mode==='actual'} onClick={()=>mode('actual')}>{text('imageActual')}</button>
      <span className="image-preview-zoom"><button type="button" className="icon-button" disabled={!zoomOut} aria-label={text('imageZoomOut')} onClick={()=>zoom(-1)}><ZoomOut size={15}/></button><output aria-label={text('imageZoomValue',{value:percent})}>{percent}</output><button type="button" className="icon-button" disabled={!zoomIn} aria-label={text('imageZoomIn')} onClick={()=>zoom(1)}><ZoomIn size={15}/></button></span>
      <span className="image-preview-readonly">{text('imageReadOnly')}</span>
    </div>
    <div ref={stage} className="image-preview-stage" role="region" aria-label={text('imagePreview')} aria-busy={status==='loading'||status==='decoding'}>
      {enabled&&owned?.url&&(status==='ready'||status==='decoding')?<div className="image-preview-canvas" style={{width:canvasWidth,height:canvasHeight}}><img src={owned.url} alt={text('imageAlt',{name:file?.name||text('imageUnknownName')})} decoding="async" draggable={false} className={status==='decoding'?'image-preview-image decoding':'image-preview-image'} style={{width:imageWidth,height:imageHeight,left:Math.max(16,(canvasWidth-imageWidth)/2),top:Math.max(16,(canvasHeight-imageHeight)/2)}} onLoad={decoded} onError={()=>failed(owned.url)}/></div>:null}
      {status!=='ready'?<div className="image-preview-status" role={status==='error'?'alert':'status'}><p>{status==='error'?errorMessage:status==='disabled'?text('imageDisabled'):text('imageLoading')}</p>{status==='error'?<button type="button" className="subtle-button" disabled={!enabled||!identity||!canLoad||retrying} onClick={retry}>{text(retrying?'imageLoading':'imageRetry')}</button>:null}</div>:null}
    </div>
    {identity?<div className="image-preview-metadata" aria-label={text('imageMetadata')}><span>{text('imageDimensions',{width:number.format(width),height:number.format(height)})}</span><span>{imagePreviewSize(file.preview.size,locale)}</span><span>{file.preview.mime.slice(6).toUpperCase()}</span>{modified?<time dateTime={new Date(file.preview.modifiedAt).toISOString()}>{modified}</time>:null}</div>:null}
  </section>;
}
