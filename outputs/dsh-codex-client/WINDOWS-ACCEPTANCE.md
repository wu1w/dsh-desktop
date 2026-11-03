# Windows device acceptance — 2026-11-02

Base: `d20300e9f037ccd6eafffe5d7076a65274092399`, Windows x64 build 26100, Node 24.16.0, Electron 45.0.0 / embedded Node 24.22.0 / ABI 150, pinned CPython 3.12.14 AMD64. This record includes the subsequent Windows and shared-platform fixes.

This is a partial acceptance record, not a clean-machine release certification. No paid inference, real model API key, existing provider-account login, application-data migration, signing or release publication was performed. Git uses the existing Windows credential manager; no token from chat history is reused.

## Fixes confirmed on this device

- Remove uv version aliases/junctions before relocating its Python distribution. The original fresh Windows build failed while copying a dangling junction and required symlink privileges. Only the relocatable `runtime` is shipped now.
- Wait for a per-launch PowerShell readiness marker before exposing a writable ConPTY. Immediate first input was otherwise lost while the Job supervisor compiled/launched the shell.
- Use Windows byte-range account locks (`msvcrt`) rather than importing POSIX-only `fcntl`. Test exclusion and release across real processes.
- Suppress PowerShell module-loading progress so CLIXML does not pollute command output or consume output limits.
- Verify the locked node-pty prebuild under the exact target Electron ABI with a real ConPTY before requiring source rebuild. Rebuild is still the fallback; the copied packaged app repeats all runtime checks. Probe success requires both exit 0 and an explicit success marker.
- Make engine crash-fixture paths and directory-alias tests portable; Windows directory junctions need no Developer Mode/admin symlink privilege.
- Run the Windows Python bridge through bounded thread-backed stdin reads; Windows anonymous pipes and signal registration cannot use the POSIX startup path. All five real adapter subprocesses now start and stop.
- Compile a native Job lease owner with the existing Windows .NET Framework compiler. Keep the lease alive on Ctrl-C; descendants remain contained after shell/host termination. Git uses the same owned Job path and aborts prepared update-ref transactions before OS escalation, releasing native HEAD/ref/index locks.
- Serialize Python/packages installation and build copies with a canonical-root cross-process lock. Concurrent writers, rollback, directory aliases, live/stale owners, malformed metadata and ownership loss are covered without stealing or deleting another writer's lock.
- Check full-width file identity before reading text or image bytes. Document recovery rejects symbolic links and hardlinks before reading/chmod and before persistence; this fixes a shared Mac/Windows gap.
- Use a data-only Windows ShellExecute launcher instead of cmd start. Preserve native OS environment fields, contain errors and test handoff/cancellation without launching real user applications.
- Inspect real NTFS ACLs rather than asserting POSIX mode bits. Controlled denied-write and metadata fixtures are labeled as mocks; native junction and hardlink tests are separate.

## Passed

The complete desktop suite is **not all green**: 1132 tests, **1088 passed / 25 failed / 19 skipped**. Every test file was run. Four POSIX-only FIFO checks were split out of mixed tests and are explicitly inapplicable on Windows; their directory/traversal/alias checks still run. One new native POSIX supervisor check awaits Mac. The other 14 skips predate this handoff. Remaining failures are classified below. The force-exit native-only worker checks real descendant cleanup before exit; HTTP workers run normally to avoid Node 24's Windows force-exit/libuv assertion. See `scripts/test-windows.mjs` and the ignored local `windows-handoff-final/summary.json`.

| Check | Evidence |
| --- | --- |
| Codex engine | 68 passed, 0 failed |
| Native engine | 14 passed, 0 failed; includes crash recovery after one committed write |
| Claude engine / CLI path resolver | 27 passed, 0 failed |
| Official onboarding and recovery focus suite | 54 passed, 0 failed; missing key blocks dispatch, official model/endpoint selection, typed upstream errors, stream/stop recovery |
| Latest Windows policy/packaging + loopback network regressions | 27 passed, 0 failed |
| Real Windows native terminal | 3 passed, 0 failed; Unicode, Chinese/spaces cwd, immediate input, resize, Ctrl-C/prompt recovery, bounded stop, background descendant cleanup, host-death cleanup |
| Electron native ABI probe | Exact Electron 45.0.0, embedded Node 24.22.0, modules ABI 150; real command returns `ELECTRON_ABI_PTY_OK` |
| Python adapters | 31 passed; includes real cross-process account-lock exclusion/release. The synchronous SDK-import test now closes its inactive fallback loop explicitly; final run has no ResourceWarning |
| NSIS packaging | Exit 0; 122 packaged resources checked; Python/21 upstream hashes, native engine, Codex/Claude binaries, C# helper and real ConPTY validated before NSIS |
| Isolated install / installed launch / uninstall | Installer and uninstaller exit 0 in a Chinese/spaces path; installed 122-resource/runtime verification passes; fresh GUI displays missing-key protection and the official model. Window close hides to tray by default; uninstaller then terminates that background test app (exit 1), so this is not a normal-quit assertion. Executable, shortcuts and uninstall registration removed; isolated client-data SHA-256 unchanged; existing DSH-Codex data retained |
| Desktop build | `npm run build --prefix outputs/dsh-codex-client` exits 0 |
| New-user desktop GUI | Visible app in a fresh Chinese/spaces HOME/AppData directory; Codex app-server connects; official DeepSeek-V4.1-Flash selected; missing-key hint and disabled Send; Manage models opens official-provider setup |
| C# computer helper | Add-Type/status succeeds, nativeReady=true; selected temporary fixture screenshot captured |
| Real loopback HTTP/SSE transport | No secrets: missing key never contacts upstream; 401 is typed without echoing upstream body; incomplete stream fails; cancellation closes upstream; subsequent request completes |

## Not passed / not established

- Remaining desktop failures: **21 leaf tests** cannot create native file symlinks (`EPERM`, current account has no file-symlink privilege); **4 parent failures** repeat failed subtests. All 25 remain reported as failures, not skipped or converted to passing mocks. Three additional symlink setup failures became visible after isolating FIFO setup. Assertions after a failed setup remain unexecuted, not counted as passed. Native directory junctions, native hardlinks, canonical alias CAS and controlled symlink-refusal metadata tests pass separately; they are complementary, not equivalent file-symlink acceptance. Developer Mode and system security permissions were not changed.
- Native computer input: the earlier Electron/OpenWith fixture was inconclusive and is superseded by the explicit native WinForms acceptance below. Production mouse click, UIA text value input, SendInput digit delivery, modal-window refusal and observation recovery now pass on the two self-created fixture windows. WGC capture coverage beyond the earlier selected-fixture screenshot remains unverified; the pending Windows-device capability label stays unchanged.
- No real DeepSeek payment/account/provider acceptance. Local mocks cannot establish actual provider availability or production billing behavior.
- Current installer: **393,819,534 bytes**, unsigned. The superseded compression was cancelled after the document hardlink defect was discovered; the rebuilt staged document source hash matches the fixed source. An early launch during extraction failed with `ERR_MODULE_NOT_FOUND` and is not counted as a pass; after installer exit 0, installed verification and fresh-profile GUI startup succeeded. This is not clean-machine, upgrade-from-existing-install, or signed-distribution acceptance.

## Mac review and remaining native boundary

- Shared runtime install locking, document hardlink refusal and pre-read identity checks apply on Mac too. Windows exercises real cross-process locking and alias cases; this does not establish Mac filesystem behavior or relocated Python symlink validity.
- Swift input now checks AXRaise, the actual focused window identity, sheets, focused-element ancestry, geometry after activation and pointer hit-testing before mutation. Swift compilation, AX permissions and actual focus/input behavior require a Mac; none is claimed from Windows source review.
- Mac packaged verification now includes a real PTY probe with immediate UTF-8 input and completion/cleanup checks. No Mac input-loss defect was established. Mac PTY/Ctrl-C, arm64/x64 package startup and native module ABI still need Mac hardware.
- POSIX captured commands and Git now run under a detached Node supervisor with a private, non-inherited IPC channel and per-launch token. Only the still-live supervisor signals its own process group; it remains alive through TERM until its own final KILL. The parent never sends a delayed signal to a retained numeric PID/PGID, including after exit, disconnect, or retry. Windows cross-platform IPC/token/late-exit tests pass; native process-group cleanup, host-death behavior and packaged Electron execution still require Mac validation. POSIX command results retain `cleanup.verified=false`, scope `process-group`, reason `detached_descendants_unverified`: a child creating a new session can still escape. No process scanning was added. Run `node --test test/posix-command-lifetime.test.mjs test/project-commands.test.mjs test/terminal-stop.test.mjs test/git-stop.test.mjs test/project-git.test.mjs test/project-git-write.test.mjs` on Mac; Windows unit tests do not establish native Mac behavior.
- Windows supervisor tests use a real IPC-delivered shutdown event for its JS signal handler; Windows TerminateProcess cannot deliver a catchable SIGTERM. The POSIX launcher is exercised under the already installed Git Bash with path canonicalization, not claimed as native Mac execution.

Codex's final serial suite is 68/68; Native 14/14; Claude 27/27. The Codex 100ms startup fixtures had ten timeout failures while NSIS compression and all engines ran together; the complete unchanged suite passed after compression finished with test-file concurrency 1. Zero-test runs from an incorrect extension glob are not counted.

## Build dependency finding

Forced node-pty source rebuild originally failed with MSB8040 because this development machine has MSVC 14.44.35207 regular x64/x86 libraries but no Spectre libraries. The official Visual Studio installer returned **5007**. Its log explicitly says `Commands with --quiet or --passive should be run elevated from the beginning` and `vs.willow.iselevated : False`. No reboot, UAC elevation, security-setting change or permission bypass was attempted.

The pinned registry prebuild passes the target Electron native/ConPTY probe, so source compilation is unnecessary on this machine. C++ Build Tools, x86/x64 Spectre-mitigated libraries and Windows SDK are **fallback developer build dependencies**, not end-user runtime prerequisites.

## Reproduction

```powershell
npm test --prefix outputs/dsh-codex-engine
npm test --prefix outputs/dsh-native-engine
npm test --prefix outputs/dsh-claude-engine
node --test --test-force-exit --test-timeout=30000 outputs/dsh-codex-client/test/windows-terminal-native.test.mjs
node outputs/dsh-codex-client/scripts/test-windows.mjs windows-final
node --test outputs/dsh-codex-client/test/platform-packaging.test.mjs outputs/dsh-codex-client/test/windows-terminal.test.mjs outputs/dsh-codex-client/test/windows-computer-policy.test.mjs outputs/dsh-codex-client/test/provider-network.test.mjs
outputs/dsh-channel-runtime/python/runtime/python.exe -I -B outputs/dsh-channel-runtime/tests/test_adapters.py
npm run build --prefix outputs/dsh-codex-client
npm run package:win --prefix outputs/dsh-codex-client
```

The native-test runner uses force-exit only after the assertions; process cleanup itself is explicitly checked by the tests. Local evidence logs are excluded from Git and remain in the isolated task checkout.

Installer SHA-256: `54df6b387a9e094756e3a40ff5b952e7d13ae23c57ab24e1bb0ab57d6a0977f8`. The installer is a local ignored build output and is not published. CI lookup at the base commit found zero check runs, statuses and Actions runs; this is not a CI pass.

## Handoff failure inventory

Final Windows full run: 1132 tests, 1088 pass, 25 fail, 19 skip, 0 cancelled. All failed leaf error messages are EPERM from native file-symlink creation. No FIFO, assertion, timeout, or other error remains in that run. Full command returns nonzero; this is not an all-green claim.

| Test file | Symlink setup failures | Repeated parent failures |
| --- | ---: | ---: |
| `automations.test.mjs` | 1 | 0 |
| `client-recovery-api.test.mjs` | 1 | 0 |
| `client-state.test.mjs` | 1 | 0 |
| `document-drafts.test.mjs` | 1 | 0 |
| `file-info-api.test.mjs` | 1 | 1 |
| `file-info.test.mjs` | 2 | 0 |
| `files-encoding-api.test.mjs` | 1 | 1 |
| `files-encoding.test.mjs` | 1 | 0 |
| `files.test.mjs` | 2 | 0 |
| `git-drafts.test.mjs` | 1 | 0 |
| `image-api.test.mjs` | 1 | 1 |
| `image-files.test.mjs` | 1 | 0 |
| `plugins.test.mjs` | 2 | 0 |
| `project-git-write.test.mjs` | 1 | 0 |
| `project-git.test.mjs` | 1 | 0 |
| `resource-library.test.mjs` | 2 | 0 |
| `system-open-api.test.mjs` | 1 | 1 |

Additional handoff checks: 19/19 installation-lock, native NTFS hardlink/junction, official-origin/missing-key and real loopback stream/cancellation/recovery checks passed, with zero skips. Supervisor/command/lifecycle focus: 13 passed, 0 failed; four native Mac-only skips (three existing PTY checks plus the new supervisor native entry). No paid provider calls were made.

## Earlier rebuilt installer / isolated desktop handoff

The preceding rebuild and NSIS packaging both exited 0. Installer size was 393,805,147 bytes; SHA-256 is `4778f78272cde8679173ee914dfeec6654ceb45bb91bc06819151a78e921cb01`. It remains unsigned and unpublished. Source/staged hashes match for the supervisor, captured commands, Git, document recovery and Swift helper.

A new `handoff-final-安装 with spaces` target installed with exit 0. Installed runtime verification checked 123 resources, pinned Python 3.12.14, upstream hashes, native engine, Codex/Claude binaries, computer status and a real ConPTY. A separate new Chinese/spaces HOME/AppData profile launched successfully: the window showed Codex connected, DeepSeek-V4.1-Flash selected, the missing-provider-key message and disabled Send. No model request or credential setup was performed. The test-only profile selected close-to-quit before startup; the normal caption Close action completed the renderer/host shutdown handshake and the desktop exited **0**, without process termination. Uninstall exited 0; after its deferred cleanup, the executable was removed and isolated client JSON SHA-256 was unchanged. This confirms normal quit for this new run, superseding the earlier tray-only observation above.

Evidence (ignored local logs): `build-handoff-final.log`, `package-handoff-final.log`, `windows-handoff-final/summary.json`, `handoff-install.json`, `handoff-installed-verification.json`, `handoff-desktop-exit.json`, `handoff-uninstall.json`. That desktop UI automation alone did not validate the production computer helper; the additional native acceptance below now does so for the specified fixture scope.

## Production Windows helper focus / input acceptance

The explicit native fixture reproduced a real modal-window defect before the fix: when a second window in the same process disabled the observed owner HWND, `SetForegroundWindow` could still report that owner as foreground, and the helper returned key success instead of refusing. No unintended text mutation was observed, but successful dispatch was not authorized by that state.

The helper now checks native `IsWindowEnabled` before and after activation and requires each UIA element's native top-level HWND to match the observed window, rather than relying solely on PID or accessibility ancestry. No AttachThreadInput, foreground-lock changes, privilege escalation, focus-guard bypass or user-application input is used.

Source-device acceptance passed using the unmodified production launcher/JSON protocol against two newly-created WinForms windows: both processes were in interactive session 1 at medium integrity 8192. Normal activation established foreground HWND equal to the exact observed target HWND. A physical mouse click succeeded; UIA wrote `safe fixture 123`; native SendInput `End` plus digit `7` produced exactly `safe fixture 1237`. A modal test window then became foreground and natively disabled the observed owner. The same helper rejected input with `COMPUTER_FOCUS_CHANGED`; both text fields remained unchanged. Replaying the consumed observation or using it with the modal HWND in the same PID returned `COMPUTER_OBSERVATION_STALE`. Dismissing only the test dialog and obtaining a fresh observation restored normal input. Alphabetic key composition under a Chinese IME is not established by the digit delivery check.

Reproduction from repository root (creates only its own disposable windows and data):

```powershell
node outputs/dsh-codex-client/scripts/acceptance-computer-focus.cjs
```

The script uses the existing .NET Framework compiler for its test-only WinForms fixture. It is an explicit device test, not automatically run by headless unit tests. Set `DSH_ACCEPTANCE_APP_ROOT` to an installed `resources/app` to exercise the installed production helper. Evidence: ignored local `helper-focus-source-report.json` and `helper-focus-regression.log`.

The focus-fix full Windows regression (`windows-focus-final/summary.json`) again completed with **1132 tests: 1088 pass / 25 fail / 19 skip / 0 cancelled**. All failures are the same 21 native file-symlink EPERM setup failures and four repeated parent failures; no other errors were found. The rebuilt focus-fix installer is **393,807,189 bytes**, SHA-256 `0f3b56e1e89b7ba3466bab227cd477ec328bc7ae0122396dfaf279ec1f06250a`, unsigned and unpublished. `build-focus-final.log` and `package-focus-final.log` both completed with exit 0.

Installed focus-fix acceptance also passed. The new `focus-final-安装 with spaces` target installed with exit 0; 123 resources and all packaged runtime probes passed. The same explicit native focus test was then run with `DSH_ACCEPTANCE_APP_ROOT` set to that installed `resources/app`: physical click, UIA value, SendInput digit, disabled-owner/modal rejection, observation replay/different-HWND refusal and fresh-observation recovery all passed using the shipped C# source. Both fixture and helper were session 1, integrity 8192; during refusal, target HWND was 7604084 and foreground was the same-PID modal HWND 2296638, with target natively disabled. Both fields remained unchanged by rejected inputs. The installed helper bytes matched the final source.

The separate new-profile DSH window again showed Codex connected, official DeepSeek-V4.1-Flash, missing-key protection and disabled Send. Normal caption Close completed with desktop exit 0. Uninstall exited 0, removed its test executables and preserved the isolated client JSON hash. Evidence: `focus-install.json`, `focus-installed-verification.json`, `helper-focus-installed-report.json`, `helper-focus-installed.log`, `focus-desktop-exit.json`, `focus-uninstall.json`. No paid model call, system safety-setting change or input to an existing user app was performed. Native scroll and broader WGC capture acceptance remain outside this focused test; the capability label stays pending.

## Extended screenshot / scrolling acceptance — 2026-11-03

See [Windows computer scenarios](WINDOWS-COMPUTER-SCENARIOS.md) for the 23-case actual-device matrix on latest main f8a9ee1, measured GDI-primary/WGC-fallback behavior, async screenshot authority fix, actual four-direction wheel delivery and the precise image-coordinate/multi-display limitations. Full regression is 1139 tests: 1093 pass / 25 fail / 21 skip; all failures remain native file-symlink EPERM setup or repeated parent failures. This supersedes the earlier untested-scroll statement; it does not turn fallback use into WGC-only acceptance.

Final extended-scenarios installer: **393,819,534 bytes**, SHA-256 `54df6b387a9e094756e3a40ff5b952e7d13ae23c57ab24e1bb0ab57d6a0977f8`, unsigned/unpublished. Installed production modules passed **23/23** screenshot/scroll/lifecycle cases; 123 installed runtime checks and 96 source-file byte comparisons passed. Actual installed desktop normal quit and isolated uninstall both exited 0; client-data hash preserved. See `WINDOWS-COMPUTER-SCENARIOS.md` and `validation/windows-computer-installed-20261103.json` for exact scope and unsupported capabilities.
