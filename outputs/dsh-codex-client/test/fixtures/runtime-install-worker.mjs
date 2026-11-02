import path from 'node:path';
import {installStagedRuntime} from '../../scripts/prepare-channel-runtime.mjs';
import {rename} from 'node:fs/promises';
const [root,stage,fail]=process.argv.slice(2);let release;
const gate=new Promise(resolve=>release=resolve);process.on('message',m=>{if(m==='release')release();});process.send({started:true});
try{await installStagedRuntime(root,stage,{renamePath:async(from,to)=>{if(from===path.join(stage,'python')){process.send({entered:true});await gate;}if(fail==='fail'&&from===path.join(stage,'packages'))throw Object.assign(Error('fixture failure'),{code:'EIO'});return rename(from,to);}});process.send({done:true});}
catch(error){process.send({error:error.code||error.message});}
finally{process.disconnect();}
