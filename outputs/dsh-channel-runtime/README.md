# DSH messaging runtime

This directory is the authoritative source for the five bundled DSH messaging plugins. `dsh-codex-client/scripts/build.mjs` copies it to the app's `channel-runtime/`. Edit this directory, not the generated app copy.

## Provenance and license

`vendor/hermes/` contains 21 unchanged files (including the MIT license) from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) at commit `dde8800ed91c6e128064a17d5db914d74622594b`. `UPSTREAM.json` records each SHA-256; the package verifier checks every file. Copyright and permission terms are retained in `vendor/hermes/LICENSE`. Dependency distributions retain their own licenses in `packages/`.

The Feishu, QQ, WeChat, DingTalk and WeCom adapters, message types, splitting helpers, media MIME helpers and URL safety implementation are reused directly. DSH's `compat/` supplies the small interface the adapters need; it does not load Hermes's agent, tools, user configuration, sessions, approvals, plugin manager or updater. Changes to delivery and admission policy are explicit in `bridge.py`, `compat/ingress.py`, and `compat/media_policy.py`, and `compat/enterprise.py`; upstream files remain unchanged.

## Runtime and isolation

The macOS arm64 package includes a relocatable CPython 3.12.14 distribution and hash-pinned dependencies from `requirements.lock`. No system Python or existing Hermes installation is required. Each enabled platform runs in its own Python process using `-I -B`. Its home is DSH's independent `channels/accounts/<platform>` directory. Startup credentials cross a private pipe; public API snapshots omit secrets and tokens. State files use owner-only permissions; credentials are not encrypted at rest.

`bridge.py` accepts bounded JSON lines on stdin and writes JSON lines on stdout. Vendor logs are suppressed, and stderr is drained without persistence. DSH inherits the current proxy environment and never changes system routes.

## Delivery contract

- Feishu, QQ, DingTalk and WeCom websocket callbacks commit their raw envelopes to a private SQLite transport journal before returning. The journal is replayed after a process restart.
- WeChat long polling advances the persisted cursor only after every message has been admitted to DSH, or permanently invalid media has been quarantined.
- DSH commits an inbox record before admitting execution. Platform + account scope + chat + topic + sender define a separate native DSH conversation. Sender isolation also applies within groups.
- Native DSH `TaskRecovery` owns execution and resumption. A checkpoint is recorded before starting the native turn. Unknown execution outcomes do not trigger blind prompt replay.
- Replies enter a separate outbox. Only the matching turn's final assistant text is sent. Reasoning and tool transcripts are excluded. Reply chunks are ordered within each conversation.
- Transient disconnection uses bounded backoff. An explicit “not sent” result may retry; ambiguous delivery waits for user reconciliation. A send already in progress during a host crash becomes unknown on restart. Platform text retries after ambiguous errors are disabled. Explicit platform rejection fallbacks remain upstream behavior.
- Platform policies, offline retention and upstream API acknowledgments limit delivery guarantees. This integration does not claim end-to-end exactly-once delivery.

## Enterprise long-task delivery

DingTalk session webhooks and WeCom group reply IDs are stored privately in the transport journal and survive restart. Expired or missing reply credentials leave the outbox pending; a new inbound message (for example `/status`) refreshes them without rerunning the completed task. DingTalk HTTP 200 responses still require `errcode=0`. WeCom passive timeouts never trigger proactive fallback. Direct WeCom replies use its proactive send API. Per-chat rate limits return to the durable outbox, with no delayed SDK worker left to send after cancellation. A WeCom duplicate-connection kick disables automatic reconnect until the operator resolves the competing instance.

DingTalk retains the official Stream SDK parser, routing and ACK serialization. Its blocking, cancellation-swallowing transport loop is replaced by time-bounded async HTTP/WebSocket operations. Raw messages commit before ACK, and connected status is reported only after the socket opens. The upstream Python files remain unchanged.

## Supported surface

Feishu bot websocket, official QQ bot websocket, WeChat iLink QR login, DingTalk Stream bots, and WeCom Smart Robot WebSocket. WeCom self-built app HTTP callbacks are outside this release. One account per platform in this release. Explicit user allowlists, with a local first-contact approval flow when no allowed user is configured; Feishu/QQ/DingTalk/WeCom groups additionally require allowed group IDs. WeChat ordinary groups are not supported by this release. Expired WeChat authorization is reported as requiring QR sign-in and stops automatic credential retries; a new scan is required. Feishu and DingTalk group messages require an @mention. Feishu IDs use `open_id`; QQ uses bot-scoped `user_openid` / group member IDs, not ordinary QQ numbers. Feishu, QQ and WeChat support QR onboarding and can populate the authorizing user ID. DingTalk and WeCom use guided manual configuration. Chats may use a private workspace without selecting a project.

Text, images and UTF-8 text attachments can enter tasks. QQ and DingTalk native ASR text is accepted if present; no external speech service is started. Other media are rejected or isolated. No model-generated local file path is automatically uploaded. Outbound attachments, streaming edits, reaction/card actions, meeting/drive events and remote approvals are outside this first release. Approvals remain in DSH.

Limits: 2 MiB transport lines, 32 pending pipe requests, 2,000 unresolved inbox rows, 2,000 transport queue rows, 2,000 quarantined envelopes, eight attachments and 10 MiB admitted bytes per message, 500 MiB / 2,000 cached media files per platform. Media reads for QQ, WeChat, DingTalk and WeCom are bounded before full buffering. Feishu uses the upstream SDK's resource reader before the admission size check. Completed delivery records are pruned after 30 days; unresolved records are retained. Cached media are retained for chat history and need manual cleanup at the cache limit; pending-task files must be retained.

The runtime tests use real upstream adapter classes, actual bundled Python and SDKs, and controlled transports. They never send messages to real accounts. Real account credentials, app scopes/event subscriptions, WeChat QR authorization and a multi-day live run remain operator acceptance steps.

## Verification

From the workspace root:

```sh
outputs/dsh-channel-runtime/python/runtime/bin/python3 -I -B outputs/dsh-channel-runtime/tests/test_adapters.py
node --test outputs/dsh-codex-client/test/channels.test.mjs
```

Build and package through the client scripts. Package verification additionally imports all five adapters using the packaged interpreter and verifies upstream hashes.
