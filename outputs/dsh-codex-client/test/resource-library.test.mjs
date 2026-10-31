import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ResourceLibrary,listResources,createResource,resourceKey} from '../server/resource-library.mjs';
async function setup(t){const root=await mkdtemp(path.join(tmpdir(),'dsh-library-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const project={id:'a',path:path.join(root,'project')};await mkdir(project.path);return {root,project};}
test('inventory classifies nested resources without traversing symlinks or hidden/generated directories',async t=>{
 const {root,project}=await setup(t);for(const name of ['notes','node_modules','.hidden'])await mkdir(path.join(project.path,name));await mkdir(path.join(root,'outside'));
 for(const name of ['notes/guide.md','slides.pptx','site.html','cover.png','data.csv','node_modules/ignored.md','.hidden/private.md'])await writeFile(path.join(project.path,name),'fixture');
 await writeFile(path.join(root,'outside','secret.md'),'secret');await symlink(path.join(root,'outside'),path.join(project.path,'linked'));await symlink(project.path,path.join(project.path,'cycle'));await symlink(path.join(root,'outside','secret.md'),path.join(project.path,'secret.md'));
 const result=await listResources([project]);assert.equal(result.entries.length,5);assert.deepEqual(new Set(result.entries.map(row=>row.kind)),new Set(['pages','slides','sites','images','other']));assert.ok(result.entries.every(row=>row.projectId==='a'&&Number.isFinite(Date.parse(row.modifiedAt))));assert.equal(result.truncated,false);
});
test('inventory reports unavailable projects, bounded traversal and cancellation',async t=>{
 const {project}=await setup(t);for(const name of ['a.md','b.md','c.md'])await writeFile(path.join(project.path,name),'a');
 const result=await listResources([{id:'missing',path:project.path+'/absent'},project],{maxEntries:2});assert.equal(result.entries.length,2);assert.equal(result.truncated,true);assert.deepEqual(result.unavailable,['missing']);
 const controller=new AbortController();controller.abort();await assert.rejects(listResources([project],{signal:controller.signal}));
});
test('concurrent favorites/recent/removal persist after restart while file bytes stay intact',async t=>{
 const {root,project}=await setup(t),file=path.join(project.path,'a.md');await writeFile(file,'original');const library=new ResourceLibrary(root);
 await Promise.all([library.update('a','a.md',{action:'favorite',value:true}),library.update('a','a.md',{action:'open'}),library.update('a','a.md',{action:'hide'})]);
 const records=await new ResourceLibrary(root).snapshot(),key=resourceKey('a','a.md');assert.equal(records[key].favorite,true);assert.equal(records[key].hidden,true);assert.ok(Date.parse(records[key].openedAt));assert.equal(await readFile(file,'utf8'),'original');
 await library.update('a','a.md',{action:'restore'});assert.equal((await library.snapshot())[key].hidden,false);
});
test('corrupt metadata is preserved instead of overwritten by an update',async t=>{
 const {root}=await setup(t),file=path.join(root,'resource-library.json');await writeFile(file,'broken');const library=new ResourceLibrary(root);
 await assert.rejects(library.snapshot(),{code:'LIBRARY_STATE_INVALID'});await assert.rejects(library.update('a','a.md',{action:'favorite',value:true}),{code:'LIBRARY_STATE_INVALID'});assert.equal(await readFile(file,'utf8'),'broken');
});
test('creation rejects traversal, hidden names and symlink overwrite; concurrent creates cannot clobber',async t=>{
 const {root,project}=await setup(t),result=await createResource(project,'项目笔记');assert.equal(result.path,'项目笔记.md');assert.equal(await readFile(path.join(project.path,result.path),'utf8'),'# 项目笔记\n\n');
 await assert.rejects(createResource(project,'项目笔记'),{code:'LIBRARY_FILE_EXISTS'});
 for(const name of ['../escape','/escape','a/b','a\\b','.hidden','bad\nname',' '])await assert.rejects(createResource(project,name),{code:'LIBRARY_NAME_INVALID'});
 const outside=path.join(root,'outside.md');await writeFile(outside,'keep');await symlink(outside,path.join(project.path,'link.md'));await assert.rejects(createResource(project,'link.md'));assert.equal(await readFile(outside,'utf8'),'keep');
 const results=await Promise.allSettled([createResource(project,'race'),createResource(project,'race')]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
});
test('HTTP routes enforce capability/project boundaries and return scoped inventories',async t=>{
 const {root,project}=await setup(t);const {startHost}=await import('../server/index.mjs');await mkdir(path.join(root,'global'));
 const host=await startHost({dataDir:path.join(root,'data'),autoStart:false,instructionOptions:{globalRoot:path.join(root,'global')}});t.after(()=>host.close());
 const response=await fetch(host.url+'/api/bootstrap'),boot=await response.json();const headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json'};
 const request=async(route,body)=>{const result=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return {status:result.status,data:await result.json()};};
 const saved=await request('projects',{path:project.path,name:'Library fixture'});assert.equal(saved.status,200);const projectId=saved.data.id;
 assert.equal((await fetch(host.url+'/api/library')).status,403);
 assert.equal((await request('library/create',{projectId,name:'HTTP note'})).status,200);
 assert.equal((await request('library/create',{projectId,name:'HTTP note'})).data.code,'LIBRARY_FILE_EXISTS');
 assert.equal((await request('library/item',{projectId,path:'../outside.md',action:'hide'})).status,400);
 const favorite=await request('library/item',{projectId,path:'HTTP note.md',action:'favorite',value:true});assert.equal(favorite.data.record.favorite,true);
 const result=await request('library?projectId='+projectId);assert.equal(result.status,200);assert.equal(result.data.entries.length,1);assert.equal(result.data.entries[0].projectId,projectId);
 assert.equal((await request('library?projectId=absent')).status,404);
});
