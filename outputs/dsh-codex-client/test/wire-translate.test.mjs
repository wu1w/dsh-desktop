import test from 'node:test';
import assert from 'node:assert/strict';
import {translateRequest, translateJson, createStreamTranslator} from '../server/wire-translate.mjs';

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null, extra = {}) => ({choices:[{index:0, delta, finish_reason}], ...extra});
function fixture(api = 'openai-responses', options = {}) {
  const parts = [], translator = createStreamTranslator(api, 'fixture', {write:part => {parts.push(part); return true;}}, options);
  return {translator, events:() => parts.join('').split('\n\n').filter(Boolean).map(block => JSON.parse(block.split('\n').find(row => row.startsWith('data: ')).slice(6)))};
}
function send(f, rows, size = 7) {
  const bytes = rows.join(''); for (let i=0; i<bytes.length; i+=size) f.translator.push(bytes.slice(i,i+size));
  f.translator.finish(); return f.events();
}

test('translated routes explicitly reject image/file/audio input before transmission', () => {
  for (const part of [{type:'input_image', image_url:'data:image/png;base64,PRIVATE'}, {type:'input_file', file_id:'file'}, {type:'input_audio', input_audio:{}}]) {
    assert.throws(() => translateRequest('openai-responses',{input:[{role:'user',content:[{type:'input_text',text:'inspect'},part]}]}), {code:'MODEL_INPUT_UNSUPPORTED'});
  }
  assert.throws(() => translateRequest('anthropic-messages',{messages:[{role:'user',content:[{type:'image',source:{type:'base64',data:'PRIVATE'}}]}]}), {code:'MODEL_INPUT_UNSUPPORTED'});
  assert.throws(() => translateRequest('openai-responses',{input:[{type:'function_call_output',call_id:'a',output:[{type:'input_image',image_url:'PRIVATE'}]}]}), {code:'MODEL_INPUT_UNSUPPORTED'});
});

test('parallel tool calls and text-only results remain a valid assistant/tools exchange', () => {
  const request = translateRequest('openai-responses',{model:'fixture',stream:true,input:[
    {role:'developer',content:[{type:'input_text',text:'Instructions'}]},
    {type:'function_call',call_id:'one',name:'read',arguments:'{"path":"one"}'},
    {type:'function_call',call_id:'two',name:'read',arguments:'{"path":"two"}'},
    {type:'function_call_output',call_id:'one',output:[{type:'input_text',text:'hello'}]},
    {type:'function_call_output',call_id:'two',output:'world'},
  ]});
  assert.equal(request.messages[0].role,'system'); assert.equal(request.messages[1].tool_calls.length,2);
  assert.deepEqual(request.messages.slice(2).map(m => [m.role,m.tool_call_id,m.content]),[['tool','one','hello'],['tool','two','world']]);
  assert.deepEqual(request.stream_options,{include_usage:true});
});

test('Responses custom tools roundtrip without changing the tool input syntax', () => {
  const tools = [{type:'custom',name:'apply_patch',description:'Supply a patch'}];
  const request = translateRequest('openai-responses',{model:'fixture',tools,input:[{type:'custom_tool_call',call_id:'a',name:'apply_patch',input:'*** patch ***'},{type:'custom_tool_call_output',call_id:'a',output:'ok'}]});
  assert.deepEqual(request.tools[0].function.parameters.required,['input']);
  assert.equal(JSON.parse(request.messages[0].tool_calls[0].function.arguments).input,'*** patch ***');
  const f = fixture('openai-responses',{tools});
  const events = send(f,[frame(chunk({tool_calls:[{index:0,id:'a',function:{name:'apply_patch',arguments:'{"input":"*** patch ***"}'}}]})),frame(chunk({},'tool_calls')),'data: [DONE]\n\n']);
  const final = events.at(-1).response.output[0];
  assert.equal(final.type,'custom_tool_call'); assert.equal(final.input,'*** patch ***');
  assert.equal(events.find(e => e.type==='response.custom_tool_call_input.delta').item_id,final.id);
});

test('unsupported built-in tools and remote response state fail explicitly', () => {
  assert.throws(() => translateRequest('openai-responses',{input:'hello',tools:[{type:'web_search'}]}),{code:'MODEL_TOOL_UNSUPPORTED'});
  assert.throws(() => translateRequest('openai-responses',{input:'hello',previous_response_id:'resp_private'}),{code:'MODEL_INPUT_UNSUPPORTED'});
});

test('fragmented CRLF text stream preserves stable IDs, ordered events, full final text and real usage', () => {
  const f=fixture();
  const events=send(f,[': keepalive\r\n\r\n',frame(chunk({role:'assistant'})),frame(chunk({content:'你好'})),frame(chunk({content:' world'})),frame(chunk({},'stop',{usage:{prompt_tokens:12,completion_tokens:7}})),'data: [DONE]\n\n'].map(s=>s.replace(/(?<!\r)\n/g,'\r\n')),1);
  const start=events.find(e=>e.type==='response.created'), end=events.at(-1);
  assert.equal(end.type,'response.completed'); assert.equal(end.response.id,start.response.id);
  assert.equal(end.response.output[0].content[0].text,'你好 world'); assert.deepEqual(end.response.usage,{input_tokens:12,output_tokens:7,total_tokens:19});
  const itemId=end.response.output[0].id;
  for(const e of events.filter(e=>e.item_id)) assert.equal(e.item_id,itemId);
  assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));
});

test('parallel fragmented tools share stable item IDs across added, delta, done and final output', () => {
  const f=fixture(), events=send(f,[
    frame(chunk({content:'Reading files.'})),
    frame(chunk({tool_calls:[{index:1,id:'call_b',function:{name:'read',arguments:'{"path":'}},{index:0,id:'call_a',function:{name:'read',arguments:'{"path":"a"}'}}]})),
    frame(chunk({tool_calls:[{index:1,function:{arguments:'"b"}'}}]})),
    frame(chunk({},'tool_calls')),frame({choices:[],usage:{prompt_tokens:4,completion_tokens:9}}),'data: [DONE]\n\n',
  ]);
  const final=events.at(-1).response;
  assert.deepEqual(final.output.filter(i=>i.type==='function_call').map(i=>i.call_id),['call_a','call_b']);
  assert.equal(final.output.length,3); assert.equal(final.usage.total_tokens,13);
  for(const item of final.output.filter(i=>i.type==='function_call')) {
    const added=events.find(e=>e.type==='response.output_item.added'&&e.item.id===item.id);
    const delta=events.find(e=>e.type==='response.function_call_arguments.delta'&&e.item_id===item.id);
    const done=events.find(e=>e.type==='response.output_item.done'&&e.item.id===item.id);
    assert.equal(delta.delta,item.arguments); assert.equal(added.output_index,done.output_index); assert.deepEqual(done.item,item);
  }
});

test('premature EOF, missing finish reason and missing DONE never publish successful completion or tools', () => {
  for(const api of ['openai-responses','anthropic-messages']) for(const rows of [
    [frame(chunk({content:'partial'}))],
    [frame(chunk({content:'partial'})),'data: [DONE]\n\n'],
    [frame(chunk({tool_calls:[{index:0,id:'call',function:{name:'write',arguments:'{"path":"x"}'}}]})),frame(chunk({},'tool_calls'))],
  ]) {
    const f=fixture(api); assert.throws(()=>send(f,rows),{code:'MODEL_STREAM_INCOMPLETE'});
    assert(!f.events().some(e=>['response.completed','message_stop'].includes(e.type)));
    assert(!f.events().some(e=>e.item?.type==='function_call'||e.content_block?.type==='tool_use'));
  }
});

test('malformed/error events, aborted generation and incomplete tool JSON fail closed', () => {
  for(const [rows,code] of [
    [['data: {invalid}\n\n'],'MODEL_PROTOCOL_INVALID'],
    [[frame({error:{message:'PRIVATE'}})],'MODEL_REQUEST_FAILED'],
    [[frame(chunk({},'aborted'))],'MODEL_STREAM_INCOMPLETE'],
    [[frame(chunk({tool_calls:[{index:0,id:'c',function:{name:'write',arguments:'{"path":'}}]})),frame(chunk({},'tool_calls')),'data: [DONE]\n\n'],'MODEL_PROTOCOL_INVALID'],
  ]) {
    const f=fixture(); assert.throws(()=>send(f,rows),{code});
    assert(!f.events().some(e=>e.type==='response.completed'||e.item?.type==='function_call'));
  }
});

test('length and content filtering emit incomplete, never release partial tool calls', () => {
  for(const reason of ['length','content_filter']) {
    const f=fixture(), events=send(f,[frame(chunk({content:'partial',tool_calls:[{index:0,id:'c',function:{name:'write',arguments:'{"path":'}}]})),frame(chunk({},reason)),'data: [DONE]\n\n']);
    assert.equal(events.at(-1).type,'response.incomplete'); assert.equal(events.at(-1).response.status,'incomplete');
    assert.equal(events.at(-1).response.output.length,1); assert(!events.some(e=>e.item?.type==='function_call'));
  }
});

test('Anthropic translated stream retains text and tool output and final token counts', () => {
  const f=fixture('anthropic-messages'), events=send(f,[frame(chunk({content:'OK'})),frame(chunk({tool_calls:[{index:0,id:'c',function:{name:'read',arguments:'{"path":"x"}'}}]})),frame(chunk({},'tool_calls',{usage:{prompt_tokens:8,completion_tokens:5}})),'data: [DONE]\n\n']);
  assert.deepEqual(events.filter(e=>e.type==='content_block_start').map(e=>e.index),[0,1]);
  const end=events.find(e=>e.type==='message_delta'); assert.equal(end.delta.stop_reason,'tool_use'); assert.deepEqual(end.usage,{input_tokens:8,output_tokens:5});
  assert.equal(events.at(-1).type,'message_stop');
});

test('non-stream responses reject missing terminal/errors and preserve tools, usage, truncation', () => {
  assert.throws(()=>translateJson('openai-responses',{choices:[{message:{content:'partial'}}]},'fixture'),{code:'MODEL_STREAM_INCOMPLETE'});
  assert.throws(()=>translateJson('openai-responses',{error:{message:'PRIVATE'}},'fixture'),{code:'MODEL_REQUEST_FAILED'});
  const response=translateJson('openai-responses',{choices:[{message:{content:'hi'},finish_reason:'length'}],usage:{prompt_tokens:2,completion_tokens:3}},'fixture');
  assert.equal(response.status,'incomplete'); assert.equal(response.incomplete_details.reason,'max_output_tokens'); assert.equal(response.usage.total_tokens,5);
  const tool=translateJson('anthropic-messages',{choices:[{message:{tool_calls:[{id:'c',function:{name:'read',arguments:'{"path":"x"}'}}]},finish_reason:'tool_calls'}]},'fixture');
  assert.deepEqual(tool.content[0],{type:'tool_use',id:'c',name:'read',input:{path:'x'}});
});

test('multiline SSE data and repeated terminal operations are handled without duplicate completion', () => {
  const f=fixture(), events=send(f,['data: {"choices":\n','data: [{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n','data: [DONE]\n\n']);
  assert.equal(events.at(-1).response.output[0].content[0].text,'hello');
  assert.throws(()=>f.translator.finish(),{code:'MODEL_PROTOCOL_INVALID'});
  assert.equal(f.events().filter(e=>e.type==='response.completed').length,1);
});

test('UTF-8 byte fragmentation survives the proxy streaming decoder for both protocols', () => {
  for(const api of ['openai-responses','anthropic-messages']) {
    const f=fixture(api), decoder=new TextDecoder(), data=Buffer.from(frame(chunk({content:'你好 🌍'}))+frame(chunk({},'stop'))+'data: [DONE]\n\n');
    for(let i=0;i<data.length;i++) f.translator.push(decoder.decode(data.subarray(i,i+1),{stream:true}));
    f.translator.push(decoder.decode()); f.translator.finish();
    const events=f.events();
    const text=api==='openai-responses'?events.at(-1).response.output[0].content[0].text:events.filter(e=>e.type==='content_block_delta').map(e=>e.delta.text??'').join('');
    assert.equal(text,'你好 🌍');
  }
});

test('cancellation or closed downstream prevents any late completion or tool release', () => {
  for(const api of ['openai-responses','anthropic-messages']) {
    const controller=new AbortController(), f=fixture(api,{signal:controller.signal});
    f.translator.push(frame(chunk({content:'partial',tool_calls:[{index:0,id:'c',function:{name:'write',arguments:'{"path":"x"}'}}]})));
    f.translator.push(frame(chunk({},'tool_calls'))+'data: [DONE]\n\n'); controller.abort();
    assert.throws(()=>f.translator.finish(),{code:'MODEL_REQUEST_CANCELLED'});
    assert(!f.events().some(e=>e.type==='response.completed'||e.type==='message_stop'||e.item?.type==='function_call'||e.content_block?.type==='tool_use'));
    const res={destroyed:true,write(){throw Error('must not write');}}, stopped=createStreamTranslator(api,'fixture',res);
    assert.throws(()=>stopped.push(frame(chunk({content:'late'}))),{code:'MODEL_REQUEST_CANCELLED'});
  }
});
