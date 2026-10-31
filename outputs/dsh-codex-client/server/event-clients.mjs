const MIB=1024*1024;
const CONNECTED=Buffer.from(': connected\n\n'),HEARTBEAT=Buffer.from(': heartbeat\n\n');
const positive=(value,name)=>{if(!Number.isSafeInteger(value)||value<1)throw new TypeError(name);return value;};

// Each write accepts the complete frame, even when it returns false. Only the
// subsequent frames wait for drain; accepted data is never placed back in FIFO.
export class EventClients {
  constructor({maxFrameBytes=4*MIB,maxBufferBytes=8*MIB,maxPendingFrames=256,stallTimeoutMs=10000}={}){
    this.maxFrameBytes=positive(maxFrameBytes,'INVALID_EVENT_FRAME_LIMIT');this.maxBufferBytes=positive(maxBufferBytes,'INVALID_EVENT_BUFFER_LIMIT');this.maxPendingFrames=positive(maxPendingFrames,'INVALID_EVENT_QUEUE_LIMIT');this.stallTimeoutMs=positive(stallTimeoutMs,'INVALID_EVENT_STALL_LIMIT');
    this.clients=new Map();this.closed=false;
  }
  get size(){return this.clients.size;}
  snapshot(){return [...this.clients.values()].map(record=>({pendingFrames:record.queue.length,pendingBytes:record.pendingBytes,writableBytes:this._writable(record),blocked:record.blocked}));}
  _writable(record){const value=record.response.writableLength;return Number.isSafeInteger(value)&&value>=0?value:0;}
  _current(record){return this.clients.get(record.response)===record;}
  _remove(record){
    if(!this._current(record))return false;
    this.clients.delete(record.response);clearTimeout(record.timer);record.timer=null;record.queue=[];record.pendingBytes=0;
    record.response.removeListener('drain',record.onDrain);record.response.removeListener('close',record.onClose);record.response.removeListener('error',record.onError);record.response.removeListener('finish',record.onClose);return true;
  }
  _drop(record){if(!this._remove(record))return;try{record.response.destroy();}catch{/* Other connections must still make progress. */}}
  _stall(record){if(record.timer)return;record.timer=setTimeout(()=>{record.timer=null;this._drop(record);},this.stallTimeoutMs);record.timer.unref?.();}
  _pump(record){
    while(this._current(record)&&!record.blocked&&record.queue.length){
      if(record.response.destroyed||record.response.writableEnded||record.pendingBytes+this._writable(record)>this.maxBufferBytes){this._drop(record);return;}
      const frame=record.queue.shift();record.pendingBytes-=frame.length;
      try{const accepted=record.response.write(frame);if(!this._current(record))return;if(!accepted){record.blocked=true;this._stall(record);}}
      catch{this._drop(record);return;}
      if(record.pendingBytes+this._writable(record)>this.maxBufferBytes){this._drop(record);return;}
    }
  }
  _enqueue(response,frame){
    const record=this.clients.get(response);if(!record)return false;
    if(response.destroyed||response.writableEnded||frame.length>this.maxFrameBytes||record.queue.length>=this.maxPendingFrames||frame.length+record.pendingBytes+this._writable(record)>this.maxBufferBytes){this._drop(record);return false;}
    record.queue.push(frame);record.pendingBytes+=frame.length;this._pump(record);return this._current(record);
  }
  add(response){
    if(this.closed){try{response.destroy();}catch{}return false;}if(this.clients.has(response))return true;
    const record={response,queue:[],pendingBytes:0,blocked:false,timer:null};
    record.onDrain=()=>{if(!this._current(record))return;clearTimeout(record.timer);record.timer=null;record.blocked=false;this._pump(record);};record.onClose=()=>this._remove(record);record.onError=()=>this._drop(record);
    this.clients.set(response,record);response.on('drain',record.onDrain);response.on('close',record.onClose);response.on('error',record.onError);response.on('finish',record.onClose);
    return this._enqueue(response,CONNECTED);
  }
  delete(response){const record=this.clients.get(response);return record?this._remove(record):false;}
  send(response,value){return this._enqueue(response,Buffer.from(`data: ${JSON.stringify(value)}\n\n`));}
  broadcast(value){const frame=Buffer.from(`data: ${JSON.stringify(value)}\n\n`);for(const response of this.clients.keys())this._enqueue(response,frame);}
  heartbeat(){for(const response of this.clients.keys())this._enqueue(response,HEARTBEAT);}
  close(){
    if(this.closed)return;this.closed=true;
    for(const record of [...this.clients.values()]){const blocked=record.blocked||record.queue.length>0||this._writable(record)>0;if(!this._remove(record))continue;try{if(blocked)record.response.destroy();else record.response.end();}catch{try{record.response.destroy();}catch{}}}
  }
}
