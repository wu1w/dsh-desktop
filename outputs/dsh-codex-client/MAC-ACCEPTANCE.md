# Mac native acceptance — 2026-11-02, input follow-up 2026-11-03

Base: `4a3a507ea3f3a2d22840145edd02207284750d29`, cloned into a new isolated checkout. Device: macOS 27.2 (26B123), Apple Silicon arm64; Swift 6.4.2; task-local Node 24.16.0; Electron 45.0.0, embedded Node 24.22.0 / ABI 150; pinned CPython 3.12.14. The official Node archive SHA-256 was verified before extraction. No previous checkout, installed application, existing client profile or account configuration was modified.

## Fixes and findings

- The Windows-authored Swift focus changes did not compile on the Mac SDK: `kAXSheetsAttribute` is not defined. Discover sheets through AXChildren/AXSheet instead. Use AXTopLevelUIElement to distinguish a focused sheet from its parent window; reject changed focus before raising the observed window, recheck after activation, and reject disabled element actions. Swift builds successfully. The scoped native Accessibility acceptance below subsequently passed after the user granted permission.
- A captured command whose supervisor had already exited still waited the full termination grace period when a detached descendant held stdout open. POSIX stop now waits only the remaining pipe-close confirmation budget in that case (Windows timing is unchanged), retaining the retry handle and explicit failure if closure is not confirmed. The real escaped-pipe regression passes without relaxing its deadline.
- Add native tests for private IPC disconnection and actual owner SIGKILL, checking both owned process disappearance and survival of an unrelated fixture session. No delayed numeric PID/PGID stop fallback or process scanning was added.
- Several native/mock-engine tests supplied a fake engine key but let the host's provider preflight use machine credentials. Explicit fake host credential resolvers now isolate these fixtures, including approval, MCP, large SSE, stream recovery and projectless chat. Missing-key product protection and assertions remain intact; official missing-key/preflight tests are separate.
- Both native helpers now compile in private staging directories with stable executable basenames. Previously the PID/temporary suffix became the linker-generated signing identifier. A native regression compiles each helper twice and verifies stable identifiers and the host architecture. This is local ad-hoc/linker signing, not a distribution signature or a guarantee of TCC trust across different builds.
- The Mac package gate now runs a real captured-command/timeout probe using the packaged Electron runtime and its private IPC supervisor, in addition to the existing real PTY and runtime probes.

## Native results

Final client regression: **1,134 tests; 1,130 passed, 0 failed, 0 cancelled, 4 Windows-only skips**, exit 0, 437.4 seconds. Skips are one Windows path-policy test and three native Windows ConPTY/Job tests. Every test file ran; no Mac failure was skipped. The final invocation uses four test-file workers and the tests' own deadlines. An initial unbuilt/sandboxed run could not load generated engine copies or bind loopback servers and is not an acceptance pass. An intermediate native run had 1,116 passes, 10 failures, 2 cancellations and 4 skips: credential-isolation fixtures accounted for 10 failures, while an externally imposed 60-second test deadline cancelled two long Git workflows. The final run does not impose that additional deadline; assertions and test-defined deadlines are unchanged. A subsequent run loaded an older projectless-chat fixture before its edit (7 failures; isolated corrected suite 9/9). Another run overlapped generation of `channel-runtime` with Python startup (2 failures: CHANNEL_RUNTIME_FAILED / CHANNEL_RUNTIME_MISSING; corrected isolated channel suite 28/28). The final acceptance run starts only after build and package completion, with no concurrent runtime copy.

- Codex engine: 68/68; native engine: 14/14; Claude engine: 27/27.
- Python adapters: 31/31 using pinned CPython and real local mock transports; no resource warning in the final log.
- Initial Mac PTY / POSIX lifetime / runtime-lock focus: 15/15; subsequent IPC-loss/host-death lifetime suite: 4/4; terminal-stop suite: 7/7.
- Local authenticated HTTP/MCP/SSE fixtures: 41/41, including an actual 65-second disconnect, 45-second silent-socket watchdog, cancellation and recovery without replay. No real provider key or paid model request was used.
- Runtime installation: real separate writers publish consistent Python/packages pairs, rollback and canonical alias exclusion pass, live/dead/malformed/replaced lock ownership is handled without stealing another writer's lease.
- Python relocation: all 10 source-runtime symlinks resolve inside the staged runtime; packaged runtime paths are materialized and valid. Packaged Python imports all five channel adapters and verifies 21 upstream file hashes.
- Real PTY: immediate input, split UTF-8, Ctrl-C recovery, resize, bounded stop, foreground/background cleanup, helper death, host death, final large output and plugin disposal.
- POSIX captured commands: natural exit, timeout, cancellation/stop, background children with redirected stdio, IPC loss and parent death. A child that deliberately starts a new session with redirected stdio remains outside process-group containment: `cleanup.verified=false`, scope `process-group`, reason `detached_descendants_unverified` remains deliberate and is asserted. This is not Windows Job containment.
- Full build and ARM64 package gate pass. The package verifies 117 resources, Codex/Claude architecture-specific CLI discovery, native engine startup, Swift/C helpers, Python and real PTY/command execution under Electron.
- Final packaged GUI starts in an isolated Chinese/spaced profile, displays the official DeepSeek model and missing-key protection, then exits through the production close handshake with exit code 0. This was repeated after the final rebuild. No install into `/Applications`, release upload, signing or notarization was performed.

## Authorized native input acceptance — 2026-11-03

The user granted Accessibility in System Settings and explicitly requested testing. The same previously built DSH.app was used, with no rebuild, re-sign, TCC modification or alternative input implementation. The packaged production runtime returned `accessibility=true`, `screenRecording=true` before any input. The app is `outputs/DSH-desktop/DSH-darwin-arm64/DSH.app`, bundle ID `com.deepseek.dsh.codex`; its helper is `Contents/Resources/app/native/bin/dsh-computer-helper`, stable identifier `dsh-computer-helper`, unchanged CDHash `3f7f5b653853dc49db758a1aad65f6f2587ae6d3`.

All **9 native acceptance steps passed** against a newly created AppKit fixture's target, decoy and modal windows:

| Step | Observed result |
| --- | --- |
| Physical mouse click | The fixture counter increments exactly once |
| AX text input | The target receives `safe fixture 中文` |
| Physical keyboard input | The target receives the additional `a` |
| Same-app window switch | `COMPUTER_FOCUS_CHANGED`; both fields unchanged |
| Consumed observation replay | `COMPUTER_OBSERVATION_STALE` |
| Window geometry change | `COMPUTER_OBSERVATION_STALE`; target text unchanged |
| Modal sheet blocks parent input | `COMPUTER_FOCUS_CHANGED`; target text unchanged |
| Disabled text field | `COMPUTER_ACTION_UNAVAILABLE`; target text unchanged |
| Fresh observation after restoring target | The target receives `safe recovered`; decoy stays `DECOY_UNCHANGED` |

The fixture was closed through stdin EOF and the test DSH application exited normally with code 0. A read-only exact-path process check found no remaining acceptance fixture, test DSH or packaged helper processes. No user application received input. No product changes were needed, so the earlier complete code regression remains applicable; this follow-up changes only the acceptance record and fixture evidence. Machine-readable results are in [validation/mac-focus-20261103.json](validation/mac-focus-20261103.json). The task-local harness/source and raw logs remain in sibling `mac-focus/` and `logs/` directories.

This resolves the earlier Accessibility blocker for these scoped cases. It does not certify every third-party application, protected-field behavior, screenshot fidelity across displays, every focus race or permission persistence after future binary changes.

## Remaining boundaries

Intel/x64 Mac hardware, mixed-display behavior, production provider credentials/billing, clean-machine installation, distribution signing and notarization were not tested. Windows native file-symlink privilege failures remain as recorded in `WINDOWS-ACCEPTANCE.md`; Mac filesystem success does not resolve that account policy. These changes require subsequent Windows native regression before a new Windows release.

## Reproduction and local evidence

From a fresh checkout install all four package lockfiles, prepare channels, then run the build as documented in the root README. Where the execution sandbox denies the compiler's default cache, set `CLANG_MODULE_CACHE_PATH` and `SWIFT_MODULECACHE_PATH` to a writable task-local cache. Native HTTP tests require loopback listen permission.

```sh
node --test --test-concurrency=4 outputs/dsh-codex-client/test/*.test.mjs
npm test --prefix outputs/dsh-codex-engine
npm test --prefix outputs/dsh-native-engine
npm test --prefix outputs/dsh-claude-engine
outputs/dsh-channel-runtime/python/runtime/bin/python3 -I -B outputs/dsh-channel-runtime/tests/test_adapters.py
npm run build --prefix outputs/dsh-codex-client
npm run package --prefix outputs/dsh-codex-client
```

Task-local evidence is retained outside Git in the sibling `logs/` directory: `client-stable-final.log` and engine/Python logs, package/build logs, source/package relocation audit, packaged permission status, GUI screenshot and normal-exit result. The package verification manifest is `outputs/DSH-desktop/package-verification-darwin-arm64.json`. All 116 non-manifest packaged resource hashes match the final source/build output. The package manifest intentionally omits development dependencies; name, version and production dependencies are compared separately. No local profile, screenshot, dependency tree or app binary is committed.

The previous Mac checkout lacked Git HTTPS authentication; its code commit `51d3bd94da168298dc5963f8aa09b1ce7dd51837` was subsequently published by the authorized release task. This input follow-up does not rebuild the published code or claim a new CI run. No chat token was read or reused.
