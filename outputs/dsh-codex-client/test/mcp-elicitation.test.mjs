import test from 'node:test';
import assert from 'node:assert/strict';
import {elicitationForm,validateElicitationContent,coerceElicitationContent,MCP_ELICITATION_LIMITS} from '../shared/mcp-elicitation.js';
const request=(properties,required=[],extra={})=>({id:42,method:'mcpServer/elicitation/request',params:{mode:'form',message:'Enter owned information',serverName:'owned',requestedSchema:{type:'object',properties,required},...extra}});
const all=()=>request({text:{type:'string',minLength:1,maxLength:4},count:{type:'integer',minimum:0,maximum:3},ratio:{type:'number',minimum:0,maximum:2},flag:{type:'boolean'},single:{type:'string',oneOf:[{const:'a',title:'A'},{const:'b',title:'B'}]},legacy:{type:'string',enum:['a','b'],enumNames:['甲','乙']},multi:{type:'array',items:{anyOf:[{const:'a',title:'A'},{const:'b',title:'B'}]},minItems:0,maxItems:2},optional:{type:'string',default:'Not automatically accepted'}},['text','count','ratio','flag','single','multi']);
test('typed standard form normalizes supported fields and retains zero/false/empty multi while omitting defaults',()=>{
  const r=all(),form=elicitationForm(r);assert.equal(form.supported,true);assert.deepEqual(form.fields.map(f=>f.type),['string','integer','number','boolean','enum','enum','multiselect','string']);assert.deepEqual(form.fields[5].options,[{value:'a',label:'甲'},{value:'b',label:'乙'}]);
  const content={text:'中😀',count:0,ratio:1.25,flag:false,single:'a',multi:[]},result=validateElicitationContent(r,content);assert.deepEqual(result,content);assert.equal(Object.hasOwn(result,'optional'),false);assert.notEqual(result.multi,content.multi);content.multi.push('a');assert.deepEqual(result.multi,[]);
});
test('required means explicit own-presence, distinct from empty strings and optional omission',()=>{
  const r=request({empty:{type:'string'},no:{type:'boolean'},zero:{type:'integer'},many:{type:'array',items:{type:'string',enum:['a']}}},['empty','no','zero','many']);
  assert.deepEqual(validateElicitationContent(r,{empty:'',no:false,zero:0,many:[]}),{empty:'',no:false,zero:0,many:[]});
  for(const key of ['empty','no','zero','many']){const content={empty:'',no:false,zero:0,many:[]};delete content[key];assert.throws(()=>validateElicitationContent(r,content),{code:'MCP_ELICITATION_INVALID_CONTENT',field:key});}
});
test('bounds, strict typed values, membership, duplicates and unexpected fields are enforced',()=>{
  const r=all(),good={text:'中😀',count:0,ratio:1.25,flag:false,single:'a',multi:[]};
  for(const patch of [{text:''},{text:'12345'},{count:'0'},{count:1.5},{count:-1},{ratio:Infinity},{ratio:3},{flag:'false'},{single:'unknown'},{multi:['a','a']},{multi:['unknown']},{extra:true}])assert.throws(()=>validateElicitationContent(r,{...good,...patch}),{code:'MCP_ELICITATION_INVALID_CONTENT'});
  assert.throws(()=>validateElicitationContent(r,null),{code:'MCP_ELICITATION_INVALID_CONTENT'});
});
test('UI coercion is separate from wire validation, preserving blanks and rejecting partial numeric input',()=>{
  const r=all(),raw={text:'中😀',count:'0',ratio:' 1.25 ',flag:false,single:'a',multi:[],optional:undefined};assert.deepEqual(coerceElicitationContent(r,raw),{text:'中😀',count:0,ratio:1.25,flag:false,single:'a',multi:[]});
  for(const count of ['','-','01','NaN','Infinity','1e999','1.5'])assert.throws(()=>coerceElicitationContent(r,{...raw,count}),{code:'MCP_ELICITATION_INVALID_CONTENT'});
  const optional=request({n:{type:'number'},s:{type:'string'}});assert.deepEqual(coerceElicitationContent(optional,{n:'',s:''}),{s:''});
});
test('unknown formats, constraints, nested objects, extended modes and malformed schema fail closed',()=>{
  for(const properties of [{a:{type:'string',format:'email'}},{a:{type:'string',pattern:'.*'}},{a:{type:'object',properties:{}}},{a:{type:'number',exclusiveMinimum:0}},{a:{type:'array',items:{type:'number'}}},{a:{type:'string',title:null}},{a:{type:'string',description:null}},{a:{type:'string',enum:['a'],oneOf:[{const:'a',title:'A'}]}},{a:{type:'string',oneOf:[{const:'a',title:'A',unknown:true}]}}])assert.equal(elicitationForm(request(properties)).supported,false);
  for(const mode of ['url','openai/form','openaiForm','openai/userVerification',undefined])assert.equal(elicitationForm(request({},[],{mode})).supported,false);
  for(const patch of [{required:null},{required:['missing']},{required:['a','a']},{additionalProperties:false}]){const r=request({a:{type:'string'}});Object.assign(r.params.requestedSchema,patch);assert.equal(elicitationForm(r).supported,false);}
});
test('bad defaults are unsupported and valid defaults are copied for display without becoming answers',()=>{
  for(const schema of [{type:'number',default:'1'},{type:'integer',default:1.2},{type:'string',enum:['a'],default:'b'},{type:'array',items:{type:'string',enum:['a']},default:['a','a']}])assert.equal(elicitationForm(request({a:schema})).supported,false);
  const r=request({a:{type:'array',items:{type:'string',enum:['a']},default:['a']}}),f=elicitationForm(r);f.fields[0].default.push('b');assert.deepEqual(r.params.requestedSchema.properties.a.default,['a']);assert.deepEqual(validateElicitationContent(r,{}),{});
});
test('schema and contents are bounded, including Unicode byte limits and aggregate answers',()=>{
  assert.equal(elicitationForm(request(Object.fromEntries(Array.from({length:21},(_,i)=>['n'+i,{type:'string'}])))).supported,false);
  const props=Object.fromEntries(Array.from({length:10},(_,i)=>['n'+i,{type:'string'}])),r=request(props);assert.throws(()=>validateElicitationContent(r,Object.fromEntries(Object.keys(props).map(name=>[name,'x'.repeat(11000)]))),{code:'MCP_ELICITATION_LIMIT'});
  assert.throws(()=>validateElicitationContent(request({a:{type:'string'}}),{a:'中'.repeat(7000)}),{code:'MCP_ELICITATION_INVALID_CONTENT'});assert.equal(MCP_ELICITATION_LIMITS.totalBytes,100000);
  for(const value of ['a\0b','\ud800','\udfff'])assert.throws(()=>validateElicitationContent(request({a:{type:'string'}}),{a:value}),{code:'MCP_ELICITATION_INVALID_CONTENT'});
});
test('special own-property names remain data without prototype mutation or inherited answers',()=>{
  const props=JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"boolean"},"toString":{"type":"integer"}}'),r=request(props,Object.keys(props)),input=JSON.parse('{"__proto__":"literal","constructor":false,"toString":0}'),result=validateElicitationContent(r,input);assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.equal(Object.hasOwn(result,'__proto__'),true);assert.deepEqual(result,input);assert.equal({}.literal,undefined);
  const inherited=Object.create({constructor:false});inherited.__proto__='literal';assert.throws(()=>validateElicitationContent(r,inherited),{code:'MCP_ELICITATION_INVALID_CONTENT'});
});
test('custom properties, getters, symbols and sparse enum arrays are not silently discarded',()=>{
  const options=['a'];options.extra=true;assert.equal(elicitationForm(request({a:{type:'string',enum:options}})).supported,false);
  let enumRead=0;const accessor=['a'];Object.defineProperty(accessor,0,{enumerable:true,get(){enumRead++;return'a';}});assert.equal(elicitationForm(request({a:{type:'string',enum:accessor}})).supported,false);assert.equal(enumRead,0);
  let invoked=0;const content={};Object.defineProperty(content,'a',{enumerable:true,get(){invoked++;return 'secret';}});assert.throws(()=>validateElicitationContent(request({a:{type:'string'}}),content),{code:'MCP_ELICITATION_INVALID_CONTENT'});assert.equal(invoked,0);
  const value={a:'x',[Symbol('unknown')]:true};assert.throws(()=>validateElicitationContent(request({a:{type:'string'}}),value),{code:'MCP_ELICITATION_INVALID_CONTENT'});
});
