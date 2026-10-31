import test from 'node:test';
import assert from 'node:assert/strict';
import {ApprovalController,approvalDetails,approvalQuestions,canApproveRequest} from '../src/lib/approval-controller.js';

const question=(id,extra={})=>({id,header:`Header ${id}`,question:`Question ${id}`,isOther:false,isSecret:false,options:[{label:'First',description:'First description'},{label:'other',description:'A literal option named other'}],...extra});
const request=(id,questions=[question('q1')],extra={})=>({id,method:'item/tool/requestUserInput',params:{questions,isBlocking:true,...extra}});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('no option or first answer is selected automatically and missing answers cannot submit',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a'));
  assert.equal(controller.snapshot().answer.selection,null);assert.equal(controller.snapshot().canContinue,false);
  assert.equal(controller.beginSubmit('a',true),null);assert.equal(controller.move('a',1),false);
  assert.equal(controller.snapshot().pending,false);assert.equal(controller.snapshot().count,1);
});

test('multi-question answers preserve their question identity and native answers shape',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('q1'),question('q2',{options:null})]));
  controller.choose('a','q1',1);assert.equal(controller.move('a',1),true);controller.type('a','q2','my second answer');
  const token=controller.beginSubmit('a',true);
  assert.deepEqual(token.body,{allow:true,answers:{q1:{answers:['other']},q2:{answers:['my second answer']}}});
  assert.equal(controller.beginSubmit('a',true),null);assert.equal(controller.type('a','q2','double submit edit'),false);
});

test('custom answers are allowed only by isOther and switching back sends only the chosen option',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('q1',{isOther:true})]));
  controller.choose('a','q1','other');assert.equal(controller.snapshot().canContinue,false);
  controller.type('a','q1','custom text');assert.equal(controller.snapshot().canContinue,true);
  controller.choose('a','q1',0);assert.deepEqual(controller.beginSubmit('a',true).body.answers,{q1:{answers:['First']}});
  const other=new ApprovalController();other.enqueue(request('b'));
  assert.equal(other.choose('b','q1','other'),false);assert.equal(other.type('b','q1','not permitted'),false);
});

test('skipping erases a previous answer and omitted questions never produce synthetic empty answers',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('q1'),question('q2',{options:null}),question('q3')]));
  controller.choose('a','q1',0);controller.skip('a');controller.type('a','q2','keep second');controller.move('a',1);controller.choose('a','q3',1);
  const token=controller.beginSubmit('a',true,{skipCurrent:true});
  assert.deepEqual(token.body.answers,{q2:{answers:['keep second']}});
});

test('explicitly skipping every question produces empty answers while an untouched form does not submit',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('q1'),question('q2')]));
  controller.skip('a');assert.equal(controller.beginSubmit('a',true),null);
  assert.deepEqual(controller.beginSubmit('a',true,{skipCurrent:true}).body,{allow:true,answers:{}});
});

test('declining the entire question request sends no answers without claiming task cancellation',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('secret',{options:null,isSecret:true})]));
  controller.type('a','secret','sensitive input');const token=controller.beginSubmit('a',false);
  assert.deepEqual(token.body,{allow:false,answers:{}});
  controller.complete(token);assert.equal(controller.snapshot().current,null);assert.equal(controller.requests.size,0);
});

test('concurrent requests stay FIFO, duplicate replay preserves answers, and resolution removes only its own request',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a'));controller.choose('a','q1',0);controller.enqueue(request('b'));controller.enqueue(request('c'));
  controller.enqueue(request('a'));assert.equal(controller.snapshot().count,3);assert.equal(controller.snapshot().current.id,'a');assert.equal(controller.snapshot().answer.selection,0);
  assert.equal(controller.beginSubmit('c',false),null);
  controller.resolve('b');assert.equal(controller.snapshot().current.id,'a');assert.equal(controller.snapshot().count,2);
  controller.complete(controller.beginSubmit('a',true));assert.equal(controller.snapshot().current.id,'c');
});

test('failed submission retains secret answers in memory and retry is allowed exactly once at a time',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('secret',{options:null,isSecret:true})]));controller.type('a','secret','secret value');
  const token=controller.beginSubmit('a',true);assert.equal(controller.fail(token,'Network unavailable'),true);
  assert.equal(controller.snapshot().answer.text,'secret value');assert.equal(controller.snapshot().pending,false);assert.equal(controller.snapshot().error,'Network unavailable');
  const retry=controller.beginSubmit('a',true);assert.deepEqual(retry.body.answers,{secret:{answers:['secret value']}});assert.equal(controller.beginSubmit('a',false),null);
  const oldEntry=controller.requests.get('a');controller.resolve('a');assert.equal(oldEntry.answers.size,0);assert.equal(oldEntry.pending,null);
  assert.equal(controller.fail(retry,'late failure'),false);assert.equal(controller.complete(token),false);
});

test('late UI actions or network completion cannot submit or remove a different queued request',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a'));controller.enqueue(request('b'));controller.choose('a','q1',0);
  const token=controller.beginSubmit('a',true);controller.resolve('a');
  assert.equal(controller.beginSubmit('a',false),null);assert.equal(controller.choose('a','q1',0),false);assert.equal(controller.complete(token),false);
  assert.equal(controller.snapshot().current.id,'b');assert.equal(controller.snapshot().canContinue,false);
});

test('blocking respects isBlocking rather than deprecated timeout and secrets do not survive clear',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('secret',{options:null,isSecret:true})],{isBlocking:false,autoResolutionMs:1}));
  assert.equal(controller.snapshot().isBlocking,false);controller.type('a','secret','private');const entry=controller.requests.get('a');controller.clear();assert.equal(entry.answers.size,0);assert.equal(controller.snapshot().count,0);
  controller.enqueue(request('b',[],{isBlocking:true,autoResolutionMs:null}));assert.equal(controller.snapshot().isBlocking,true);
});

test('whitespace-only and invalid option answers never become user responses',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('q1',{options:null})]));controller.type('a','q1',' \n ');
  assert.equal(controller.snapshot().canContinue,false);assert.equal(controller.beginSubmit('a',true),null);
  assert.equal(controller.beginSubmit('a','true'),null);
});

test('unsupported approvals offer only decline and generic supported approvals retain allow semantics',()=>{
  const controller=new ApprovalController();controller.enqueue({id:'mcp',method:'mcpServer/elicitation/request',params:{message:'Describe the request'}});
  assert.equal(canApproveRequest(controller.snapshot().current),false);assert.equal(controller.beginSubmit('mcp',true),null);assert.deepEqual(controller.beginSubmit('mcp',false).body,{allow:false,answers:{}});
  controller.resolve('mcp');controller.enqueue({id:'command',method:'execCommandApproval',params:{command:['ls','-la'],cwd:'/project'}});
  assert.deepEqual(controller.beginSubmit('command',true).body,{allow:true,answers:{}});
  assert.deepEqual(approvalDetails(controller.snapshot().current),[{key:'cwd',value:'/project'},{key:'approvalCommand',value:'ls -la'}]);
});

test('opaque and special question IDs serialize as ordinary own keys',()=>{
  const controller=new ApprovalController();controller.enqueue(request('opaque/id?x',[question('__proto__',{options:null})]));controller.type('opaque/id?x','__proto__','real answer');
  const body=JSON.parse(JSON.stringify(controller.beginSubmit('opaque/id?x',true).body));assert.deepEqual(body.answers.__proto__,{answers:['real answer']});assert.equal(Object.hasOwn(body.answers,'__proto__'),true);
  assert.equal(approvalQuestions(request('a',[question('same'),question('same')])).length,1);
});

test('permission details render typed filesystem paths, denied scopes and network hosts without a JSON dump',()=>{
  const details=approvalDetails({params:{networkApprovalContext:{host:'example.test'},permissions:{network:{enabled:true},fileSystem:{entries:[{access:'read',path:{type:'path',path:'/project/read.md'}},{access:'write',path:{type:'special',value:{kind:'project_roots',subpath:'docs'}}},{access:'deny',path:{type:'glob_pattern',pattern:'**/.private/**'}}]}}}});
  assert.deepEqual(details,[{key:'approvalNetworkHost',value:'example.test'},{key:'approvalNetwork',value:null},{key:'approvalReadPaths',value:'/project/read.md'},{key:'approvalWritePaths',valueKey:'approvalPath_project_roots',suffix:'docs'},{key:'approvalDeniedPaths',value:'**/.private/**'}]);
});

test('Claude Edit and Write details include the actual tool, file and before/after content without changing the request',()=>{
  const request={method:'item/permissions/requestApproval',params:{tool:'Edit',input:{file_path:'/project/file.md',old_string:'before',new_string:'after'},permissions:{fileSystem:{write:['/project/file.md']}}}},before=structuredClone(request);
  const details=approvalDetails(request);assert.ok(details.some(row=>row.key==='approvalTool'&&row.value==='Edit'));assert.ok(details.some(row=>row.value==='/project/file.md'));
  assert.deepEqual(details.filter(row=>row.preview!==undefined),[{key:'approvalBeforeEdit',preview:'before',truncated:false},{key:'approvalAfterEdit',preview:'after',truncated:false}]);assert.deepEqual(request,before);
  const write=approvalDetails({params:{tool:'Write',input:{path:'file.md',content:'actual file contents'}}});assert.ok(write.some(row=>row.key==='approvalWriteContent'&&row.preview==='actual file contents'));
});

test('associated transcript context supplies missing command and paths with a shared 40k preview budget and explicit truncation',()=>{
  const details=approvalDetails({params:{input:{old_string:'x'.repeat(25_000),new_string:'y'.repeat(25_000)}},displayContext:{cwd:'/workspace',command:'apply_patch ...',paths:['a.md','a.md','b.md'],text:'original change details',textTruncated:true}});
  assert.ok(details.some(row=>row.key==='approvalCommand'&&row.value==='apply_patch ...'));assert.ok(details.some(row=>row.key==='cwd'&&row.value==='/workspace'));
  assert.equal(details.filter(row=>row.key==='approvalChangedFiles').length,2);
  const previews=details.filter(row=>row.preview!==undefined);assert.equal(previews.reduce((sum,row)=>sum+row.preview.length,0),40_000);assert.equal(previews[1].truncated,true);assert.equal(previews[2].truncated,true);
});

test('clearing a file or deleting a replacement string shows an explicitly empty preview rather than omitting it',()=>{
  const details=approvalDetails({params:{tool:'Edit',input:{old_string:'delete this',new_string:'',content:''}}});
  assert.deepEqual(details.filter(row=>row.empty===true),[{key:'approvalAfterEdit',preview:'',truncated:false,empty:true},{key:'approvalWriteContent',preview:'',truncated:false,empty:true}]);
});

test('authoritative reconnect keeps pending answers, clears absent secrets and appends new requests in server FIFO order',()=>{
  const controller=new ApprovalController(),secret=question('secret',{options:null,isSecret:true});
  controller.enqueue(request('expired',[secret]));controller.type('expired','secret','expired secret');const expiredEntry=controller.requests.get('expired');
  controller.enqueue(request('still-pending',[secret]));controller.type('still-pending','secret','preserve this answer');
  controller.reconcile([request('still-pending',[secret]),request('new-1'),request('new-2')]);
  assert.deepEqual(controller.order,['still-pending','new-1','new-2']);assert.equal(controller.snapshot().answer.text,'preserve this answer');
  assert.equal(expiredEntry.answers.size,0);assert.equal(expiredEntry.pending,null);assert.equal(controller.requests.has('expired'),false);
  controller.enqueue(request('new-1'));assert.equal(controller.snapshot().count,3);
});

test('reconnect during an unanswered HTTP submission preserves its token and blocks duplicate submission until failure',async()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('secret',{options:null,isSecret:true})]));controller.type('a','secret','my secret');
  const token=controller.beginSubmit('a',true),network=deferred();
  const sending=network.promise.then(()=>controller.complete(token),error=>controller.fail(token,error.message));
  controller.reconcile([request('a',[question('secret',{options:null,isSecret:true})]),request('b')]);
  assert.equal(controller.snapshot().pending,true);assert.equal(controller.snapshot().answer.text,'my secret');assert.equal(controller.beginSubmit('a',true),null);
  network.reject(Error('Connection lost'));assert.equal(await sending,true);assert.equal(controller.snapshot().pending,false);assert.equal(controller.snapshot().answer.text,'my secret');
  assert.deepEqual(controller.beginSubmit('a',true).body.answers,{secret:{answers:['my secret']}});
});

test('lost resolved notification followed by reconnect removes the old request before its late HTTP failure arrives',async()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('secret',{options:null,isSecret:true})]));controller.type('a','secret','remove when absent');
  controller.enqueue(request('b'));const entry=controller.requests.get('a'),token=controller.beginSubmit('a',true),network=deferred();
  const sending=network.promise.then(()=>controller.complete(token),error=>controller.fail(token,error.message));
  controller.reconcile([request('b'),request('c')]);
  assert.equal(entry.answers.size,0);assert.equal(entry.pending,null);assert.equal(controller.snapshot().current.id,'b');
  network.reject(Error('APPROVAL_NOT_FOUND'));assert.equal(await sending,false);assert.equal(controller.snapshot().current.id,'b');assert.equal(controller.snapshot().error,null);
});

test('a late successful submission cannot remove the next request after reconnect already removed its original ID',async()=>{
  const controller=new ApprovalController();controller.enqueue(request('a'));controller.choose('a','q1',0);const token=controller.beginSubmit('a',true),network=deferred();
  const sending=network.promise.then(()=>controller.complete(token));controller.reconcile([request('b')]);network.resolve();
  assert.equal(await sending,false);assert.equal(controller.snapshot().current.id,'b');assert.equal(controller.snapshot().canContinue,false);
});

test('empty reconnect list scrubs all private answers while malformed sync cannot erase live state',()=>{
  const controller=new ApprovalController();controller.enqueue(request('a',[question('secret',{options:null,isSecret:true})]));controller.type('a','secret','private');const entry=controller.requests.get('a');
  assert.equal(controller.reconcile(null),false);assert.equal(controller.snapshot().answer.text,'private');
  controller.reconcile([]);assert.equal(controller.snapshot().count,0);assert.equal(entry.answers.size,0);
});

test('server order and duplicate replay during reconnect preserve each request’s independent draft',()=>{
  const controller=new ApprovalController();controller.enqueue(request('b',[question('q',{options:null})]));controller.type('b','q','B draft');controller.enqueue(request('a'));
  controller.reconcile([request('a'),request('b',[question('q',{options:null})]),request('a')]);
  assert.deepEqual(controller.order,['a','b']);controller.resolve('a');assert.equal(controller.snapshot().answer.text,'B draft');
});
