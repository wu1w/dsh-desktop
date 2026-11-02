export function systemLauncherTarget(command,args){
 if(command==='/usr/bin/open'||command==='xdg-open')return args[0];
 if(!/powershell\.exe$/i.test(command))return null;
 const code=Buffer.from(args.at(-1),'base64').toString('utf16le');
 if(!code.includes('UseShellExecute=$true'))return null;
 const match=code.match(/FromBase64String\('([^']+)'\)/);if(!match)throw Error('SYSTEM_LAUNCHER_TARGET_MISSING');
 return Buffer.from(match[1],'base64').toString('utf8');
}
