import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {fileBrowserLocales} from '../src/file-browser-locales.js';
const menuFile=new URL('../src/menu.jsx',import.meta.url),file=new URL('../src/components/FileBrowser.jsx',import.meta.url),require=createRequire(file);
const menuRequire=createRequire(menuFile);
const menuCode=await transform(await readFile(menuFile,'utf8'),{loader:'jsx',format:'cjs'}),code=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'});
function loadMenus(react={...React,useLayoutEffect(){}},extra={}){const module={exports:{}};new Function('require','module','exports','document','window',menuCode.code)(id=>id==='react'?react:id==='react-dom'&&extra.portal?{createPortal:extra.portal}:menuRequire(id),module,module.exports,extra.document??{},{});return module.exports;}
const menu=loadMenus(),module={exports:{}};new Function('require','module','exports',code.code)(id=>id.endsWith('.css')?{}:id==='../menu.jsx'?menu:require(id),module,module.exports);
const {FileBrowser,fileBrowserSize}=module.exports;
const tFor=locale=>(key,params={})=>(fileBrowserLocales[locale]?.[key]??fileBrowserLocales.en[key]??key).replace(/\{(\w+)\}/g,(whole,key)=>Object.hasOwn(params,key)?params[key]:whole);
const folder={name:'nested',path:'docs/nested',directory:true},fileEntry={name:'金额 notes.md',path:'docs/金额 notes.md',directory:false,size:1536},second={name:'second.js',path:'docs/second.js',directory:false,size:0};
const project={id:'A',name:'Fixture project',path:'/fixture/project'};
function props(extra={}){return {project,entries:[folder,fileEntry,second],directory:'docs',t:tFor('en'),locale:'en',onBrowse(){},onOpen(){},onAttach(){},onOpenExternal(){},onCopyPath(){},onClose(){},...extra};}
function nodes(value){if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object')return [];return [value,...nodes(value.props?.children)];}
function render(extra={},locale='en'){return renderToStaticMarkup(React.createElement(FileBrowser,props({t:tFor(locale),locale,...extra})));}
const mainButtons=tree=>nodes(tree).filter(node=>node.type==='button'&&node.props.className==='file-browser-entry-main');
const dropdowns=tree=>nodes(tree).filter(node=>node.type===menu.Dropdown);
const menuItems=(dropdown,close=()=>{})=>nodes(dropdown.props.children(close)).filter(node=>node.type===menu.MenuItem);
for(const locale of ['en','zh-CN'])test('actual browser SSR has localized accessible rows, current breadcrumb and no nested buttons in '+locale,()=>{
 const html=render({},locale),t=tFor(locale);assert.ok(html.includes(t('fileBrowserTitle')));assert.ok(html.includes('aria-current="page" title="docs"'));assert.ok(html.includes(t('fileBrowserPreviewNamed',{name:fileEntry.name})));assert.ok(html.includes(t('fileBrowserFolder')));assert.ok(!html.includes('fileBrowserEntryCount'));let depth=0;for(const tag of html.matchAll(/<\/?button\b[^>]*>/g)){depth+=tag[0].startsWith('</')?-1:1;assert.ok(depth>=0&&depth<=1,'row/menu trigger must be sibling buttons');}assert.equal(depth,0);
});
test('real primary handlers preserve entry order and choose file preview or full-object attachment without changing folder navigation',()=>{
 const calls=[],tree=FileBrowser(props({onBrowse:path=>calls.push(['browse',path]),onOpen:path=>calls.push(['open',path]),onAttach:entry=>calls.push(['attach',entry])}));const buttons=mainButtons(tree);buttons[0].props.onClick();buttons[1].props.onClick();assert.deepEqual(calls,[['browse',folder.path],['open',fileEntry.path]]);
 const picking=mainButtons(FileBrowser(props({picking:true,onBrowse:path=>calls.push(['browse',path]),onAttach:entry=>calls.push(['attach',entry])})));picking[0].props.onClick();picking[1].props.onClick();assert.equal(calls.at(-1)[1],fileEntry);assert.equal(calls.at(-2)[0],'browse');
});
test('actual file menus close before captured preview, attach, external and relative-path callbacks; folders omit file-only actions',()=>{
 const calls=[],tree=FileBrowser(props({onBrowse:path=>calls.push(['browse',path]),onOpen:path=>calls.push(['preview',path]),onAttach:entry=>calls.push(['attach',entry]),onOpenExternal:path=>calls.push(['external',path]),onCopyPath:path=>calls.push(['copy',path])})),menus=dropdowns(tree),close=()=>calls.push(['close']);
 const fileItems=menuItems(menus[1],close);assert.equal(fileItems.length,4);for(const item of fileItems){const button=menu.MenuItem(item.props);button.props.onClick();}assert.deepEqual(calls,[['close'],['preview',fileEntry.path],['close'],['attach',fileEntry],['close'],['external',fileEntry.path],['close'],['copy',fileEntry.path]]);
 const directoryItems=menuItems(menus[0],close);assert.deepEqual(directoryItems.map(item=>item.props.label),[tFor('en')('fileBrowserEnter'),tFor('en')('fileBrowserCopyRelativePath')]);
});
test('real breadcrumb, parent and refresh handlers use the current directory while root cannot navigate above the project',()=>{
 const calls=[],tree=FileBrowser(props({directory:'docs/nested',onBrowse:path=>calls.push(path)}));for(const button of nodes(tree).filter(node=>node.type==='button'&&['Parent folder','Refresh current folder'].includes(node.props['aria-label'])))button.props.onClick();
 const nav=nodes(tree).find(node=>node.type==='nav');for(const button of nodes(nav).filter(node=>node.type==='button'))button.props.onClick();assert.deepEqual(calls,['docs','docs/nested','','docs']);
 const root=FileBrowser(props({directory:''}));assert.equal(nodes(root).find(node=>node.props?.['aria-label']==='Parent folder').props.disabled,true);assert.ok(render({directory:''}).includes('aria-current="page" title="/fixture/project"'));
});
test('loading, error, empty, disabled and missing-project views are distinct and closing stays available',()=>{
 const t=tFor('en'),loading=FileBrowser(props({loading:true}));assert.equal(loading.props['aria-busy'],true);assert.ok(mainButtons(loading).every(button=>button.props.disabled));assert.ok(dropdowns(loading).every(dropdown=>dropdown.props.disabled));assert.ok(!render({loading:true,entries:[]}).includes(t('fileBrowserEmpty')));assert.equal(nodes(loading).find(node=>node.props?.['aria-label']==='Close file browser').props.disabled,false);
 let retries=0;const failure=FileBrowser(props({error:'Readable failure',onRetry:()=>retries++}));assert.equal(mainButtons(failure).length,0);const retry=nodes(failure).find(node=>node.type==='button'&&node.props.className==='subtle-button');retry.props.onClick();assert.equal(retries,1);assert.ok(render({error:'Readable failure'}).includes('role="alert"'));assert.ok(!render({error:'Readable failure'}).includes(t('fileBrowserEmpty')));
 assert.ok(render({entries:[]}).includes(t('fileBrowserEmpty')));assert.ok(render({enabled:false}).includes(t('fileBrowserDisabled')));assert.ok(render({project:null}).includes(t('fileBrowserChooseProject')));assert.ok(!render({error:{stack:'PRIVATE_STACK'}}).includes('PRIVATE_STACK'));
});
test('external single-flight busy only locks external launch, while matching opening rows wait and other navigation remains available',()=>{
 const tree=FileBrowser(props({externalBusy:true})),items=menuItems(dropdowns(tree)[1]);assert.equal(items[2].props.disabled,true);assert.ok([items[0],items[1],items[3]].every(item=>!item.props.disabled));assert.ok(mainButtons(tree).every(button=>!button.props.disabled));
 const opening=FileBrowser(props({openingPath:fileEntry.path,externalBusy:true})),buttons=mainButtons(opening);assert.equal(buttons[0].props.disabled,false);assert.equal(buttons[1].props.disabled,true);assert.equal(buttons[2].props.disabled,false);assert.equal(dropdowns(opening)[1].props.disabled,true);assert.ok(render({openingPath:fileEntry.path}).includes('Opening…'));
});
test('unsafe backend-relative paths disable their buttons and unavailable callbacks never pretend to act',()=>{
 const tree=FileBrowser(props({entries:[{name:'outside',path:'../outside',size:1},{name:'absolute',path:'/outside',size:1}]}));assert.ok(mainButtons(tree).every(button=>button.props.disabled));assert.ok(dropdowns(tree).every(dropdown=>dropdown.props.disabled));assert.ok(mainButtons(FileBrowser(props({onOpen:undefined}))).slice(1).every(button=>button.props.disabled));
});
test('locale size/count formatting handles bytes, large sizes and missing metadata with matching complete language resources',()=>{
 assert.equal(fileBrowserSize(1536,'de-DE'),new Intl.NumberFormat('de-DE',{style:'unit',unit:'kilobyte',unitDisplay:'short',maximumFractionDigits:1}).format(1.536));assert.equal(fileBrowserSize(0,'en'),new Intl.NumberFormat('en',{style:'unit',unit:'byte',unitDisplay:'short',maximumFractionDigits:0}).format(0));assert.equal(fileBrowserSize(undefined,'en',tFor('en')),'—');assert.equal(fileBrowserSize(Infinity,'en',tFor('en')),'—');assert.ok(render({entries:[second]}).includes('1 item'));assert.deepEqual(Object.keys(fileBrowserLocales.en).sort(),Object.keys(fileBrowserLocales['zh-CN']).sort());
});
test('the actual shared Dropdown opens by keyboard, moves focus and closes the file action menu with Escape',()=>{
 const states=[],refs=[];let stateIndex=0,refIndex=0;const activeDocument={activeElement:null};const react={...React,useState(initial){const key=stateIndex++;if(!(key in states))states[key]=initial;return [states[key],value=>states[key]=typeof value==='function'?value(states[key]):value];},useRef(current){return refs[refIndex++]??=({current});},useId:()=> 'file-action-menu',useEffect(){},useLayoutEffect(){}};
 const actual=loadMenus(react,{document:activeDocument,portal:child=>child}),dropdown=dropdowns(FileBrowser(props()))[1];function view(){stateIndex=0;refIndex=0;return actual.Dropdown(dropdown.props);}let tree=view();let trigger=nodes(tree).find(node=>node.type==='button');let prevented=0;trigger.props.onKeyDown({key:'ArrowDown',preventDefault(){prevented++;}});tree=view();trigger=nodes(tree).find(node=>node.type==='button');assert.equal(trigger.props['aria-expanded'],true);const popup=nodes(tree).find(node=>node.props?.role==='menu');assert.ok(popup);const options=menuItems(dropdown).map(item=>({textContent:item.props.label,focus(){activeDocument.activeElement=this;}}));popup.ref.current={querySelectorAll:()=>options};trigger.ref.current={focus(){activeDocument.activeElement='trigger';}};activeDocument.activeElement=options[0];const event=key=>({key,preventDefault(){prevented++;},stopPropagation(){}});popup.props.onKeyDown(event('ArrowDown'));assert.equal(activeDocument.activeElement,options[1]);popup.props.onKeyDown(event('End'));assert.equal(activeDocument.activeElement,options.at(-1));popup.props.onKeyDown(event('Home'));assert.equal(activeDocument.activeElement,options[0]);popup.props.onKeyDown(event('Escape'));assert.equal(activeDocument.activeElement,'trigger');tree=view();assert.equal(nodes(tree).find(node=>node.type==='button').props['aria-expanded'],false);assert.ok(prevented>=5);
});

test('macOS literal backslashes pass unchanged to real handlers while absolute and dot-segment paths stay disabled',()=>{
 const path='docs/a\\b.txt',entry={name:'a\\b.txt',path,size:12},calls=[],tree=FileBrowser(props({entries:[entry,{name:'absolute',path:'/etc/passwd'},{name:'escape',path:'docs/../outside'},{name:'dot',path:'docs/./a'},{name:'empty segment',path:'docs//a'},{name:'NUL',path:'docs/a\0b'}],onOpen:value=>calls.push(['open',value]),onCopyPath:value=>calls.push(['copy',value]),onOpenExternal:value=>calls.push(['external',value])}));
 const buttons=mainButtons(tree);assert.equal(buttons[0].props.disabled,false);buttons[0].props.onClick();const items=menuItems(dropdowns(tree)[0]);items[2].props.onClick();items[3].props.onClick();assert.deepEqual(calls,[['open',path],['external',path],['copy',path]]);assert.ok(buttons.slice(1).every(button=>button.props.disabled));assert.ok(dropdowns(tree).slice(1).every(dropdown=>dropdown.props.disabled));
});

test('all C0 and DEL filename controls are visibly escaped while real callbacks keep their original paths',()=>{
 const name='line\nname\x01\x7f.txt',path='notes/'+name,calls=[],entry={name,path,size:3};const tree=FileBrowser(props({entries:[entry],onOpen:value=>calls.push(value)}));const button=mainButtons(tree)[0];assert.equal(button.props.disabled,false);assert.ok(button.props['aria-label'].includes('\\n'));assert.ok(button.props['aria-label'].includes('\\u0001'));assert.ok(button.props['aria-label'].includes('\\u007f'));button.props.onClick();assert.deepEqual(calls,[path]);const html=render({entries:[entry]});assert.ok(html.includes('\\nname\\u0001\\u007f.txt'));assert.ok(!button.props['aria-label'].includes('\x01'));assert.ok(!button.props['aria-label'].includes('\x7f'));
});
