const DEFAULT_IDLE_TIMEOUT = 45000;
const DEFAULT_MESSAGE_LIMIT = 4 * 1024 * 1024;
const BLOCK_SIZE = 16384;

export const streamFault = code => Object.assign(new Error(code), { code });

function positive(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError('INVALID_STREAM_LIMIT');
  return result;
}

// Only complete SSE event boundaries dispatch. Fixed-size byte blocks keep
// one-byte network fragmentation linear without an ever-growing string.
export class JsonEventParser {
  constructor(onEvent, { maxMessageBytes = DEFAULT_MESSAGE_LIMIT } = {}) {
    this.onEvent = onEvent;
    this.limit = positive(maxMessageBytes, DEFAULT_MESSAGE_LIMIT);
    this.blocks = [];
    this.block = null;
    this.used = 0;
    this.lineBytes = 0;
    this.eventBytes = 0;
    this.data = [];
    this.dataBytes = 0;
    this.skipLF = false;
    this.firstLine = true;
  }
  _append(bytes) {
    this.eventBytes += bytes.length;
    if (this.eventBytes > this.limit) throw streamFault('EVENTS_MESSAGE_LIMIT');
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.block) { this.block = new Uint8Array(Math.min(BLOCK_SIZE, this.limit)); this.used = 0; }
      const length = Math.min(bytes.length - offset, this.block.length - this.used);
      this.block.set(bytes.subarray(offset, offset + length), this.used);
      this.used += length; this.lineBytes += length; offset += length;
      if (this.used === this.block.length) { this.blocks.push(this.block); this.block = null; this.used = 0; }
    }
  }
  _line() {
    const bytes = new Uint8Array(this.lineBytes);
    let offset = 0;
    for (const block of this.blocks) { bytes.set(block, offset); offset += block.length; }
    if (this.block) bytes.set(this.block.subarray(0, this.used), offset);
    this.blocks = []; this.block = null; this.used = 0; this.lineBytes = 0;
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    let line = decoder.decode(bytes, { stream: true }) + decoder.decode();
    if (this.firstLine) { this.firstLine = false; if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); }
    return line;
  }
  _completeLine() {
    const line = this._line();
    if (line === '') {
      const data = this.data;
      this.data = []; this.dataBytes = 0; this.eventBytes = 0;
      if (!data.length) return;
      let value;
      try { value = JSON.parse(data.join('\n')); }
      catch { throw streamFault('EVENTS_PROTOCOL'); }
      this.onEvent(value);
      return;
    }
    if (line[0] === ':') return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') {
      // Empty data lines also consume a byte in the assembled data buffer.
      this.dataBytes += Math.max(1, line.length);
      if (this.dataBytes > this.limit) throw streamFault('EVENTS_MESSAGE_LIMIT');
      this.data.push(value);
    }
    // id/event/retry and unknown fields do not alter this JSON-only contract.
  }
  push(bytes) {
    if (!(bytes instanceof Uint8Array)) throw streamFault('EVENTS_PROTOCOL');
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (this.skipLF) { this.skipLF = false; if (byte === 10) { start = index + 1; continue; } }
      if (byte !== 10 && byte !== 13) continue;
      this._append(bytes.subarray(start, index));
      if (++this.eventBytes > this.limit) throw streamFault('EVENTS_MESSAGE_LIMIT');
      this._completeLine();
      this.skipLF = byte === 13;
      start = index + 1;
    }
    this._append(bytes.subarray(start));
  }
  finish() {
    // Flush trailing UTF-8 (including an incomplete scalar), but EOF alone is
    // not a blank line: an unfinished event is intentionally discarded.
    this._line();
    this.data = []; this.dataBytes = 0; this.eventBytes = 0;
  }
}

// This controller belongs solely to one transport. It never aborts the caller's
// signal, shares no state with write APIs, and never retries a request.
export async function controlledResponse(openResponse, consume, signal, {
  timeoutMs = DEFAULT_IDLE_TIMEOUT, idle = true, timeoutCode = 'EVENTS_IDLE_TIMEOUT',
  abortCode = 'EVENTS_ABORTED', cleanupTimeoutMs = 1000,
} = {}) {
  const timeout = positive(timeoutMs, DEFAULT_IDLE_TIMEOUT);
  const cleanupTimeout = positive(cleanupTimeoutMs, 1000);
  const controller = new AbortController();
  let timer, reader, response, rejectAbort, stopped = false;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    const failure = reason instanceof Error ? reason : streamFault(abortCode);
    controller.abort(failure);
    rejectAbort(failure);
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => stop(streamFault(timeoutCode)), timeout); };
  const externalAbort = () => stop(streamFault(abortCode));
  const wait = pending => Promise.race([pending, interrupted]);
  if (signal?.aborted) externalAbort();
  else signal?.addEventListener('abort', externalAbort, { once: true });
  if (!stopped) arm();
  const opening = Promise.resolve().then(() => {
    if (stopped) throw controller.signal.reason;
    return openResponse(controller.signal);
  }).then(result => {
    if (stopped) {
      // A custom fetch may ignore cancellation and deliver headers late.
      try { Promise.resolve(result.body?.cancel()).catch(() => {}); } catch {}
      throw controller.signal.reason;
    }
    return result;
  });
  try {
    response = await wait(opening);
    if (response.body) reader = response.body.getReader();
    if (idle) arm();
    return await consume(response, {
      stop,
      async read() {
        if (!reader) return { done: true, value: undefined };
        const result = await wait(reader.read());
        if (idle && result.value?.byteLength) arm();
        return result;
      },
      check() { if (stopped) throw controller.signal.reason; },
      wait,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', externalAbort);
    controller.abort();
    if (reader) {
      let cleanupTimer;
      try {
        await Promise.race([
          Promise.resolve().then(() => reader.cancel()).catch(() => {}),
          new Promise(resolve => { cleanupTimer = setTimeout(resolve, cleanupTimeout); }),
        ]);
      } finally { clearTimeout(cleanupTimer); reader.releaseLock(); }
    } else if (response?.body) {
      try { await response.body.cancel(); } catch {}
    }
  }
}

export function readEventStream(openResponse, onEvent, signal, options = {}) {
  if (typeof onEvent !== 'function') throw new TypeError('INVALID_EVENT_LISTENER');
  const pendingEvents = [];
  const parser = new JsonEventParser(value => {
    const pending = onEvent(value);
    if (pending?.then) {
      const completion = Promise.resolve(pending);
      completion.catch(reason => active.stop(reason));
      pendingEvents.push(completion);
    }
    active.check();
  }, options);
  let active;
  return controlledResponse(openResponse, async (response, transport) => {
    active = transport;
    if (!response.ok) throw streamFault(`EVENTS_${response.status}`);
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') throw streamFault('EVENTS_CONTENT_TYPE');
    if (!response.body) throw streamFault('EVENTS_BODY_MISSING');
    if (options.onOpen) {
      const pending = options.onOpen();
      if (pending?.then) Promise.resolve(pending).catch(reason => transport.stop(reason));
    }
    transport.check();
    while (true) {
      const { value, done } = await transport.read();
      transport.check();
      if (done) { parser.finish(); return; }
      parser.push(value);
      if (pendingEvents.length) await transport.wait(Promise.all(pendingEvents.splice(0)));
    }
  }, signal, { ...options, timeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT });
}

// Small JSON handshakes/reads share the stream watchdog and cancellation rules.
export function readJsonResponse(openResponse, signal, {maxBytes=16*1024*1024,timeoutMs=15000}={}) {
  positive(maxBytes,16*1024*1024);
  return controlledResponse(openResponse,async(response,transport)=>{
    if(!response.ok)throw streamFault(`HTTP_${response.status}`);
    if(!response.body)throw streamFault('JSON_BODY_MISSING');
    const chunks=[];let length=0,block,used=0;
    for(;;){
      const {value,done}=await transport.read();if(done)break;
      length+=value.byteLength;if(length>maxBytes)throw streamFault('JSON_RESPONSE_LIMIT');
      let offset=0;
      while(offset<value.byteLength){if(!block){block=new Uint8Array(Math.min(BLOCK_SIZE,maxBytes));used=0;}const size=Math.min(value.byteLength-offset,block.byteLength-used);block.set(value.subarray(offset,offset+size),used);used+=size;offset+=size;if(used===block.byteLength){chunks.push(block);block=null;used=0;}}
    }
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}if(block)bytes.set(block.subarray(0,used),offset);
    let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw streamFault('JSON_PROTOCOL');}
    transport.check();return data;
  },signal,{timeoutMs,idle:false,timeoutCode:'JSON_TIMEOUT',abortCode:'JSON_ABORTED'});
}
