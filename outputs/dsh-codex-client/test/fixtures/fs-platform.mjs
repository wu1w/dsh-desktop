import {symlink,stat} from 'node:fs/promises';
import path from 'node:path';
// Directory junctions exercise native Windows alias boundaries without granting
// symlink privileges. File symlinks remain real symlinks: unavailable privilege
// is reported by the original test, never converted into a skip or hardlink.
export async function fixtureSymlink(target,link,type){
 if(process.platform==='win32'){
  const absolute=path.resolve(path.dirname(link),target),info=await stat(absolute).catch(()=>null);
  if(info?.isDirectory())return symlink(absolute,link,'junction');
 }
 return symlink(target,link,type);
}
