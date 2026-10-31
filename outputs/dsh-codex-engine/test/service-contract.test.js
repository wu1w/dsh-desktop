import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import apply from "../lib/plugin.js";
import { engineOptions, tempDir, removeDir, readTrace, inbound, waitFor } from "./helpers.js";

test("Cordis consumers receive the complete engine API with arguments, promise identity and errors intact", async () => {
  const dataDir=await tempDir(),ctx=new Context();
  const originals=new Map();let engine;
  try {
    await apply(ctx,engineOptions(dataDir));const service=ctx.codexEngine;engine=service.engine;
    const options={includeTurns:true},params={queuedSubmissionId:"queued-1",input:[{type:"text",text:"next"}]};
    const contracts=[
      ["start",[]],["ensureStarted",[]],["createSession",["chat",{cwd:dataDir}]],
      ["resumeSession",["chat"]],["startTurn",["chat","prompt",{sandbox:"read-only"}]],
      ["interrupt",["chat"]],["steer",["chat","correction"]],["readSession",["chat",options]],
      ["readTurnState",["chat","native-turn"]],
      ["listSessionItems",["chat",{cursor:"items-cursor",limit:3,sortDirection:"asc"}]],
      ["listSessionTurns",["chat",{cursor:"turns-cursor",limit:2,sortDirection:"desc",itemsView:"summary"}]],
      ["listSessions",[]],["queueRequest",["chat","update",params]],["moveSession",["chat",dataDir]],
      ["setModel",["chat","deepseek-v4.1-flash"]],["archiveSession",["chat"]],
      ["restoreSession",["chat"]],["renameSession",["chat","renamed"]],["forkSession",["chat","fork"]],
      ["respondApproval",["approval-1",{decision:"accept"}]],["status",[]],["dispose",[]],
    ];
    for(const [name,args]of contracts){
      assert.equal(typeof service[name],"function",name);originals.set(name,engine[name]);
      const returned=Promise.resolve({method:name});let called=false;
      engine[name]=function(...received){assert.equal(this,engine,name);assert.equal(received.length,args.length,name);received.forEach((value,index)=>assert.equal(value,args[index],`${name} argument ${index}`));called=true;return returned;};
      assert.equal(service[name](...args),returned,name);assert.equal(called,true,name);
      engine[name]=originals.get(name);originals.delete(name);
    }
    const failure=Object.assign(new Error("queue rejected"),{code:"QUEUE_REJECTED"});originals.set("queueRequest",engine.queueRequest);engine.queueRequest=()=>{throw failure;};assert.throws(()=>service.queueRequest("chat","start",params),error=>error===failure);
  } finally {
    if(engine)for(const [name,original]of originals)engine[name]=original;
    await ctx.fiber.dispose();await removeDir(dataDir);
  }
});

test("Cordis service options reach App Server and its getters track a running and unloaded child", async () => {
  const dataDir=await tempDir(),ctx=new Context();let service;
  try {
    await apply(ctx,engineOptions(dataDir));service=ctx.codexEngine;
    assert.equal(service.ready,false);assert.equal(service.state,"idle");assert.equal(service.activeTurns.size,0);
    await service.ensureStarted();assert.equal(service.ready,true);assert.equal(service.state,"ready");
    const session=await service.createSession("consumer",{cwd:dataDir});
    await service.readSession("consumer",{includeTurns:true});
    const reads=inbound(await readTrace(dataDir),"thread/read");assert.equal(reads.at(-1).msg.params.includeTurns,true);assert.equal(reads.at(-1).msg.params.threadId,session.threadId);
    const turn=await service.startTurn("consumer","hold this turn");assert.equal(service.state,"turn-active");assert.equal(service.activeTurns.get("consumer").turnId,turn.turnId);
    const snapshot=service.activeTurns;snapshot.clear();assert.equal(service.activeTurns.size,1);
    await service.interrupt("consumer");await waitFor(()=>service.activeTurns.size===0);assert.equal(service.state,"ready");
    await ctx.fiber.dispose();assert.equal(ctx.codexEngine,undefined);assert.equal(service.ready,false);assert.equal(service.state,"disposed");assert.equal(service.activeTurns.size,0);
  } finally {
    await ctx.fiber.dispose();await removeDir(dataDir);
  }
});
