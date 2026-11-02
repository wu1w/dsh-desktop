import path from 'node:path';
import {homedir} from 'node:os';
import {statSync,accessSync,constants} from 'node:fs';

// Resolve before SDK startup. stat('claude') never searches PATH, and .cmd
// wrappers cannot be spawned by the SDK as a native executable on Windows.
export function resolveClaudeBinary({binary,appRoot,platform=process.platform,arch=process.arch,home=homedir(),env=process.env,isExecutable}={}) {
  const paths=platform==='win32'?path.win32:path.posix;
  const executable=isExecutable??(file=>{try{if(!statSync(file).isFile())return false;accessSync(file,platform==='win32'?constants.F_OK:constants.X_OK);return true;}catch{return false;}});
  const variable=name=>Object.entries(env).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
  const name=platform==='win32'?'claude.exe':'claude';
  const fromPath=value=>{
    if(paths.isAbsolute(value))return [value];
    if(value.includes('/')||value.includes('\\'))return [];
    const entries=String(variable('PATH')??'').split(platform==='win32'?';':':').map(entry=>entry.replace(/^"(.*)"$/,'$1')).filter(entry=>paths.isAbsolute(entry));
    // PATHEXT may include batch scripts. They require cmd.exe and must not be
    // passed to pathToClaudeCodeExecutable; accept native .exe/.com only.
    const extensions=platform==='win32'&&!paths.extname(value)?String(variable('PATHEXT')??'.EXE;.COM').split(';').filter(ext=>/^\.(exe|com)$/i.test(ext)).map(ext=>ext.toLowerCase()):[''];
    return entries.flatMap(entry=>extensions.map(extension=>paths.join(entry,value+extension)));
  };
  const candidates=binary?fromPath(binary):[
    ...(appRoot&&['darwin','win32','linux'].includes(platform)&&['x64','arm64'].includes(arch)?[paths.join(appRoot,'node_modules','@anthropic-ai',`claude-agent-sdk-${platform}-${arch}`,name)]:[]),
    paths.join(home,'.local','bin',name),...fromPath(name),
  ];
  const found=candidates.find(file=>paths.isAbsolute(file)&&!file.includes('\0')&&(platform!=='win32'||/\.(exe|com)$/i.test(file))&&executable(file));
  if(!found)throw Object.assign(new Error('CLAUDE_CLI_NOT_FOUND'),{code:'CLAUDE_CLI_NOT_FOUND'});
  return paths.normalize(found);
}
