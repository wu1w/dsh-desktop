import assert from 'node:assert/strict';
export const windows=process.platform==='win32';
export const commandShell=windows?undefined:'/bin/sh';
export const shellQuote=text=>"'"+text.replaceAll("'",windows?"''":"'\\''")+"'";
// PowerShell 5.1 rewrites embedded double quotes in native argv. Transfer the
// fixture source as data so the test exercises the command lifecycle reliably.
export const nodeCommand=code=>windows?'& '+shellQuote(process.execPath)+" -e 'eval(Buffer.from(process.argv[1],process.argv[2]).toString())' "+Buffer.from(code).toString('base64')+' base64':'exec '+shellQuote(process.execPath)+' -e '+shellQuote(code);
export const outputCommand=text=>nodeCommand('process.stdout.write('+JSON.stringify(text)+')');
export function assertStopped(result){if(windows){assert.equal(result.code,125);assert.equal(result.signal,null);}else assert.equal(result.signal,'SIGKILL');}
