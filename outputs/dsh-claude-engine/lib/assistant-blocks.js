/**
 * Claude Code emits one assistant envelope per API content block. The envelope's
 * content[0] is not necessarily API block zero (thinking often precedes text).
 * Match stream and snapshot identities within their API message, never by text.
 */
export class AssistantBlocks {
  constructor(){this.messages=new Map();this.currentMessageId=null;}
  message(id){
    if(!this.messages.has(id))this.messages.set(id,{blocks:new Map(),frames:new Map(),nextIndex:0,hasTextSnapshot:false});
    return this.messages.get(id);
  }
  start(id){this.currentMessageId=id;this.message(id);}
  stream(index,type){
    const record=this.message(this.currentMessageId);
    if(!record.blocks.has(index))record.blocks.set(index,{type,finalized:false});
    record.nextIndex=Math.max(record.nextIndex,index+1);
    return `${this.currentMessageId}:${index}`;
  }
  snapshot(envelope){
    const id=envelope.message.id;this.currentMessageId=id;const record=this.message(id);const blocks=envelope.message.content??[];
    const previous=envelope.uuid?record.frames.get(envelope.uuid):null;
    const explicit=Number.isInteger(envelope.apiBlockIndex)&&envelope.apiBlockIndex>=0;
    const indexes=(previous?.length===blocks.length?previous:null)??blocks.map((block,offset)=>{
      if(explicit)return envelope.apiBlockIndex+offset;
      if(blocks.length>1)return offset;
      const pending=[...record.blocks].filter(([,entry])=>entry.type===block.type&&!entry.finalized).sort(([a],[b])=>a-b);
      if(pending.length)return pending[0][0];
      return record.nextIndex++;
    });
    if(envelope.uuid)record.frames.set(envelope.uuid,indexes);
    return blocks.map((block,offset)=>{
      const index=indexes[offset];record.blocks.set(index,{type:block.type,finalized:true});record.nextIndex=Math.max(record.nextIndex,index+1);
      if(block.type==='text')record.hasTextSnapshot=true;
      return {id:`${id}:${index}`,block};
    });
  }
  resultTarget(items,turnId){
    const id=this.currentMessageId,record=this.messages.get(id);
    if(record?.hasTextSnapshot)return {kind:'snapshot-present'};
    const text=[...(record?.blocks??[])].filter(([,block])=>block.type==='text').map(([index])=>items.get(`${id}:${index}`)).filter(Boolean);
    if(text.length===1)return {kind:'complete-stream',id:text[0].id};
    if(text.length>1)return {kind:'complete-blocks',items:text};
    return {kind:'fallback',id:`${id??turnId}:result`};
  }
}
