# Windows and official DeepSeek reliability changes

Base: `65f0780fe8151e2dbf1fc06b096e3af6d7c3977f`. Changes are local; no release, installation, or real inference was performed.

## Implemented

- Configured official DeepSeek is the new-chat default; explicit model selections and historical model IDs remain intact. Provider credentials are isolated. Missing configuration fails before dispatch; provider failures have bounded typed errors and a settings action. Local `auth:none` providers remain supported.
- Responses/Messages translation validates complete SSE terminal states, fragmented tool arguments and UTF-8, cancellation, and length limits. Unsupported images/modalities are rejected explicitly. Translated official requests disable thinking until reasoning-content round trips are supported. Token-count requests cannot accidentally become paid completions.
- Unknown task outcomes can be abandoned after the owning engine is disposed. The unknown record remains, old callbacks are fenced, and no automatic resend occurs. Engine selection affects new chats without migrating old history.
- Windows x64 has a fresh-checkout release command, native CLI resolution, isolated Python runtime, missing-runtime retry suppression, ConPTY, owned Job process-tree cleanup, and package probes using Electron's ABI. The installer preserves user data on uninstall.
- Browser and native desktop capabilities are separate. Windows browser control is available; **Windows native desktop automation remains unimplemented**.

## Validation boundaries

Mac ARM64: full frontend/native helper build, offline host/engine tests, Python 3.12.14 adapter tests, and native-engine package startup probe. Model tests use fake credentials and local mocked responses; no production account or paid inference was used.

Windows x64 must run `npm run release:win --prefix outputs/dsh-codex-client` on the exact reviewed commit. Validate NSIS installation into an isolated directory and launch without preinstalled Node/Python; CLI/Python architecture, Electron native addon loading, ConPTY Chinese/spaced paths/resize/Ctrl-C, shell descendant cleanup on exit/stop/host crash, browser control, and uninstall preserving data. Build requires Node/npm, uv and the native build toolchain described in README; the installed product must not require these build tools.

Real DeepSeek authentication/inference, Windows UI smoke tests, code signing/notarization, and Windows native desktop automation are not certified by Mac or mock tests. The repository already had a Windows unsigned release; these changes address reproducibility and runtime gaps, not the existence of that release.

## Rollback

This branch is isolated. Reverting the local reliability commit restores the base source. Do not reset unrelated working changes. No user application data was migrated or removed by this work. Provider migration preserves historical IDs; do not delete user data to roll back binaries.
