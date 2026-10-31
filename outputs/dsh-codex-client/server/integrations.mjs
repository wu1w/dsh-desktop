import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "integrations.json";
const MCP_STATUSES = new Set([
  "notStarted",
  "starting",
  "connected",
  "authenticationRequired",
  "failed",
  "cancelled",
  "disabled",
]);
const MASKED_SECRET = /^[*•●·∙\u2022\u25CF\u00B7]+$/u;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ERROR_CODE = /^[A-Z0-9_]+$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function emptyState() {
  return { version: 1, mcpServers: Object.create(null), skillExtraRoots: [] };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeName(name) {
  return typeof name === "string" && SAFE_NAME.test(name);
}

function isMaskedSecret(value) {
  return typeof value === "string" && value.length > 0 && MASKED_SECRET.test(value);
}

function cloneEntry(entry) {
  const env = Object.create(null);
  for (const key of Object.keys(entry.env)) env[key] = entry.env[key];
  return {
    name: entry.name,
    transport: entry.transport,
    command: entry.command,
    args: entry.args.slice(),
    url: entry.url,
    env,
    enabled: entry.enabled,
    error: entry.error,
  };
}

function parseArgs(args) {
  if (!Array.isArray(args)) throw fail("INVALID_MCP_CONFIG");
  for (const item of args) {
    if (typeof item !== "string") throw fail("INVALID_MCP_CONFIG");
  }
  return args.slice();
}

function parseEnv(env) {
  if (env === null) return Object.create(null);
  if (!isPlainObject(env)) throw fail("INVALID_MCP_CONFIG");
  const out = Object.create(null);
  for (const key of Object.keys(env)) {
    if (!ENV_KEY.test(key)) throw fail("INVALID_MCP_CONFIG");
    const value = env[key];
    if (typeof value !== "string") throw fail("INVALID_MCP_CONFIG");
    if (isMaskedSecret(value)) throw fail("INVALID_MCP_CONFIG");
    out[key] = value;
  }
  return out;
}

function parseHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0) throw fail("INVALID_MCP_CONFIG");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("INVALID_MCP_CONFIG");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("INVALID_MCP_CONFIG");
  if (url.username || url.password || url.search || url.hash) throw fail("INVALID_MCP_CONFIG");
  return `${url.origin}${url.pathname}`;
}

function copyEnv(env) {
  const out = Object.create(null);
  for (const key of Object.keys(env).sort()) out[key] = env[key];
  return out;
}

function normalizeState(parsed) {
  if (!isPlainObject(parsed) || parsed.version !== 1) throw fail("STATE_CORRUPT");
  if (!isPlainObject(parsed.mcpServers) || !Array.isArray(parsed.skillExtraRoots)) {
    throw fail("STATE_CORRUPT");
  }
  const mcpServers = Object.create(null);
  for (const name of Object.keys(parsed.mcpServers)) {
    if (!isSafeName(name)) throw fail("STATE_CORRUPT");
    const entry = parsed.mcpServers[name];
    if (!isPlainObject(entry) || entry.name !== name) throw fail("STATE_CORRUPT");
    if (entry.transport !== "stdio" && entry.transport !== "http") throw fail("STATE_CORRUPT");
    if (typeof entry.enabled !== "boolean") throw fail("STATE_CORRUPT");
    if (!(entry.error === null || (typeof entry.error === "string" && ERROR_CODE.test(entry.error)))) {
      throw fail("STATE_CORRUPT");
    }
    if (!Array.isArray(entry.args) || entry.args.some((item) => typeof item !== "string")) {
      throw fail("STATE_CORRUPT");
    }
    if (!isPlainObject(entry.env)) throw fail("STATE_CORRUPT");
    const env = Object.create(null);
    for (const key of Object.keys(entry.env)) {
      if (!ENV_KEY.test(key) || typeof entry.env[key] !== "string") throw fail("STATE_CORRUPT");
      env[key] = entry.env[key];
    }
    if (entry.transport === "stdio") {
      if (typeof entry.command !== "string" || entry.command.length === 0 || entry.url !== null) {
        throw fail("STATE_CORRUPT");
      }
      mcpServers[name] = {
        name,
        transport: "stdio",
        command: entry.command,
        args: entry.args.slice(),
        url: null,
        env,
        enabled: entry.enabled,
        error: entry.error,
      };
    } else {
      if (typeof entry.url !== "string" || entry.url.length === 0 || entry.command !== null || entry.args.length !== 0) {
        throw fail("STATE_CORRUPT");
      }
      mcpServers[name] = {
        name,
        transport: "http",
        command: null,
        args: [],
        url: entry.url,
        env,
        enabled: entry.enabled,
        error: entry.error,
      };
    }
  }
  const skillExtraRoots = [];
  for (const root of parsed.skillExtraRoots) {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("STATE_CORRUPT");
    if (!skillExtraRoots.includes(root)) skillExtraRoots.push(root);
  }
  return { version: 1, mcpServers, skillExtraRoots };
}

function serializeState(state) {
  const mcpServers = {};
  for (const name of Object.keys(state.mcpServers).sort()) {
    const entry = state.mcpServers[name];
    mcpServers[name] = {
      name: entry.name,
      transport: entry.transport,
      command: entry.command,
      args: entry.args,
      url: entry.url,
      env: copyEnv(entry.env),
      enabled: entry.enabled,
      error: entry.error,
    };
  }
  return `${JSON.stringify({ version: 1, mcpServers, skillExtraRoots: state.skillExtraRoots.slice() }, null, 2)}\n`;
}

function mapRuntime(runtimeStatus) {
  if (typeof runtimeStatus === "string" && MCP_STATUSES.has(runtimeStatus)) return runtimeStatus;
  return "unavailable";
}

export class IntegrationManager {
  constructor({ dataDir, getEngine, getCwds }) {
    this.dataDir = dataDir;
    this.getEngine = getEngine;
    this.getCwds = getCwds;
    this.state = emptyState();
    this.loaded = false;
    this.writeChain = Promise.resolve();
    this.mutationChain = Promise.resolve();
    // Serialize the complete disk + native-RPC transaction. State-only ordering
    // allowed an older config write to win after a newer edit had been saved.
    for (const method of ['saveMcpServer','removeMcpServer','loginMcpServer','apply','suspend','setSkillEnabled','addSkillRoot']) {
      const original=this[method].bind(this);
      this[method]=(...args)=>{const run=this.mutationChain.then(()=>original(...args),()=>original(...args));this.mutationChain=run.catch(()=>{});return run;};
    }
  }

  async load() {
    await this._enqueue(() => {
      this._readStateForce();
    });
  }

  async listMcpServers() {
    const entries = await this._enqueue(() => {
      this._readIfNeeded();
      return Object.keys(this.state.mcpServers).sort().map((name) => cloneEntry(this.state.mcpServers[name]));
    });
    const live = await this._fetchStatus(entries.map((entry) => entry.name));
    return entries.map((entry) => this._publicServer(entry, live.byName.get(entry.name) ?? null, live.error));
  }

  async saveMcpServer(input) {
    if(input?.name==='dsh_computer')throw fail("INVALID_MCP_CONFIG");
    const entry = await this._enqueue(() => {
      this._readIfNeeded();
      const next = this._mergeMcp(input);
      const restore = this._replaceServer(next.name, next);
      try {
        this._writeState();
      } catch (error) {
        restore();
        throw error;
      }
      return cloneEntry(next);
    });
    const engine = this._engineIfReady();
    if (!engine) {
      await this._setError(entry.name, "ENGINE_DISABLED");
      throw fail("ENGINE_DISABLED");
    }
    try {
      await this._rpc(engine, "config/value/write", this._writeParams(engine, entry));
      await this._rpc(engine, "config/mcpServer/reload", {});
      await this._setError(entry.name, null);
    } catch (error) {
      const code = error && error.code === "STALE_ENGINE" ? "STALE_ENGINE" : "MCP_APPLY_FAILED";
      await this._setError(entry.name, code);
      throw fail(code);
    }
    entry.error = null;
    const live = await this._fetchStatus([entry.name]);
    return this._publicServer(entry, live.byName.get(entry.name) ?? null, live.error);
  }

  async removeMcpServer(name) {
    if(name==='dsh_computer')throw fail("MCP_SERVER_UNKNOWN");
    if (!isSafeName(name)) throw fail("MCP_SERVER_UNKNOWN");
    const entry = await this._enqueue(() => {
      this._readIfNeeded();
      const current = this.state.mcpServers[name];
      if (!current) throw fail("MCP_SERVER_UNKNOWN");
      return cloneEntry(current);
    });
    const engine = this._engineIfReady();
    if (!engine) {
      await this._setError(name, "ENGINE_DISABLED");
      throw fail("ENGINE_DISABLED");
    }
    // value:null deletes mcp_servers.<name> because JsonValue allows null.
    // If that write is rejected, rewrite only this owned key with enabled:false
    // and drop it from our catalog. The disabled key can remain in this
    // CODEX_HOME config. Foreign mcp_servers keys are never written.
    let configCleanup = "deleted";
    try {
      await this._rpc(engine, "config/value/write", {
        keyPath: `mcp_servers.${name}`,
        value: null,
        mergeStrategy: "replace",
        filePath: this._configFile(engine),
      });
    } catch (error) {
      if (error && error.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
      configCleanup = "disabled";
      try {
        await this._rpc(engine, "config/value/write", this._writeParams(engine, entry, false));
      } catch (fallbackError) {
        if (fallbackError && fallbackError.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
        await this._setError(name, "MCP_APPLY_FAILED");
        throw fail("MCP_APPLY_FAILED");
      }
    }
    await this._enqueue(() => {
      this._readIfNeeded();
      const restore = this._replaceServer(name, null);
      try {
        this._writeState();
      } catch (error) {
        restore();
        throw error;
      }
    });
    try {
      await this._rpc(engine, "config/mcpServer/reload", {});
    } catch (error) {
      if (error && error.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
      throw fail("MCP_APPLY_FAILED");
    }
    return { name, removed: true, configCleanup };
  }

  async loginMcpServer(name) {
    if (!isSafeName(name)) throw fail("MCP_SERVER_UNKNOWN");
    await this._enqueue(() => {
      this._readIfNeeded();
      if (!this.state.mcpServers[name]) throw fail("MCP_SERVER_UNKNOWN");
    });
    const engine = this._engineIfReady();
    if (!engine) throw fail("ENGINE_DISABLED");
    let response;
    try {
      response = await this._rpc(engine, "mcpServer/oauth/login", { name });
    } catch (error) {
      if (error && error.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
      throw fail("MCP_LOGIN_FAILED");
    }
    if (!response || typeof response.authorizationUrl !== "string" || response.authorizationUrl.length === 0) {
      throw fail("MCP_LOGIN_FAILED");
    }
    const out = { authorizationUrl: response.authorizationUrl };
    if (typeof response.loginId === "string" && response.loginId.length > 0) out.loginId = response.loginId;
    return out;
  }

  async apply() {
    const engine = this._engineIfReady();
    if (!engine) throw fail("ENGINE_DISABLED");
    const snapshot = await this._enqueue(() => {
      this._readIfNeeded();
      return {
        servers: Object.keys(this.state.mcpServers).sort().map((name) => cloneEntry(this.state.mcpServers[name])),
        roots: this.state.skillExtraRoots.slice(),
      };
    });
    const failed = [];
    for (const entry of snapshot.servers) {
      if (this.getEngine() !== engine) throw fail("STALE_ENGINE");
      try {
        await this._rpc(engine, "config/value/write", this._writeParams(engine, entry));
        await this._setError(entry.name, null);
      } catch (error) {
        if (error && error.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
        await this._setError(entry.name, "MCP_APPLY_FAILED");
        failed.push(entry.name);
      }
    }
    if (this.getEngine() !== engine) throw fail("STALE_ENGINE");
    if (snapshot.roots.length > 0) {
      try {
        await this._rpc(engine, "skills/extraRoots/set", { extraRoots: snapshot.roots });
      } catch (error) {
        if (error && error.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
        throw fail("SKILL_ROOT_APPLY_FAILED");
      }
    }
    try {
      await this._rpc(engine, "config/mcpServer/reload", {});
    } catch (error) {
      if (error && error.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
      throw fail("MCP_APPLY_FAILED");
    }
    if (failed.length > 0) throw fail("MCP_APPLY_FAILED");
    return { ok: true };
  }

  async suspend() {
    const engine=this._engineIfReady();
    if(!engine)return {ok:true};
    const entries=await this._enqueue(()=>{this._readIfNeeded();return Object.values(this.state.mcpServers).map(cloneEntry);});
    for(const entry of entries)await this._rpc(engine,'config/value/write',this._writeParams(engine,entry,false));
    await this._rpc(engine,'skills/extraRoots/set',{extraRoots:[]});
    await this._rpc(engine,'config/mcpServer/reload',{});
    return {ok:true};
  }

  async listSkills() {
    const engine = this._engineIfReady();
    if (!engine) throw fail("ENGINE_DISABLED");
    const cwds = this._ownedCwds();
    if (cwds.length === 0) return { skills: [], errors: [] };
    let response;
    try {
      response = await engine.client.request("skills/list", { cwds, forceReload: true });
    } catch {
      throw fail("SKILL_LIST_FAILED");
    }
    if (this.getEngine() !== engine) throw fail("STALE_ENGINE");
    if (!response || !Array.isArray(response.data)) throw fail("SKILL_LIST_FAILED");
    const roots = await this._enqueue(() => {
      this._readIfNeeded();
      return this.state.skillExtraRoots.slice();
    });
    const allowed = new Set([...cwds, ...roots]);
    const skills = [];
    const errors = [];
    for (const entry of response.data) {
      if (!isPlainObject(entry) || typeof entry.cwd !== "string" || !allowed.has(entry.cwd)) continue;
      const cwd = entry.cwd;
      for (const skill of Array.isArray(entry.skills) ? entry.skills : []) {
        if (!isPlainObject(skill) || typeof skill.name !== "string" || typeof skill.path !== "string") continue;
        skills.push({
          name: skill.name,
          description: typeof skill.description === "string" ? skill.description : "",
          path: skill.path,
          enabled: skill.enabled === true,
          cwd,
        });
      }
      for (const item of Array.isArray(entry.errors) ? entry.errors : []) {
        if (!isPlainObject(item)) continue;
        errors.push({
          path: typeof item.path === "string" ? item.path : "",
          cwd,
          code: "SKILL_LIST_ERROR",
        });
      }
    }
    return { skills, errors };
  }

  async setSkillEnabled(skillPath, enabled) {
    if (typeof enabled !== "boolean") throw fail("INVALID_SKILL_CONFIG");
    if (typeof skillPath !== "string" || !path.isAbsolute(skillPath)) throw fail("SKILL_PATH_UNKNOWN");
    const engine = this._engineIfReady();
    if (!engine) throw fail("ENGINE_DISABLED");
    const listed = await this.listSkills();
    if (this.getEngine() !== engine) throw fail("STALE_ENGINE");
    if (!listed.skills.some((skill) => skill.path === skillPath)) throw fail("SKILL_PATH_UNKNOWN");
    let response;
    try {
      response = await this._rpc(engine, "skills/config/write", { path: skillPath, enabled });
    } catch (error) {
      if (error && error.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
      throw fail("SKILL_CONFIG_FAILED");
    }
    const effective = response && typeof response.effectiveEnabled === "boolean" ? response.effectiveEnabled : enabled;
    return { path: skillPath, enabled: effective };
  }

  async addSkillRoot(rootPath) {
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) throw fail("INVALID_SKILL_ROOT");
    try {
      const stat = fs.statSync(rootPath);
      if (!stat.isDirectory()) throw fail("INVALID_SKILL_ROOT");
    } catch (error) {
      if (error && error.code === "INVALID_SKILL_ROOT") throw error;
      throw fail("INVALID_SKILL_ROOT");
    }
    const roots = await this._enqueue(() => {
      this._readIfNeeded();
      const previous = this.state.skillExtraRoots.slice();
      if (!this.state.skillExtraRoots.includes(rootPath)) this.state.skillExtraRoots.push(rootPath);
      try {
        this._writeState();
      } catch (error) {
        this.state.skillExtraRoots = previous;
        throw error;
      }
      return this.state.skillExtraRoots.slice();
    });
    const engine = this._engineIfReady();
    if (!engine) throw fail("ENGINE_DISABLED");
    try {
      await this._rpc(engine, "skills/extraRoots/set", { extraRoots: roots });
    } catch (error) {
      if (error && error.code === "STALE_ENGINE") throw fail("STALE_ENGINE");
      throw fail("SKILL_ROOT_APPLY_FAILED");
    }
    const listed = await this.listSkills();
    return { roots, skills: listed.skills, errors: listed.errors };
  }

  _mergeMcp(input) {
    if (!isPlainObject(input) || !isSafeName(input.name)) throw fail("INVALID_MCP_CONFIG");
    const previous = this.state.mcpServers[input.name] ? cloneEntry(this.state.mcpServers[input.name]) : null;
    const commandGiven = Object.prototype.hasOwnProperty.call(input, "command");
    const urlGiven = Object.prototype.hasOwnProperty.call(input, "url");
    const argsGiven = Object.prototype.hasOwnProperty.call(input, "args");
    if (commandGiven && urlGiven) throw fail("INVALID_MCP_CONFIG");

    let transport;
    let command;
    let args;
    let url;
    if (!commandGiven && !urlGiven) {
      if (!previous) throw fail("INVALID_MCP_CONFIG");
      transport = previous.transport;
      command = previous.command;
      url = previous.url;
      args = argsGiven ? parseArgs(input.args) : previous.args.slice();
      if (transport === "http") {
        if (args.length > 0) throw fail("INVALID_MCP_CONFIG");
        args = [];
      }
    } else if (commandGiven) {
      if (typeof input.command !== "string" || input.command.length === 0) throw fail("INVALID_MCP_CONFIG");
      transport = "stdio";
      command = input.command;
      url = null;
      args = argsGiven ? parseArgs(input.args) : [];
    } else {
      if (argsGiven) {
        const parsed = parseArgs(input.args);
        if (parsed.length > 0) throw fail("INVALID_MCP_CONFIG");
      }
      transport = "http";
      command = null;
      args = [];
      url = parseHttpUrl(input.url);
    }

    let env;
    if (!Object.prototype.hasOwnProperty.call(input, "env") || input.env === undefined) {
      env = previous ? copyEnv(previous.env) : Object.create(null);
    } else {
      env = parseEnv(input.env);
    }
    if(transport==='http'&&Object.keys(env).length)throw fail('HTTP_ENV_UNSUPPORTED');

    let enabled;
    if (!Object.prototype.hasOwnProperty.call(input, "enabled") || input.enabled === undefined) {
      enabled = previous ? previous.enabled : true;
    } else if (typeof input.enabled !== "boolean") {
      throw fail("INVALID_MCP_CONFIG");
    } else {
      enabled = input.enabled;
    }

    return { name: input.name, transport, command, args, url, env, enabled, error: null };
  }

  _configValue(entry, enabled = entry.enabled) {
    const value = { enabled };
    if (entry.transport === "stdio") {
      value.command = entry.command;
      value.args = entry.args.slice();
    } else {
      value.url = entry.url;
    }
    const env = copyEnv(entry.env);
    if (Object.keys(env).length > 0) value.env = env;
    return value;
  }

  _configFile(engine) {
    return path.join(engine.codexHome, "config.toml");
  }

  _writeParams(engine, entry, enabled = entry.enabled) {
    return {
      keyPath: `mcp_servers.${entry.name}`,
      value: this._configValue(entry, enabled),
      mergeStrategy: "replace",
      filePath: this._configFile(engine),
    };
  }

  _publicServer(entry, item, fetchError) {
    const envKeys = Object.keys(entry.env).sort();
    let status = "unavailable";
    let authStatus = null;
    if (item) {
      status = mapRuntime(item.runtimeStatus);
      if (typeof item.authStatus === "string") authStatus = item.authStatus;
    }
    const toolNames=item&&isPlainObject(item.tools)?Object.keys(item.tools).slice(0,500):[];
    if(!entry.enabled)status='disabled';
    else if(status==='unavailable'&&item&&item.toolsError===null&&toolNames.length)status='catalogued';
    let error = entry.error;
    if (!error && !item && fetchError) error = fetchError;
    const out = {
      name: entry.name,
      enabled: entry.enabled,
      transport: entry.transport,
      envKeys,
      envConfigured: envKeys.length > 0,
      headerKeys: [],
      headersConfigured: false,
      status,
      authStatus,
      error,
      toolCount:toolNames.length,
      tools:Object.fromEntries(toolNames.map(name=>[name,{name}])),
      toolsError:item?.toolsError?'TOOL_DISCOVERY_FAILED':null,
    };
    if (entry.transport === "stdio") {
      out.command = entry.command;
      out.args = entry.args.slice();
    } else {
      out.url = entry.url;
    }
    return out;
  }

  async _fetchStatus(names) {
    const engine = this._engineIfReady();
    if (!engine) return { error: "ENGINE_DISABLED", byName: new Map() };
    const owned = new Set(names);
    const byName = new Map();
    let cursor = null;
    try {
      for (let page = 0; page < 20; page += 1) {
        const params = { detail: "toolsAndAuthOnly" };
        if (cursor) params.cursor = cursor;
        const response = await engine.client.request("mcpServerStatus/list", params);
        if (this.getEngine() !== engine) return { error: "STALE_ENGINE", byName: new Map() };
        const data = Array.isArray(response?.data) ? response.data : [];
        for (const item of data) {
          if (isPlainObject(item) && typeof item.name === "string" && owned.has(item.name)) byName.set(item.name, item);
        }
        const next = typeof response?.nextCursor === "string" && response.nextCursor.length > 0 ? response.nextCursor : null;
        if (!next || next === cursor) break;
        cursor = next;
      }
    } catch {
      return { error: "MCP_STATUS_UNAVAILABLE", byName: new Map() };
    }
    return { error: null, byName };
  }

  _engineIfReady() {
    let engine;
    try {
      engine = this.getEngine();
    } catch {
      return null;
    }
    if (!engine || engine.ready !== true || !engine.client || typeof engine.client.request !== "function") return null;
    if (typeof engine.codexHome !== "string" || engine.codexHome.length === 0) return null;
    return engine;
  }

  _ownedCwds() {
    let raw;
    try {
      raw = this.getCwds();
    } catch {
      throw fail("SKILL_LIST_FAILED");
    }
    if (!Array.isArray(raw)) return [];
    const cwds = [];
    for (const cwd of raw) {
      if (typeof cwd === "string" && path.isAbsolute(cwd) && !cwds.includes(cwd)) cwds.push(cwd);
    }
    return cwds;
  }

  async _rpc(engine, method, params) {
    if (this.getEngine() !== engine) throw fail("STALE_ENGINE");
    try {
      const result = await engine.client.request(method, params);
      if (this.getEngine() !== engine) throw fail("STALE_ENGINE");
      return result;
    } catch (error) {
      if (error && error.code === "STALE_ENGINE") throw error;
      throw fail("RPC_FAILED");
    }
  }

  async _setError(name, code) {
    await this._enqueue(() => {
      this._readIfNeeded();
      const entry = this.state.mcpServers[name];
      if (!entry) return;
      const previous = entry.error;
      entry.error = code;
      try {
        this._writeState();
      } catch (error) {
        entry.error = previous;
        throw error;
      }
    });
  }

  _replaceServer(name, entry) {
    const had = Object.prototype.hasOwnProperty.call(this.state.mcpServers, name);
    const previous = had ? cloneEntry(this.state.mcpServers[name]) : null;
    if (entry) this.state.mcpServers[name] = entry;
    else delete this.state.mcpServers[name];
    return () => {
      if (had) this.state.mcpServers[name] = previous;
      else delete this.state.mcpServers[name];
    };
  }

  _enqueue(work) {
    const run = this.writeChain.then(work, work);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  _statePath() {
    return path.join(this.dataDir, STATE_FILE);
  }

  _readIfNeeded() {
    if (!this.loaded) this._readStateForce();
  }

  _readStateForce() {
    let raw;
    try {
      raw = fs.readFileSync(this._statePath(), "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.state = emptyState();
        this.loaded = true;
        return;
      }
      throw fail("STATE_READ_FAILED");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw fail("STATE_CORRUPT");
    }
    const next = normalizeState(parsed);
    this.state = next;
    this.loaded = true;
  }

  _writeState() {
    const destination = this._statePath();
    const temporary = path.join(this.dataDir, `.integrations.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`);
    let fd;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dataDir, 0o700);
      fd = fs.openSync(temporary, "w", 0o600);
      fs.writeSync(fd, serializeState(this.state));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
    } catch {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // The original file is left in place.
        }
      }
      try {
        fs.unlinkSync(temporary);
      } catch {
        // A failed temp file is removed when it exists.
      }
      throw fail("STATE_WRITE_FAILED");
    }
  }
}
