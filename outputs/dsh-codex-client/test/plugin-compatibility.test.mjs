import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {CredentialProvider} from '@deepseek-ai/dsh-credentials';
import {PluginHost} from '../server/plugin-host.mjs';

async function fixture(work){
  const root=await mkdtemp(path.join(tmpdir(),'dsh-native-plugin-')),context=new Context();
  const host=new PluginHost({context,dataDir:path.join(root,'data'),builtins:[],services:{}});
  try{await host.start();await work({root,host,context});}finally{await host.close();await context.fiber.dispose();await rm(root,{recursive:true,force:true});}
}
test('native DSH client and bundle metadata give a specific compatibility error without importing or installing code',async()=>fixture(async({root,host})=>{
  for(const [id,dsh] of [['native-client',{client:{inject:['slots','sessions'],platform:'web'}}],['native-bundle',{bundle:{patch:'cordis.patch.yml'}}]]){
    const source=path.join(root,id);await mkdir(source);await writeFile(path.join(source,'package.json'),JSON.stringify({name:id,version:'1.0',dsh}));
    const sentinel=path.join(root,'MUST_NOT_EXIST');await writeFile(path.join(source,'index.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},'executed');`);
    await assert.rejects(host.install(source),{code:'PLUGIN_DSH_RUNTIME_REQUIRED'});await assert.rejects(access(sentinel),{code:'ENOENT'});assert.deepEqual(host.list(),[]);
  }
  await assert.rejects(access(path.join(root,'data/plugins.json')),{code:'ENOENT'});
}));
test('an adapter can compose an unmodified native Cordis service and its actual dependency lifecycle',async()=>fixture(async({root,host,context})=>{
  const source=path.join(root,'adapter');await mkdir(source);
  await writeFile(path.join(source,'package.json'),JSON.stringify({dsh:{client:{inject:['slots']}}}));
  await writeFile(path.join(source,'dsh-plugin.json'),JSON.stringify({id:'native-service-adapter',version:'1.0',type:'feature',name:{en:'Native service adapter','zh-CN':'原生服务适配'}}));
  const nativeModule=import.meta.resolve('@deepseek-ai/dsh-credentials');
  await writeFile(path.join(source,'index.mjs'),`import {CredentialProvider} from ${JSON.stringify(nativeModule)};export async function apply(ctx){await ctx.plugin(CredentialProvider);}`);
  assert.equal(context.get('credentials'),undefined);await host.install(source);assert.equal(context.get('credentials'),undefined);
  await host.enable('native-service-adapter');const first=context.get('credentials');assert.ok(first instanceof CredentialProvider);
  const bytes=await readFile(path.join(root,'data/plugins.json'),'utf8');assert.equal(JSON.parse(bytes).enabled['native-service-adapter'],true);
  await host.disable('native-service-adapter');assert.equal(context.get('credentials'),undefined);
  await host.enable('native-service-adapter');assert.ok(context.get('credentials') instanceof CredentialProvider);assert.notEqual(context.get('credentials'),first);
  await host.remove('native-service-adapter');assert.equal(context.get('credentials'),undefined);assert.deepEqual(host.list(),[]);
}));
test('unrecognized or malformed package directories fail as invalid plugins, without leaking filesystem errors',async()=>fixture(async({root,host})=>{
  for(const [id,files] of [['empty',{}],['ordinary',{'package.json':'{"name":"ordinary"}'}],['broken',{'dsh-plugin.json':'{bad'}]]){
    const source=path.join(root,id);await mkdir(source);for(const [name,value] of Object.entries(files))await writeFile(path.join(source,name),value);
    await assert.rejects(host.install(source),{code:'INVALID_PLUGIN'});
  }
}));
