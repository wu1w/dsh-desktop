const path=require('node:path');
const fail=code=>{throw Object.assign(Error(code),{code});};
const boundedNumber=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
function windowsHelperCommand(root,env=process.env){
 const systemRoot=env.SystemRoot||env.WINDIR;
 if(typeof systemRoot!=='string'||!path.win32.isAbsolute(systemRoot)||systemRoot.startsWith('\\\\')||/[\0\r\n]/.test(systemRoot))fail('COMPUTER_NATIVE_UNAVAILABLE');
 const source=path.join(root,'native','computer-helper.windows.cs').replace(/'/g,"''");
 // Direct, fixed Add-Type invocation: no script file policy change or downloaded code.
 const bootstrap=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false);[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);try{Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Web.Extensions;$r=@([System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.InvokePatternIdentifiers].Assembly.Location,[System.Windows.Rect].Assembly.Location,[System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Linq.Enumerable].Assembly.Location,[System.ComponentModel.Component].Assembly.Location)|Select-Object -Unique;Add-Type -Path '${source}' -ReferencedAssemblies $r;[DshComputer.WindowsAdapter]::Run()}catch{[Console]::Error.WriteLine('COMPUTER_NATIVE_BLOCKED');exit 1}`;
 return {file:path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NonInteractive','-Mta','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')]};
}
function validateWindowsInput(input){
 if(!input||typeof input!=='object')fail('COMPUTER_INVALID_INPUT');
 const {action}=input;
 if(['status','apps'].includes(action))return {action};
 if(!['observe','click','type','key','scroll'].includes(action)||!Number.isSafeInteger(input.pid)||input.pid<=0||input.pid>0x7fffffff)fail('COMPUTER_INVALID_INPUT');
 if(typeof input.windowId!=='string'||!/^\d{1,19}$/.test(input.windowId)||typeof input.processStartTime!=='string'||!/^\d{1,19}$/.test(input.processStartTime))fail('COMPUTER_APP_GONE');
 const result={action,pid:input.pid,windowId:input.windowId,processStartTime:input.processStartTime};
 if(action==='observe')return result;
 if(typeof input.nativeObservation!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(input.nativeObservation))fail('COMPUTER_OBSERVATION_STALE');
 result.nativeObservation=input.nativeObservation;
 if(input.element!=null){if(!Number.isSafeInteger(input.element)||input.element<0||input.element>=240)fail('COMPUTER_INVALID_INPUT');result.element=input.element;}
 if(action==='click'&&input.element==null){if(!boundedNumber(input.x,0,100000)||!boundedNumber(input.y,0,100000))fail('COMPUTER_INVALID_INPUT');result.x=input.x;result.y=input.y;}
 if(action==='type'){if(input.element==null||typeof input.text!=='string'||input.text.length>20000||input.text.includes('\0'))fail('COMPUTER_INVALID_INPUT');result.text=input.text;}
 if(action==='key'){if(typeof input.key!=='string'||! /^(?:(?:Ctrl|Control|Alt|Shift|Meta|Super|Win)\+){0,3}(?:Enter|Return|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Up|Down|Left|Right|Home|End|PageUp|PageDown|Space|[A-Za-z0-9])$/.test(input.key))fail('COMPUTER_INVALID_INPUT');result.key=input.key;}
 if(action==='scroll'){if(!['up','down','left','right'].includes(input.direction))fail('COMPUTER_INVALID_INPUT');result.direction=input.direction;}
 return result;
}
function screenshotGeometry(result,size){
 const b=result.bounds;
 if(!b||!['x','y','width','height'].every(k=>typeof b[k]==='number'&&Number.isFinite(b[k]))||b.width<=0||b.height<=0||!boundedNumber(size?.width,1,20000)||!boundedNumber(size?.height,1,20000))return null;
 // Electron exposes a resized thumbnail, not the native capturer's frame
 // origin/crop. GDI can crop resize borders differently from DWM and WGC.
 // Neither DWM bounds nor GetWindowRect is a verified image-to-input mapping.
 return {coordinateSpace:'capture-image-pixels',imageSize:{width:size.width,height:size.height},windowCoordinateSpace:'physical-screen-pixels',windowBounds:{...b},mappingAvailable:false,mappingReason:'CAPTURE_FRAME_BOUNDS_UNAVAILABLE'};
}
module.exports={windowsHelperCommand,validateWindowsInput,screenshotGeometry};
