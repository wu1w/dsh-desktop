# DSH Desktop

独立的 DSH 桌面客户端，集成 DeepSeek Harness 原生、Codex 与 Claude Code 三种执行引擎，支持独立聊天、插件开发与回退、任务恢复、资料空间和 IM 消息通道。界面使用现有中英文 i18n 资源。

An independent DSH desktop client with DeepSeek Harness, Codex and Claude Code engines, projectless conversations, versioned plugins, task recovery, a local library and messaging channels. User-facing strings use the existing Chinese/English i18n resources.

## 源码布局 / Source layout

| Directory | Responsibility |
| --- | --- |
| `outputs/dsh-codex-client` | Electron desktop shell, local HTTP host, React UI, plugin lifecycle and tests |
| `outputs/dsh-codex-engine` | Codex App Server adapter |
| `outputs/dsh-native-engine` | Native DeepSeek Harness adapter |
| `outputs/dsh-claude-engine` | Claude Code adapter |
| `outputs/dsh-channel-runtime` | Feishu, QQ, WeChat, DingTalk and WeCom transport adapters |

这些目录是源码。客户端内部的 `engine/`、`native-engine/`、`claude-engine/`、`channel-runtime/` 和 `dist/` 由构建生成，不进入 Git。依赖、应用包、用户截图、会话、凭据、草稿和本机诊断记录也不进入仓库。

These five directories are authoritative. Generated runtime copies, dependencies, application bundles, user screenshots, conversations, credentials, drafts and local diagnostic records are excluded from Git.

## 开发 / Development

当前桌面打包目标是 macOS Apple Silicon。需要 Node.js 20+、npm、Xcode Command Line Tools 和 `uv`。各 JavaScript 包由 `package-lock.json` 固定依赖；消息通道使用 CPython 3.12.14 和包含哈希的 `requirements.lock`。

The current desktop packaging target is macOS Apple Silicon. Install Node.js 20+, npm, Xcode Command Line Tools and `uv`. JavaScript dependencies and Python channel dependencies are pinned by the included lockfiles.

从全新克隆的仓库根目录执行 / From a fresh checkout:

```sh
npm ci --prefix outputs/dsh-codex-engine
npm ci --prefix outputs/dsh-native-engine
npm ci --prefix outputs/dsh-claude-engine
npm ci --prefix outputs/dsh-codex-client

uv python install --no-bin --install-dir outputs/dsh-channel-runtime/python 3.12.14
mv outputs/dsh-channel-runtime/python/cpython-3.12.14-* outputs/dsh-channel-runtime/python/runtime
uv pip install --python outputs/dsh-channel-runtime/python/runtime/bin/python3 \
  --target outputs/dsh-channel-runtime/packages --require-hashes \
  -r outputs/dsh-channel-runtime/requirements.lock

npm run build --prefix outputs/dsh-codex-client
npm run desktop --prefix outputs/dsh-codex-client
```

`mv` 只用于全新克隆的首次准备；已有 `python/runtime` 时不应重复执行。构建会复制三套引擎和消息通道运行时，并编译原生辅助程序。Claude Code 的 CLI 另行安装；账户、API 密钥和消息通道授权在本机配置。

The `mv` step is only for the initial setup of a fresh checkout; do not repeat it when `python/runtime` already exists. The build copies the engine/channel runtimes and compiles the native helpers. Install the Claude Code CLI separately and configure accounts, API keys and channel authorization locally.

## 检查与打包 / Verification and packaging

```sh
npm test --prefix outputs/dsh-codex-engine
npm test --prefix outputs/dsh-native-engine
npm test --prefix outputs/dsh-claude-engine
npm test --prefix outputs/dsh-codex-client
outputs/dsh-channel-runtime/python/runtime/bin/python3 -I -B \
  outputs/dsh-channel-runtime/tests/test_adapters.py
node outputs/dsh-codex-client/scripts/package.mjs
```

打包结果在 `outputs/DSH-desktop/`。测试通过不等于完成真实账号、系统权限和长期运行验收；分发签名及公证仍需单独处理。源码上传不包含应用安装包。

Packages are generated under `outputs/DSH-desktop/`. Tests do not replace live-account, OS-permission or long-running acceptance. Distribution signing and notarization are separate steps. This source repository does not include installers.

### 源码上传前检查 / Source snapshot checks — 2026-10-31

| Suite | Result |
| --- | --- |
| Desktop client | 1,026 passed; 1 existing skip |
| Codex engine | 68 passed |
| Native Harness engine | 14 passed |
| Claude Code engine | 22 passed |
| Messaging runtime | 30 passed |
| Vendored Hermes provenance | 21 file hashes matched |

运行环境为 macOS arm64、Node.js 26.9.0。首次同时运行各套测试时，Codex 1 项与 Claude Code 2 项时序测试失败；分别重跑整套引擎测试后通过，尚不能据此认为并发时序波动已修复。消息通道测试结束时仍有一条 event loop 资源警告。本次上传未改变运行时行为，也未重新安装桌面应用。

Checks ran on macOS arm64 with Node.js 26.9.0. The first concurrent run failed one Codex timing test and two Claude Code timing tests; both complete engine suites passed when rerun separately. This does not establish that timing sensitivity is fixed. Channel tests still emitted one event-loop resource warning. This upload does not change runtime behavior or reinstall the desktop app.

## 文档与来源 / Documentation and provenance

- [客户端说明 / Client documentation](outputs/dsh-codex-client/README.md)
- [插件 API / Plugin API](outputs/dsh-codex-client/PLUGIN-API.md)
- [桌面恢复 / Desktop recovery](outputs/dsh-codex-client/DESKTOP-RELIABILITY.md)
- [电脑操作 / Computer Use](outputs/dsh-codex-client/COMPUTER_USE.md)
- [IM 通道及边界 / Messaging channels](outputs/dsh-channel-runtime/README.md)
- [客户端来源声明 / Client notices](outputs/dsh-codex-client/NOTICE.md)
- [原生引擎来源声明 / Native engine notices](outputs/dsh-native-engine/NOTICE.md)

复用的 Hermes 文件保留原始 MIT 许可证，`UPSTREAM.json` 固定上游提交和文件哈希；其他依赖沿用各自许可证。子目录说明包含阶段性开发记录；其中引用的本机验收材料不属于本源码仓库。

Vendored Hermes files retain their original MIT license, with the upstream commit and file hashes recorded in `UPSTREAM.json`. Other dependencies retain their own licenses. Package documentation includes historical development notes; referenced local acceptance records are not part of this source repository.
