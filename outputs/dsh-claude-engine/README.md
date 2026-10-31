# DSH Claude Code engine

An optional execution engine for the separate DSH client. The resident host loads it through Cordis and uses the same normalized chat interface as the Codex engine. This adapter runs **DeepSeek V4.1 Flash** through the existing **OpenCode Go** Anthropic route. It does not use a Claude subscription, a GPT model, or the user's existing Claude login.

## Runtime

- Exact dependency: `@anthropic-ai/claude-agent-sdk@0.3.309`.
- Verified installed native CLI: Claude Code `2.1.295` at `/Users/william/.local/bin/claude`.
- `options.claudeBinary` or `options.binary` selects a native executable. The CLI is an installed dependency; this source package does not redistribute or modify it.
- `CLAUDE_CONFIG_DIR` is a private directory under the supplied `dataDir`.
- The child environment is built from a small core allowlist, then sets `ANTHROPIC_AUTH_TOKEN`, the Go base URL, and all model aliases to the selected DeepSeek model. SDK 0.3.309 copies this environment as a replacement, rather than merging the parent environment.
- Native `--restricted`, `strictMcpConfig:true`, `mcpServers:{}`, `plugins:[]`, and `settingSources:[]` prevent project/user settings, implicit MCP processes and code-running tools from entering the runtime. Managed platform requirements still apply.

API keys are resolved by the host callback and supplied only to the owned child environment. Stderr is buffered by line before redaction, including split tokens. Neither keys nor fallback credentials are written to the session state.

## API

```js
import { ClaudeCodeEngine } from './lib/engine.js';
const engine = new ClaudeCodeEngine({
  dataDir: '/absolute/private/dsh/claude-engine',
  resolveApiKey: resolveExistingGoKey,
  model: 'deepseek-v4.1-flash',
  claudeBinary: '/absolute/path/to/claude',
});
await engine.start();
await engine.createSession('local-chat-id', { cwd: '/absolute/project' });
await engine.startTurn('local-chat-id', 'Inspect this project', {
  sandbox: 'read-only', effort: 'high',
});
```

The public class is an `EventEmitter`. Supported methods include `start`, `ensureStarted`, `createSession`, `resumeSession`, `startTurn`, `readSession`, `listSessions`, `interrupt`, `setModel`, `renameSession`, `archiveSession`, `restoreSession`, `queueRequest`, `respondApproval`, and `dispose`. `activeTurns` contains public turn/thread IDs; it clears after the SDK loop ends.

SDK messages are normalized to `turn/started`, `turn/completed`, `item/started`, `item/completed`, and `item/agentMessage/delta`. File tools become file-change or tool-operation cards. `readSession()` returns actual observed normalized turns. Native conversation continuation uses the saved SDK session UUID through `resume`; the adapter does not reconstruct the model conversation by replaying the UI transcript.

Writes in `workspace-write` mode use `approval-required` with the same `{id,method,params}` envelope as the Codex adapter. `respondApproval(id,{decision:'accept'})` approves one operation. `autoApproveWorkspaceWrites:true` is an explicit host option for project-scoped writes; it does not widen the native restricted boundary. `read-only` always denies edits. All paths are canonicalized before permission evaluation, including existing symlink parents. Native restricted file tools add a second boundary for recursive search.

`queueRequest(id, action, params)` supports `add/list/update/delete/reorder/start`, using the Codex queue field names and response shapes. Queues are atomic local state, not a claimed Claude server queue. A successful turn automatically dispatches the next queued input. Failed or interrupted work leaves pending inputs for explicit recovery. Durable claim IDs prevent concurrent starts and restart recovery from replaying an already-recorded submission.

## Explicit limits

- No active-turn steering. `steer()` throws `UNSUPPORTED_STEER`.
- No arbitrary Bash/PowerShell/code execution, agent subthreads, image attachments, MCP configuration, or skills management.
- No full-system permission mode, cross-project move, or fork. These operations return explicit unsupported errors.
- Queue metadata and UI history are local adapter state; model history remains native Claude Code state.
- Long tasks have no adapter-imposed total duration or model-turn limit by default. `idleTimeoutMs` (legacy alias: `requestTimeoutMs`) defaults to 300 seconds without an SDK message; observed progress resets it. Hosts can explicitly set `turnTimeoutMs` and `maxTurns`. An idle timeout is reported as `IDLE_TIMEOUT`; an explicit total deadline as `TIMEOUT`.
- Partial output is checkpointed at most once per `checkpointIntervalMs` (default 1 second), plus turn start/init/completion. `readTurnState(sessionId, turnId)` exposes exact recorded status and error. The new `turn-completed` event also exposes `turnId`, `status`, and `error`.
- `interruptTimeoutMs` defaults to 5 seconds. A lost control receipt cannot delay `close()`. If the SDK iterator still has not ended, `INTERRUPT_TIMEOUT` leaves that turn active and blocks another start. Disposal waits up to `shutdownTimeoutMs` (default 5 seconds), then quarantines an uncooperative iterator and saves an interrupted checkpoint; late messages and tool approvals are ignored.
- This is an optional adapter with a deliberately narrower tool surface than the Codex engine. The host must use its `capabilities` when presenting actions.

## Verification

`npm test`: **20 passing tests** for streaming reconciliation, native-session resume parameters, mandatory path checks, actual approval callbacks, interruption, durable queue operations, split-secret redaction, teardown races, concurrent queue claims, automatic dispatch and crash recovery. A fixture from the owned DeepSeek host probe covers Claude Code's single-block assistant envelopes: thinking is API block 0, text is API block 1 even though each envelope's content array starts at zero. Stream and snapshot identities merge within the API message; identical text in distinct messages/blocks is retained. Result text completes missing snapshots without appending duplicate replies.

Live OpenCode Go check on 2026-10-23 at 23:57 Beijing time: **four real DeepSeek user turns passed**. The engine replied without tools, resumed the same UUID after teardown, wrote/read a proof file using native tools and one actual approval, then attempted a read-only write that was blocked without creating the file. Original Go credential metadata was unchanged.

The four Go turns ran before the additional `restricted` / strict-MCP flags were added. After that hardening, at 00:04 on 2026-10-24 Beijing time, a separate **real native CLI with a deterministic localhost mock model** passed: recursive Grep and Glob did not traverse a nested external symlink; explicit external read/write attempts were denied; a legitimate file write succeeded through approval; malicious project MCP and SessionStart-hook marker files were not created. Init reported exactly five file tools and zero MCP servers. The probe was repeated after the block-index fix with a thinking block followed by a text block, yielding exactly one final reply. Each probe used six localhost model responses and made no paid inference requests; it is not a DeepSeek quality benchmark. A packaged-host Go turn remains a separate integration check.

Primary references: [Anthropic permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [OpenCode Claude Code/Go routing](https://opencode.ai/v2/docs/console/harnesses/claude-code/), installed SDK types/implementation, and the installed CLI's `--help`.
