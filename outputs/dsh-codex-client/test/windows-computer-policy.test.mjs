import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {windowsHelperCommand,validateWindowsInput,screenshotGeometry}=createRequire(import.meta.url)('../desktop/windows-computer.cjs');
const bound={pid:42,windowId:'123456',processStartTime:'638000000000000000',nativeObservation:'abc-123'};
test('native bootstrap uses a trusted absolute executable and literal packaged source, without changing policy',()=>{
 const command=windowsHelperCommand("C:\\Users\\O'Brien\\DSH",{SystemRoot:'C:\\Windows'});
 assert.equal(command.file,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
 assert.deepEqual(command.args.slice(0,-1),['-NoLogo','-NoProfile','-NonInteractive','-Mta','-EncodedCommand']);
 const source=Buffer.from(command.args.at(-1),'base64').toString('utf16le');assert.match(source,/O''Brien/);assert.match(source,/Add-Type -Path/);assert.match(source,/computer-helper\.windows\.cs/);assert.doesNotMatch(source,/ExecutionPolicy|Invoke-Expression|Start-Process|Download|uiAccess|Set-ItemProperty/i);
 for(const root of ['relative','\\\\server\\share','C:\\Windows\n'])assert.throws(()=>windowsHelperCommand('app',{SystemRoot:root}),{code:'COMPUTER_NATIVE_UNAVAILABLE'});
});
test('protocol validates identities, keys and finite window-relative coordinates before spawning',()=>{
 assert.deepEqual(validateWindowsInput({action:'status',text:'ignored'}),{action:'status'});
 assert.deepEqual(validateWindowsInput({...bound,action:'observe'}),{action:'observe',pid:42,windowId:bound.windowId,processStartTime:bound.processStartTime});
 for(const input of [{...bound,pid:-1,action:'observe'},{...bound,windowId:42,action:'observe'},{...bound,processStartTime:'1e6',action:'observe'},{...bound,action:'type',element:0,text:'\0'},{...bound,action:'click',x:NaN,y:2},{...bound,action:'click',x:-1,y:2},{...bound,action:'key',key:'Ctrl+;powershell'},{...bound,action:'scroll',direction:'diagonal'}])assert.throws(()=>validateWindowsInput(input));
 assert.equal(validateWindowsInput({...bound,action:'type',element:0,text:'你好'}).text,'你好');assert.equal(validateWindowsInput({...bound,action:'key',key:'Ctrl+A'}).key,'Ctrl+A');
});
test('screenshot metadata separates negative native bounds from thumbnail pixels without inventing a crop transform',()=>{
 const metadata=screenshotGeometry({bounds:{x:-2560,y:-180,width:2200,height:1200}},{width:1100,height:600});
 assert.deepEqual(metadata.windowBounds,{x:-2560,y:-180,width:2200,height:1200});assert.deepEqual(metadata.imageSize,{width:1100,height:600});assert.equal(metadata.coordinateSpace,'capture-image-pixels');assert.equal(metadata.mappingAvailable,false);assert.equal(metadata.mappingReason,'CAPTURE_FRAME_BOUNDS_UNAVAILABLE');assert.equal(metadata.imageToWindowScale,undefined);
 assert.equal(screenshotGeometry({bounds:{x:0,y:0,width:0,height:1}},{width:1,height:1}),null);
 assert.equal(screenshotGeometry({bounds:{x:Infinity,y:0,width:2,height:1}},{width:1,height:1}),null);
});

test('observed GDI border cropping must not be inferred from matching outer-window aspect ratio',()=>{
 const metadata=screenshotGeometry({bounds:{x:322,y:210,width:746,height:473},windowRect:{x:315,y:210,width:760,height:480}},{width:1100,height:695});
 assert.equal(metadata.mappingAvailable,false);assert.equal(metadata.imageToWindowOffset,undefined);assert.equal(metadata.imageToWindowScale,undefined);
 assert.deepEqual(metadata.windowBounds,{x:322,y:210,width:746,height:473});
});
