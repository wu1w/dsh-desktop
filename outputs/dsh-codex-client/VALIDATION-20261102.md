# Windows and official DeepSeek reliability changes

Base: `65f0780fe8151e2dbf1fc06b096e3af6d7c3977f`. Validation used an isolated checkout; no application release, installation, or real inference was performed.

## Implemented

- Configured official DeepSeek is the new-chat default; explicit model selections and historical model IDs remain intact. Provider credentials are isolated. Missing configuration fails before dispatch; provider failures have bounded typed errors and a settings action. Local `auth:none` providers remain supported.
- Responses/Messages translation validates complete SSE terminal states, fragmented tool arguments and UTF-8, cancellation, and length limits. Unsupported images/modalities are rejected explicitly. Translated official requests disable thinking until reasoning-content round trips are supported. Token-count requests cannot accidentally become paid completions.
- Unknown task outcomes can be abandoned after the owning engine is disposed. The unknown record remains, old callbacks are fenced, and no automatic resend occurs. Engine selection affects new chats without migrating old history.
- Windows x64 has a fresh-checkout release command, native CLI resolution, isolated Python runtime, missing-runtime retry suppression, ConPTY, owned Job process-tree cleanup, and package probes using Electron's ABI. The installer preserves user data on uninstall.
- Browser and native desktop capabilities are separate. Windows browser control is available. A built-in Windows UI Automation/user32 adapter now implements native control with PID/start-time/HWND binding, protected-field checks, interactive-desktop/integrity boundaries and physical screenshot metadata; **Windows C# compilation and real input/capture remain unvalidated**. The runtime and UI retain `pending-windows-device`.
- Independent review corrected Anthropic custom-tool translation, permanent abandonment after archive/restore, bounded historical model migration, Python architecture/rollback checks, and Windows stop ownership. Windows stop uses an owned random event and Job handle instead of asynchronous PID-based termination.

## Validation boundaries

Mac ARM64: full frontend/native helper build, offline host/engine tests, Python 3.12.14 adapter tests, and native-engine package startup probe. Model tests use fake credentials and local mocked responses; no production account or paid inference was used.

Final local regression: client 1,104 passed, 0 failed, 4 Windows-only tests skipped (1,108 total). Codex engine 68/68, Claude engine 27/27, native engine 14/14 and Python channel adapters 30/30 passed. Windows adapter checks use mocked Electron/IPC and source review, not Windows UI execution. The full build completed on Mac ARM64. Re-run native Windows checks on the published commit before distributing a Windows installer.

Windows x64 must run `npm run release:win --prefix outputs/dsh-codex-client` on the exact reviewed commit. Validate NSIS installation into an isolated directory and launch without preinstalled Node/Python; CLI/Python architecture, Electron native addon loading, ConPTY Chinese/spaced paths/resize/Ctrl-C, shell descendant cleanup on exit/stop/host crash, browser control, and uninstall preserving data. Native computer acceptance additionally requires a signed-in interactive desktop: standard-user UIA control reading/writing, Chinese text, keyboard/scroll and stop, HWND-specific capture, mixed-DPI/negative-coordinate displays, stale/recreated windows, protected fields, UAC/lock-screen refusal, and policy-blocked startup. The package status probe compiles/checks the helper without controlling apps; it does not replace these checks. Build requires Node/npm, uv and the native build toolchain described in README; the installed product must not require these build tools.

Real DeepSeek authentication/inference, Windows UI smoke tests, code signing/notarization, and Windows native desktop automation are not certified by Mac or mock tests. The repository already had a Windows unsigned release; these changes address reproducibility and runtime gaps, not the existence of that release.

## Rollback

Revert the reliability changes in reverse commit order to restore the base source; do not reset unrelated working changes. No user application data was migrated or removed by this work. Provider migration preserves historical IDs; do not delete user data to roll back binaries.
