// Shared by the browser and the optional MCP form handler. Never apply defaults
// or convert wire values here: accepting a form requires explicit user content.
export const MCP_ELICITATION_LIMITS=Object.freeze({fields:20,options:100,stringBytes:20000,totalBytes:100000,arrayItems:100});
const limits=MCP_ELICITATION_LIMITS,encoder=new TextEncoder();
const fault=(code,field)=>Object.assign(new Error(code),{code,...(field===undefined?{}:{field})});
const unsupported=()=>{throw fault('MCP_ELICITATION_UNSUPPORTED');};
const own=(value,key)=>Object.hasOwn(value,key);
const record=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)return false;
  return Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.getOwnPropertyDescriptor(value,key)?.enumerable&&own(Object.getOwnPropertyDescriptor(value,key),'value'));
};
const array=value=>Array.isArray(value)&&Reflect.ownKeys(value).length===value.length+1&&Object.keys(value).every((key,index)=>key===String(index)&&own(Object.getOwnPropertyDescriptor(value,key),'value'));
function string(value,max=limits.stringBytes){
  if(typeof value!=='string'||value.includes('\0')||value.length>max)return false;
  for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(code>=0xdc00&&code<=0xdfff)return false;}
  return encoder.encode(value).length<=max;
}
const keys=(value,allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key));
const bounded=value=>{try{return encoder.encode(JSON.stringify(value)).length<=limits.totalBytes;}catch{return false;}};
function count(value,max=limits.stringBytes){if(!Number.isSafeInteger(value)||value<0||value>max)unsupported();return value;}
function choices(schema,titledKey){
  let options;
  if(titledKey){
    const rows=schema[titledKey];if(!array(rows)||rows.length===0||rows.length>limits.options)unsupported();
    options=rows.map(row=>{if(!keys(row,['const','title'])||!own(row,'const')||!own(row,'title')||!string(row.const)||!string(row.title))unsupported();return {value:row.const,label:row.title};});
  }else{
    if(!array(schema.enum)||schema.enum.length===0||schema.enum.length>limits.options||schema.enum.some(value=>!string(value)))unsupported();
    if(own(schema,'enumNames')&&(!array(schema.enumNames)||schema.enumNames.length!==schema.enum.length||schema.enumNames.some(value=>!string(value))))unsupported();
    options=schema.enum.map((value,index)=>({value,label:schema.enumNames?.[index]??value}));
  }
  if(new Set(options.map(option=>option.value)).size!==options.length)unsupported();return options;
}
function fieldSchema(name,schema,required){
  if(!record(schema)||!string(name,1024)||!name)unsupported();
  const common=['type','title','description','default'];
  if(own(schema,'title')&&!string(schema.title)||own(schema,'description')&&!string(schema.description))unsupported();
  let type=schema.type,options;
  const field={name,type,title:schema.title??name,description:schema.description??'',required};
  if(type==='string'){
    if(own(schema,'enum')||own(schema,'oneOf')){
      if(own(schema,'enum')&&own(schema,'oneOf'))unsupported();
      if(!keys(schema,[...common,...(own(schema,'oneOf')?['oneOf']:['enum','enumNames'])]))unsupported();
      options=choices(schema,own(schema,'oneOf')?'oneOf':null);field.type='enum';field.options=options;
    }else{
      if(!keys(schema,[...common,'minLength','maxLength']))unsupported();
      for(const key of ['minLength','maxLength'])if(own(schema,key))field[key]=count(schema[key]);
      if(field.minLength!==undefined&&field.maxLength!==undefined&&field.minLength>field.maxLength)unsupported();
    }
  }else if(type==='number'||type==='integer'){
    if(!keys(schema,[...common,'minimum','maximum']))unsupported();
    for(const key of ['minimum','maximum'])if(own(schema,key)){if(typeof schema[key]!=='number'||!Number.isFinite(schema[key]))unsupported();field[key]=schema[key];}
    if(field.minimum!==undefined&&field.maximum!==undefined&&field.minimum>field.maximum)unsupported();
  }else if(type==='boolean'){
    if(!keys(schema,common))unsupported();
  }else if(type==='array'){
    if(!keys(schema,[...common,'items','minItems','maxItems'])||!record(schema.items))unsupported();
    if(own(schema.items,'anyOf')){if(!keys(schema.items,['anyOf']))unsupported();options=choices(schema.items,'anyOf');}
    else{if(!keys(schema.items,['type','enum'])||schema.items.type!=='string')unsupported();options=choices(schema.items,null);}
    field.type='multiselect';field.options=options;
    for(const key of ['minItems','maxItems'])if(own(schema,key))field[key]=count(schema[key],limits.arrayItems);
    if(field.minItems!==undefined&&field.maxItems!==undefined&&field.minItems>field.maxItems)unsupported();
  }else unsupported();
  if(own(schema,'default')){try{field.default=validateField(field,schema.default);}catch{unsupported();}}
  return field;
}
function form(request){
  const params=request?.params;
  if(request?.method!=='mcpServer/elicitation/request'||!record(params)||params.mode!=='form'||!string(params.message)||!string(params.serverName,1024))unsupported();
  const schema=params.requestedSchema;
  if(!keys(schema,['$schema','type','properties','required'])||schema.type!=='object'||!record(schema.properties)||Object.keys(schema.properties).length>limits.fields)unsupported();
  if(own(schema,'$schema')&&!string(schema.$schema,1024))unsupported();
  const required=own(schema,'required')?schema.required:[];
  if(!array(required)||required.length>limits.fields||required.some(name=>typeof name!=='string'||!own(schema.properties,name))||new Set(required).size!==required.length)unsupported();
  const fields=Object.entries(schema.properties).map(([name,value])=>fieldSchema(name,value,required.includes(name)));
  if(!bounded({schema,message:params.message,serverName:params.serverName}))throw fault('MCP_ELICITATION_LIMIT');
  return {supported:true,fields,message:params.message,serverName:params.serverName,reasonCode:null};
}
export function elicitationForm(request){
  try{return form(request);}catch(error){return {supported:false,fields:[],message:string(request?.params?.message)?request.params.message:'',serverName:string(request?.params?.serverName,1024)?request.params.serverName:'',reasonCode:error.code==='MCP_ELICITATION_LIMIT'?error.code:'MCP_ELICITATION_UNSUPPORTED'};}
}
function validateField(field,value){
  const invalid=()=>{throw fault('MCP_ELICITATION_INVALID_CONTENT',field.name);};
  if(field.type==='string'||field.type==='enum'){
    if(!string(value))invalid();
    if(field.type==='enum'&&!field.options.some(option=>option.value===value))invalid();
    const length=Array.from(value).length;
    if(field.minLength!==undefined&&length<field.minLength||field.maxLength!==undefined&&length>field.maxLength)invalid();
    return value;
  }
  if(field.type==='number'||field.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||field.type==='integer'&&!Number.isSafeInteger(value)||field.minimum!==undefined&&value<field.minimum||field.maximum!==undefined&&value>field.maximum)invalid();return value;
  }
  if(field.type==='boolean'){if(typeof value!=='boolean')invalid();return value;}
  if(field.type==='multiselect'){
    if(!array(value)||value.length>limits.arrayItems||value.some(item=>typeof item!=='string'||!field.options.some(option=>option.value===item))||new Set(value).size!==value.length||field.minItems!==undefined&&value.length<field.minItems||field.maxItems!==undefined&&value.length>field.maxItems)invalid();return [...value];
  }
  invalid();
}
export function validateElicitationContent(request,content){
  const normalized=form(request);
  if(!record(content))throw fault('MCP_ELICITATION_INVALID_CONTENT');
  const known=new Map(normalized.fields.map(field=>[field.name,field]));
  if(Object.keys(content).some(name=>!known.has(name)))throw fault('MCP_ELICITATION_INVALID_CONTENT');
  const entries=[];
  for(const field of normalized.fields){if(!own(content,field.name)){if(field.required)throw fault('MCP_ELICITATION_INVALID_CONTENT',field.name);continue;}entries.push([field.name,validateField(field,content[field.name])]);}
  const result=Object.fromEntries(entries);if(!bounded(result))throw fault('MCP_ELICITATION_LIMIT');return result;
}
// UI-only conversion. The wire validator above deliberately rejects numeric
// strings. Omitted optionals remain absent, including fields with defaults.
export function coerceElicitationContent(request,values){
  const normalized=form(request);if(!record(values))throw fault('MCP_ELICITATION_INVALID_CONTENT');
  const known=new Map(normalized.fields.map(field=>[field.name,field]));
  const entries=Object.entries(values).flatMap(([name,value])=>{
    const field=known.get(name);if(!field)throw fault('MCP_ELICITATION_INVALID_CONTENT');if(value===undefined)return [];
    if(field.type==='number'||field.type==='integer'){
      if(typeof value!=='string')throw fault('MCP_ELICITATION_INVALID_CONTENT',name);
      const text=value.trim();if(!text)return [];
      if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text))throw fault('MCP_ELICITATION_INVALID_CONTENT',name);
      value=Number(text);
    }
    return [[name,value]];
  });return validateElicitationContent(request,Object.fromEntries(entries));
}
