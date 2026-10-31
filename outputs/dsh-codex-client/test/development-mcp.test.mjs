import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {handleDevelopmentMcp} from '../server/development-mcp.mjs';
import {normalizeItem} from '../server/normalize.mjs';
import {translator} from '../src/i18n.js';
async function fixture(t){
  const calls=[],development={idForToken:token=>token==='scoped-secret'?'native-chat':null,engineCall:async(id,input)=>{calls.push({id,input});return {plugins:[]};}};
  const server=http.createServer((req,res)=>void handleDevelopmentMcp(req,res,{bearer:'transport-secret',development}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {calls,async request(body,extra={}){const response=await fetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',headers:{authorization:'Bearer transport-secret',...extra},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};}};
}
test('development MCP requires private transport and chat tokens before any call',async t=>{
  const f=await fixture(t),body={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dsh_plugins',arguments:{action:'list',sessionToken:'scoped-secret'}}};assert.equal((await f.request(body,{origin:'http://evil.example'})).status,403);assert.equal((await f.request(body,{authorization:'Bearer wrong'})).status,403);assert.equal(f.calls.length,0);
  const wrong=structuredClone(body);wrong.params.arguments.sessionToken='wrong';assert.equal((await f.request(wrong)).value.result.isError,true);assert.equal(f.calls.length,0);assert.equal((await f.request(body)).value.result.isError,undefined);assert.deepEqual(f.calls,[{id:'native-chat',input:{action:'list'}}]);
});
test('tool schema advertises session binding and malformed RPC input is contained',async t=>{
  const f=await fixture(t);const tools=(await f.request({id:1,method:'tools/list'})).value.result.tools;assert.equal(tools[0].name,'dsh_plugins');assert.ok(tools[0].inputSchema.required.includes('sessionToken'));assert.equal((await f.request(null)).value.error.code,-32600);assert.equal(f.calls.length,0);
});
test('plugin activity uses the localized timeline and does not expose its session token or raw command',()=>{
  const mcp=normalizeItem({id:'one',type:'mcpToolCall',server:'dsh_development',arguments:{action:'apply',sessionToken:'DO_NOT_RENDER'},result:{content:[{type:'text',text:'{"ok":true}'}]}},'/tmp');assert.equal(mcp.activity,'plugin');assert.equal(mcp.command,'apply');assert.doesNotMatch(JSON.stringify(mcp),/DO_NOT_RENDER/);
  const command=normalizeItem({id:'two',type:'commandExecution',command:'mcp__dsh_development__dsh_plugins {"sessionToken":"DO_NOT_RENDER"}',aggregatedOutput:'ok'},'/tmp');assert.equal(command.activity,'plugin');assert.doesNotMatch(JSON.stringify(command),/DO_NOT_RENDER/);
  for(const locale of ['en','zh-CN']){const t=translator(locale);assert.notEqual(t('process_plugin_active'),'process_plugin_active');assert.notEqual(t('PLUGIN_UPDATE_FAILED'),'PLUGIN_UPDATE_FAILED');}
});
