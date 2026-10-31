# DSH Codex 引擎基础

这是给独立 DSH 用的 Codex App Server 引擎基础，不是完整客户端。它不会画出 Codex 界面，也不会声称已经具备 Codex 的全部功能。

当前只做三件事：

1. 用 JSON Lines 拉起并管理一个 Codex App Server 子进程。
2. 把一个 DSH `sessionId` 固定映射到一条持久 `threadId`。
3. 用 Cordis 插件把这个引擎注册成名为 `codexEngine` 的 Service。

父进程已经用安装好的 CLI `0.163.0-alpha.11.2` 验证过独立 `CODEX_HOME`、Responses 端点 `https://opencode.ai/inference/go/openai/v1` 和模型 `deepseek-v4.1-flash` 的真实执行与跨进程续聊。本包通过调用方提供的密钥回调执行真实推理，不自行读取凭据文件。独立客户端已经接入并完成真实 GUI 验证。

## 依赖

- 运行时只有 Node.js 自带模块。核心不导入 Cordis。
- Cordis 是可选 peer。只有 `lib/plugin.js` 导入它。
- Codex CLI 不打包。调用方传入 `binary`。开发机可以指向已安装的 `0.163.0-alpha.11.2`，本包不修改原版 Codex 应用或 `~/.codex`。

## 隔离与提供方

- `CODEX_HOME` 固定为 `<dataDir>/codex`。`dataDir` 落在 `~/.codex` 里面会直接拒绝。
- 子进程环境从调用方环境复制，但删除 `OPENAI_API_KEY`、`CODEX_API_KEY`、`OPENAI_BASE_URL`，再写入隔离的 `CODEX_HOME`。
- 提供方 id 是 `opencode_go`。密钥只来自 `resolveApiKey()` 或环境变量 `DSH_OPENCODE_GO_KEY`，不进参数、不进 `config.toml`、不进状态对象。
- `config.toml` 写 `wire_api = "responses"`、`requires_openai_auth = false`、`supports_websockets = false`、`features.code_mode = false`、`tools.web_search = false`。
- 线程参数使用协议字段：`model`、`modelProvider`、`allowProviderModelFallback: false`、`approvalPolicy: "on-request"`、`sandbox`。
- 默认模型 `deepseek-v4.1-flash`。默认沙箱 `read-only`。测试可以显式改成 `workspace-write`。`danger-full-access` 仅在客户端明确选择并确认后传入原生引擎。
- 没有密钥、返回了别的 provider/model、或出现 `model/rerouted` 时，不会改绑到 GPT，也不会改用用户原来的 Codex home。

## 引擎方法

`CodexEngine` / `createEngine(options)`：

| 方法 | 行为 |
|---|---|
| `start()` | 写隔离配置，启动子进程，完成 `initialize` / `initialized` |
| `createSession(sessionId, { cwd })` | `thread/start`。成功后才原子写入映射 |
| `resumeSession(sessionId)` | 只对已有映射调用 `thread/resume`。不传 `history` 或 `path`，`excludeTurns: true` |
| `startTurn(sessionId, text \| { text })` | `turn/start`。同一会话已有进行中回合则拒绝 |
| `interrupt(sessionId)` | `turn/interrupt` |
| `steer(sessionId, text \| { text })` | 只在有活动回合时 `turn/steer` |
| `readSession(sessionId, {includeTurns=false})` | 未连接时读本地映射；已连接时再 `thread/read`。完整历史旧接口仍保留，聊天界面应改用分页 |
| `listSessionItems(sessionId, {cursor,limit=20,sortDirection='desc'})` | 返回 `{data:[{turnId,item,startedAtMs,completedAtMs}],nextCursor,backwardsCursor}` |
| `listSessionTurns(sessionId, {cursor,limit=10,sortDirection='desc',itemsView='notLoaded'})` | 原生 `thread/turns/list`，返回 `{data:Turn[],nextCursor,backwardsCursor}` |
| `listSessions()` | 只返回本引擎写入的映射，不导入别人的线程 |
| `archiveSession(sessionId)` | `thread/archive`，成功后才标记归档 |
| `renameSession(sessionId, name)` | `thread/name/set`，成功后才改名 |
| `forkSession(sessionId, newSessionId)` | `thread/fork(excludeTurns:true)`，成功后才增加新映射 |
| `respondApproval(requestId, result)` | 把调用方的决定写回对应的服务端请求 |
| `status()` | 只读快照。不含环境变量和密钥 |
| `dispose()` | 先尝试打断本引擎的活动回合，再停掉自己的子进程 |

映射文件是 `<dataDir>/sessions.json`，字段至少包括 `sessionId`、`threadId`、`cwd`、`model`、`provider`。写入用临时文件再 `rename`。RPC 失败不会改映射。

状态通过 getter 读取：`ready`、`state`、`codexHome`、`activeTurns`。回合通知走 EventEmitter：`turn-started`、`turn-completed`，另外还有 `notification`、`approval-required`、`stderr`、`protocol-error`、`exit`、`provider-diverged`。

同一会话的创建、恢复、回合、打断、归档、改名、分叉串行执行。只有收到实际 `turn/completed` 才释放进行中的回合；中断请求的 ACK 不代表工具已停止。

## 历史分页

两个分页方法都先验证本包已有的 session 映射，原生 threadId 由映射取得；不接受调用方传入外部 threadId。首次读取会用现有 `resumeSession` 做 metadata-only 恢复，从而建立原生历史投影，保留已固定的模型、provider 和指令 profile。没有新增模型推理，也不改变线程的 `historyMode`。

分页参数仅接受文档列出的字段。limit 必须为 1–50 的整数，方向为 asc/desc；cursor 为服务端返回的非空字符串或 null。turns 的 itemsView 为 notLoaded/summary/full。缺省方向都是 desc，因此首屏是最新记录；客户端按页反序显示。nextCursor 沿相同方向继续，backwardsCursor 配合相反方向会包含 anchor，用 turnId/item.id 合并。

固定 CLI `0.163.0-alpha.11.2` 的 paginated 线程支持原生 `thread/items/list`；legacy 线程会返回 -32601。本包只针对这个明确的“不支持”结果使用原生 `thread/turns/list(limit:1,itemsView:'full')` 适配消息窗口，不读取原生文件，不把整个聊天读回后切片。legacy 游标带版本、线程身份、方向和原生 turn/item anchor；调用方仍将它当 opaque 字符串，不能修改。legacy 没有逐项时间记录时返回 null，不用回合时间假冒 item 时间。

每个 legacy 页最多扫描 100 个回合；若都是空回合，可返回空 data 和非空 nextCursor，客户端应以 nextCursor 是否为 null 判断结束。单个完整回合仍超过 1 MiB 时明确返回 `LINE_TOO_LONG`，不声称已能显示该回合；历史改变导致 anchor 消失时返回 `HISTORY_CURSOR_STALE`。其他原生 RPC 错误原样失败，不会隐藏在兼容回退里。

本包不自动把所有页读完。客户端应仅取当前窗口，在用户请求更早记录时沿 cursor 继续；完整历史旧接口仍可能超出上限。

零推理实测：固定 CLI 的 legacy 与 paginated 各 240 回合、480 items，原始种子分别约 48.4 MB 与 24.7 MB。两种格式各 24 页完整读取通过，首个 20 items 约 988 KB；legacy 首页 210.9ms，paginated 3.07ms。正反顺序、同一回合内续页、反向 anchor、原线程/模型/provider 恢复均通过，provider 请求和模型推理均为 0。证据为工作区 `work/dsh-native-history-probe.result.json`；这是后端和原生协议证据，不替代锁屏后尚未进行的 GUI 验收。

## 审批

服务端请求里，这些方法会转给 `approval-required` 监听器或 `approvalHandler`：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`
- `item/permissions/requestApproval`
- `item/tool/call`
- `mcpServer/elicitation/request`
- `applyPatchApproval`
- `execCommandApproval`

没有调用方时，命令和文件变更回 `decline`，补丁和旧版命令审批回 `denied`，MCP elicitation 回 `decline`，动态工具回 `success: false`。用户输入和权限提升没有安全的“拒绝”结果体，回 JSON-RPC `-32001`。不认识的方法回 `-32601`。这里没有自动批准。

子进程 stderr 在发出事件前会抹掉密钥值和 `sk-` 形式的令牌，并截断长度。状态和日志不输出子进程环境。

审批结算、过期、退出或插件卸载会发 `approval-resolved`，仅含请求ID与原因。收到原生 `serverRequest/resolved` 也清理等待令牌；迟到的处理器不能回复复用的原生ID。旧式拒绝使用原生结构化 `denied` 对象。

## 超大通知后的终态重核

超出JSON Lines上限可能丢失完成通知。`turn-reconciler` 对本引擎已有映射、当前活动Turn做有界只读metadata与`notLoaded`分页查询；只有实际原生状态为completed/failed/interrupted才释放，并发出`reconciled:true`、items未加载的精简终态。不伪造丢失内容，不重放模型或队列。每批8秒、每RPC1.5秒、两worker，3次各最多3页；无有效进度最多两批。原生状态未知仍保持active，并发诊断给宿主显示恢复提示。

当前核心55项回归通过，含12项终态/审批专项。另对固定真实CLI注入超限帧与遗留active状态后做实际原生状态查询，38.26ms/364bytes、provider请求0、原始种子未改；这属于故障注入与原生协议验证，不冒充真实模型生成超大通知的端到端成绩。单个巨型历史项的1MiB边界仍存在。证据在工作区 `work/dsh-turn-reconciliation-validation.md`。

## Cordis

```js
import apply from "@dsh/codex-engine/plugin";

await ctx.plugin(apply, config);
```

插件把 `CodexEngineService` 注册为 `codexEngine`。卸载走 `ctx.effect()`：取消等待中的审批、尝试打断自己的回合、然后只停止自己拉起的子进程。热重载不应留下这个插件注册的 RPC handler、监听器或子进程。

独立客户端 `../dsh-codex-client` 已通过此 Service 接入持久对话、审批和真实事件适配。核心包仍不负责画界面。

独立入口是 `lib/standalone.js` 的 `createEngine` / `describeEngine`。没有界面，也没有单独的交互壳。

## 用户可见文案

`locale/zh-CN.json` 和 `locale/en.json`。引擎抛出的 `EngineError.message` 来自翻译键，缺译时回退到 `en`，再不行就留下键名。诊断用的 `error.code` 和协议方法名保持原样。时间标签按 `zh-CN` 或 `en` 格式化。

## 明确没做

- 本核心包不提供前端或独立桌面壳；独立客户端另在上一级 dsh-codex-client，已经接入会话和队列
- 语音、内置浏览器、远程连接、云任务、账号登录、MCP 安装与市场
- 文件系统 RPC、实时语音线程、自动导入 `thread/list` 里不属于本映射的线程
- 本包的自动化回归使用假的 App Server 子进程；真实 Go/Flash 推理与零推理原生历史测试另有实际运行记录，不把两者混作同一项成绩

协议里其余上百个方法不会被伪装成已经成功。需要时再按同一条 RPC 客户端加，失败就保持失败。

## 测试

```sh
node --test
```

测试覆盖握手、协议错误、超时、取消、未知请求拒绝、审批转发、映射恢复、并发回合拒绝、子进程崩溃、插件卸载、密钥抹除和 `CODEX_HOME` 隔离。

## 后续接入

原生队列通过 `queueRequest(sessionId, action, params)` 使用 `thread/queue/{add,list,update,delete,reorder,start}`，不是在前端伪造排队。运行中引导使用预期活动Turn ID，失败消息由宿主耐久保留。新增 `moveSession` 绑定原生 cwd。

可选 `resolveInstructionProfile({model,locale})` 在新建时确定版本化指令，原文/id/version/hash保存在线程映射中；恢复与分叉沿用原配置，默认配置的升级或停用不重写旧聊天。DeepSeek Flash 真实档位为 low/high/max。模型目录仍需进一步核验，不承诺未实测的上下文上限。

测试：`npm test`。历史分页另有 native 0 推理证据；真实 Go/Flash 队列引导、max 档、热插拔、MCP/技能和桌面测试证据单独保存。核心回归使用隔离假服务，真实联调记录与之区分。


## 长期运行与恢复契约

- 原生网络恢复配置同时写入进程配置与新线程配置。默认 `request_max_retries=6`、`stream_max_retries=8`、`stream_idle_timeout_ms=300000`。调用方可通过 `networkRecovery: {requestMaxRetries, streamMaxRetries, streamIdleTimeoutMs}` 覆盖；这些是原生请求/流重试，不会在本适配器重发用户输入。
- `readTurnState` 的分页读取默认每次RPC最多1500ms、所有页合计最多8000ms，分别通过 `recoveryRequestTimeoutMs` 和 `recoveryReadTimeoutMs` 覆盖。该总预算在冷启动/线程resume完成后开始，不包含它们原有的生命周期；超时只使读请求失败，不停止健康引擎或正在执行的长任务。
- `readTurnState(sessionId, turnId?)` 只读最多五页原生 `notLoaded` 元数据，返回 `{sessionId,threadId,turnId,status,known,active,terminal,error,pendingOperation}`。只有匹配目标ID的原生状态可以认定终态；未查到返回 `known:false`。没有ACK也没有turn通知的start仍然未知，最新记录只能作为 `candidateTurnId`，不能自动当成本次提交。
- `startTurn`、队列start或interrupt的结果不确定时保留 `pendingOperation`，同一会话的重复派发被 `TURN_STATE_UNKNOWN` 拦截。interrupt ACK仍然不释放活动回合。原生进程退出保留已知turn ID供宿主恢复；引擎自身不自动重放输入。宿主必须持久记录任务状态与原生turn ID，以跨应用重启恢复。
- `turn-completed` 顶层提供 `error`，并保留 `turn.error`。完成事件去重默认最多保存4096个键，避免连续运行时无限增长。
- 新增故障测试覆盖丢start ACK、完全丢失start回执、interrupt ACK无完成、interrupt超时、原生进程退出、精确终态对账、错误脱敏、原生网络配置覆盖和长期事件去重上限。
