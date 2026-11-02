# Windows device acceptance — 2026-11-02

Base: `f05d21b7b8392870e9a88bd0a91ba57efff1da99`, Windows x64 build 26100, Node 24.16.0, Electron 45.0.0 / embedded Node 24.22.0 / ABI 150, pinned CPython 3.12.14 AMD64.

This is a partial acceptance record, not a clean-machine release certification. No paid inference, real model API key, existing provider-account login, application-data migration, signing or release publication was performed. Git uses the existing Windows credential manager; no token from chat history is reused.

## Fixes confirmed on this device

- Remove uv version aliases/junctions before relocating its Python distribution. The original fresh Windows build failed while copying a dangling junction and required symlink privileges. Only the relocatable `runtime` is shipped now.
- Wait for a per-launch PowerShell readiness marker before exposing a writable ConPTY. Immediate first input was otherwise lost while the Job supervisor compiled/launched the shell.
- Use Windows byte-range account locks (`msvcrt`) rather than importing POSIX-only `fcntl`. Test exclusion and release across real processes.
- Suppress PowerShell module-loading progress so CLIXML does not pollute command output or consume output limits.
- Verify the locked node-pty prebuild under the exact target Electron ABI with a real ConPTY before requiring source rebuild. Rebuild is still the fallback; the copied packaged app repeats all runtime checks. Probe success requires both exit 0 and an explicit success marker.
- Make engine crash-fixture paths and directory-alias tests portable; Windows directory junctions need no Developer Mode/admin symlink privilege.

## Passed

| Check | Evidence |
| --- | --- |
| Codex engine | 68 passed, 0 failed |
| Native engine | 14 passed, 0 failed; includes crash recovery after one committed write |
| Claude engine / CLI path resolver | 27 passed, 0 failed |
| Official onboarding and recovery focus suite | 54 passed, 0 failed; missing key blocks dispatch, official model/endpoint selection, typed upstream errors, stream/stop recovery |
| Latest Windows policy/packaging + loopback network regressions | 27 passed, 0 failed |
| Real Windows native terminal | 3 passed, 0 failed; Unicode, Chinese/spaces cwd, immediate input, resize, Ctrl-C/prompt recovery, bounded stop, background descendant cleanup, host-death cleanup |
| Electron native ABI probe | Exact Electron 45.0.0, embedded Node 24.22.0, modules ABI 150; real command returns `ELECTRON_ABI_PTY_OK` |
| Python adapters | 31 passed; includes real cross-process account-lock exclusion/release. Existing unclosed ProactorEventLoop ResourceWarning remains |
| NSIS packaging | Exit 0; 120 packaged resources checked; Python/21 upstream hashes, native engine, Codex/Claude binaries and real ConPTY validated before NSIS |
| Isolated install / installed launch / uninstall | NSIS exit 0 in a Chinese/spaces install path; installed 120-resource/runtime verification passes; installed GUI launches and exits 0; uninstaller exit 0 removes executable, shortcuts and uninstall registration; isolated client-data SHA-256 unchanged; existing DSH-Codex data directory retained |
| Desktop build | `npm run build --prefix outputs/dsh-codex-client` exits 0 |
| New-user desktop GUI | Visible app in a fresh Chinese/spaces HOME/AppData directory; Codex app-server connects; official DeepSeek-V4.1-Flash selected; missing-key hint and disabled Send; Manage models opens official-provider setup |
| C# computer helper | Add-Type/status succeeds, nativeReady=true; selected temporary fixture screenshot captured |
| Real loopback HTTP/SSE transport | No secrets: missing key never contacts upstream; 401 is typed without echoing upstream body; incomplete stream fails; cancellation closes upstream; subsequent request completes |

## Not passed / not established

- Initial full desktop suite: **944 passed, 120 failed, 14 skipped** before the fixes. It is not a passing Windows full-suite result. Failures include POSIX mode/symlink/shell assumptions, Windows-incomplete Electron mocks (`setAppUserModelId`), path-format assumptions and other areas outside the focused acceptance. The full suite has not been rerun after these fixes.
- Native computer input: the safe fixture refuses with `COMPUTER_FOCUS_CHANGED`; no successful mouse/text/key input is claimed. A later WGC capture attempt timed out. The pending Windows-device capability label remains unchanged.
- No real DeepSeek payment/account/provider acceptance. Local mocks cannot establish actual provider availability or production billing behavior.
- Installer generated successfully (393,792,683 bytes), unsigned. Isolated install/launch/uninstall passed. The first test-harness run timed out after 120 seconds during extraction; after confirming that process stopped, a repair of the same test directory with a 10-minute bound completed with exit 0. This is not a clean-machine, upgrade-from-existing-install, or signed-distribution acceptance.

## Build dependency finding

Forced node-pty source rebuild originally failed with MSB8040 because this development machine has MSVC 14.44.35207 regular x64/x86 libraries but no Spectre libraries. The official Visual Studio installer returned **5007**. Its log explicitly says `Commands with --quiet or --passive should be run elevated from the beginning` and `vs.willow.iselevated : False`. No reboot, UAC elevation, security-setting change or permission bypass was attempted.

The pinned registry prebuild passes the target Electron native/ConPTY probe, so source compilation is unnecessary on this machine. C++ Build Tools, x86/x64 Spectre-mitigated libraries and Windows SDK are **fallback developer build dependencies**, not end-user runtime prerequisites.

## Reproduction

```powershell
npm test --prefix outputs/dsh-codex-engine
npm test --prefix outputs/dsh-native-engine
npm test --prefix outputs/dsh-claude-engine
node --test --test-force-exit --test-timeout=30000 outputs/dsh-codex-client/test/windows-terminal-native.test.mjs
node --test outputs/dsh-codex-client/test/platform-packaging.test.mjs outputs/dsh-codex-client/test/windows-terminal.test.mjs outputs/dsh-codex-client/test/windows-computer-policy.test.mjs outputs/dsh-codex-client/test/provider-network.test.mjs
outputs/dsh-channel-runtime/python/runtime/python.exe -I -B outputs/dsh-channel-runtime/tests/test_adapters.py
npm run build --prefix outputs/dsh-codex-client
npm run package:win --prefix outputs/dsh-codex-client
```

The native-test runner uses force-exit only after the assertions; process cleanup itself is explicitly checked by the tests. Local evidence logs are excluded from Git and remain in the isolated task checkout.

Installer SHA-256: `8f068399b4657c2a91fbbd13f557ba2176c52c0b4317ce274c51197ed5bf61b0`. The installer is a local ignored build output and is not published.
