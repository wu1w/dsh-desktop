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
test('screenshot metadata keeps physical negative monitor origin separate from resized image pixels',()=>{
 const metadata=screenshotGeometry({bounds:{x:-2560,y:-180,width:2200,height:1200}},{width:1100,height:600});
 assert.deepEqual(metadata.origin,{x:-2560,y:-180});assert.deepEqual(metadata.imageToWindowScale,{x:2,y:2});assert.equal(metadata.coordinateSpace,'window-physical-pixels');
 assert.equal(screenshotGeometry({bounds:{x:0,y:0,width:0,height:1}},{width:1,height:1}),null);
 assert.equal(screenshotGeometry({bounds:{x:Infinity,y:0,width:2,height:1}},{width:1,height:1}),null);
});
