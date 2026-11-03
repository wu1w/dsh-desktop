// Run from the repository root. This explicit device test touches only its
// own WinForms windows. Keep real Electron stdout handles alive on Windows.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
if(process.platform!=='win32')throw Error('WINDOWS_NATIVE_HOST_REQUIRED');
const root=process.cwd(),file=path.join(__dirname,'acceptance-computer-scenarios.cjs');
const reportFile=path.resolve(process.env.DSH_SCENARIO_REPORT||'computer-scenarios-report.json');
const logFile=path.resolve(process.env.DSH_SCENARIO_LOG||'computer-scenarios.log');
const fd=fs.openSync(logFile,'w'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[file],{env,windowsHide:true,stdio:['ignore',fd,fd]});
let timedOut=false;console.log('NATIVE_MATRIX_PID='+child.pid);
const watchdog=setTimeout(()=>{
 timedOut=true;
 try{const r=JSON.parse(fs.readFileSync(reportFile,'utf8'));if(r.processId===child.pid&&path.resolve(r.directory).startsWith(path.join(root,'acceptance-data')+path.sep)){const s=JSON.parse(fs.readFileSync(path.join(r.directory,'state.json'),'utf8'));fs.writeFileSync(path.join(r.directory,'command.json'),JSON.stringify({id:s.applied+1,action:'quit'}));}}catch{}
 child.kill();
},270000);
child.once('error',error=>{clearTimeout(watchdog);console.error(error);process.exitCode=1;});
child.once('exit',(code,signal)=>{
 clearTimeout(watchdog);fs.closeSync(fd);let report;
 try{
  report=JSON.parse(fs.readFileSync(reportFile,'utf8'));if(report.processId!==child.pid)throw Error('REPORT_NOT_FROM_THIS_RUN');
  const log=fs.readFileSync(logFile,'utf8'),messages=[...new Set(log.split(/\r?\n/).filter(line=>line.includes('DesktopCapturer of type')).map(line=>line.split('] ').slice(1).join('] ')))];
  report.backendEvidence={api:'Electron desktopCapturer.getSources window thumbnails',runtimeLog:messages,WgcSessionStarted:log.includes('WGC capture session is outputing CPU memory'),perReturnedThumbnailBackend:'not exposed; no WGC-only pass claimed'};
  report.electronExit={code,signal,timedOut};fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,failed:report.cases.filter(x=>!x.passed).map(x=>x.name),gaps:report.gaps,code,signal,timedOut,report:reportFile,log:logFile}));
 }catch(error){console.error(error);}
 process.exit(code===0&&!timedOut&&report?.passed?0:1);
});
