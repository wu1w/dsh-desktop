import {updateVolatile} from '@deepseek-ai/cosmokit';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { PtcRuntime } from "@deepseek-ai/dsh-ptc-runtime";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionStore } from "@deepseek-ai/dsh-session";
import * as sessionPersistenceJsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as toolFs from "@deepseek-ai/dsh-tool-fs";
import { defineTool, TOOL_RUNTIME_SCHEDULER } from "@deepseek-ai/dsh-tools";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { WorkingDirectoryService } from "@deepseek-ai/dsh-working-directory";
import { PROVIDER, createOpenCodeAdapter } from "./provider.js";

const PERSONA = "You are a coding agent in the independent DSH client. Use the model and provider selected by the user. Do not infer model identity from the execution engine name. Work only inside the authorized project and the granted tool permissions. Report actual results honestly.";
const MUTATING = new Set(["write", "edit"]);

function denialResult(text) {
  return {
    content: [{ type: "text", text }],
    isError: true,
    error: { message: text },
  };
}

/**
 * Mount the real Cordis services the agent loop injects, plus JSONL
 * persistence and the filesystem tools. One context serves every session.
 */
export async function bootNativeRuntime(options) {
  const ctx = new Context();
  const fibers = [];
  const use = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  };
  try{
  await use(TypertRegistry);
  await use(LlmRuntime);
  await use(SessionProjectionRegistry);
  await use(SessionStore);
  await use(SystemPrompt, {
    includeHarnessIdentity: true,
    includeRuntimeContext: true,
    personaPrefix: PERSONA,
  });
  await use(PtcRuntime);
  await use(ToolRuntime, { mode: "native" });
  await use(ApprovalService, { policy: "ask" });
  await use(LocalFileSystem);
  await use(LocalSandboxProvider);
  await use(SandboxPolicyService, { mode: "read-only", workspaceRoot: options.workspaceRoot });
  await use(WorkingDirectoryService, { defaultDirectory: options.workspaceRoot });
  await use(toolFs, { read: true, readImage: false, write: true, edit: true });
  await use(sessionPersistenceJsonl, { root: options.sessionRoot, compression: "none" });
  await use(checkpointPolicy);
  ctx.on('agent/pre-step',async(payload,next)=>{await options.checkpoint?.();return next();});
  const adapter = options.adapter ?? createOpenCodeAdapter(options);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  installMutationGate(ctx, {
    authorizeMutation: options.authorizeMutation,authorizeTool:options.authorizeTool,
    deniedText: options.translator?.("approval_denied") ?? "The tool change was not approved",
    abortedText: options.translator?.("tool_aborted") ?? "The tool call was aborted before it ran",
  });
  if(options.computerTool&&options.computerCall){
    const spec=options.computerTool;
    ctx.tools.register(defineTool({name:spec.name,description:spec.description,parameters:Object.fromEntries(Object.entries(spec.inputSchema.properties).map(([key,value])=>[key,{type:value.type,...(value.enum?{enum:value.enum}:{}),...(value.description?{description:value.description}:{}),...(spec.inputSchema.required.includes(key)?{required:true}:{})}])),output:{schema:{type:'object',properties:{text:{type:'string',required:true}},additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.text}]},execute:async(args,exec)=>{const {image,...result}=await options.computerCall(exec.agent.session.id,args,{signal:exec.signal});return {text:JSON.stringify(result)};}}));
  }
  if(options.developmentTool&&options.developmentCall){
    const spec=options.developmentTool;
    ctx.tools.register(defineTool({name:spec.name,description:spec.description,parameters:Object.fromEntries(Object.entries(spec.inputSchema.properties).map(([key,value])=>[key,{type:value.type,...(value.enum?{enum:value.enum}:{}),...(value.description?{description:value.description}:{}),...(spec.inputSchema.required.includes(key)?{required:true}:{})}])),output:{schema:{type:'object',properties:{text:{type:'string',required:true}},additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.text}]},execute:async(args,exec)=>{const {image,...result}=await options.developmentCall(exec.agent.session.id,args,{signal:exec.signal});return {text:JSON.stringify(result)};}}));
  }
  await use(AgentRegistry);
  await use(AgentLoop, { agents: [], maxParallelToolCalls: 4 });
  const providers=new Map();let piFiber;let piProfiles={};
  return {
    ctx,
    async ensureProvider(connection){
      if(connection.legacy)return;
      const signature=JSON.stringify([connection.revision,connection.api,connection.baseUrl,connection.models]);
      const current=providers.get(connection.provider);if(current?.signature===signature)return;
      const config={providers:{[connection.provider]:{displayName:connection.providerName,api:connection.api,baseURL:connection.baseUrl,headers:{Authorization:'Bearer '+connection.bearer},models:connection.models.map(m=>({id:m.id,name:m.name,contextWindow:m.contextWindow,maxTokens:m.maxTokens,...(m.reasoning?{reasoningEfforts:{off:null,low:'low',high:'high',max:'max'}}:{})})),retryPolicy:{mode:'normal',maxRetries:0},streamIdleTimeoutMs:300000}}};
      const next={...piProfiles,...config.providers},validated=piAi.Config({providers:next});
      if(!piFiber){piFiber=ctx.plugin(piAi,{providers:next});await piFiber;fibers.push(piFiber);}else{updateVolatile(piFiber.config.providers,validated.providers);piFiber.context.emit('loader/volatile-update');}
      piProfiles=next;providers.set(connection.provider,{signature});
    },
    async dispose() {
      for (const fiber of [...fibers].reverse()) {
        await Promise.resolve(fiber.dispose?.()).catch(() => {});
      }
      await ctx.fiber.dispose();
    },
  };
  }catch(error){await ctx.fiber.dispose().catch(()=>{});throw error;}
}

function installMutationGate(ctx, gate) {
  const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER];
  const prepare = scheduler.prepare.bind(scheduler);
  scheduler.prepare = async (input) => {
    const prepared = await prepare(input);
    const name = input?.name ?? prepared?.exec?.name;
    if (prepared?.kind !== "dispatch" || !prepared.exec) return prepared;
    const deny = (text) => ({ kind: "final-result", exec: prepared.exec, result: denialResult(text) });
    if (prepared.exec.signal?.aborted) return deny(gate.abortedText);
    const policy=await gate.authorizeTool?.(prepared.exec);if(policy!==true)return deny(gate.deniedText);
    if(!MUTATING.has(name))return prepared;
    const verdict = await gate.authorizeMutation?.(prepared.exec);
    if (prepared.exec.signal?.aborted) return deny(gate.abortedText);
    if (verdict !== true) return deny(typeof verdict === "string" && verdict ? verdict : gate.deniedText);
    return prepared;
  };
}
