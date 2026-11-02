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

源码打包支持在对应系统上构建 macOS（arm64/x64）和 Windows x64 NSIS 安装包。需要 Node.js 22.13+、npm 和 `uv`；macOS 需要 Xcode Command Line Tools，Windows 需要 Visual Studio 2022 Build Tools 的「使用 C++ 的桌面开发」及 Windows SDK（用于重建 ConPTY 原生模块）。各 JavaScript 包由 `package-lock.json` 固定依赖；消息通道使用 CPython 3.12.14 和包含哈希的 `requirements.lock`。

Build on the target OS and architecture: macOS arm64/x64 or Windows x64 (NSIS). Install Node.js 22.13+, npm and `uv`; macOS needs Xcode Command Line Tools, and Windows needs Visual Studio 2022 C++ Build Tools plus the Windows SDK for the native ConPTY module. JavaScript dependencies and Python channel dependencies are pinned by the included lockfiles.

从全新克隆的仓库根目录执行 / From a fresh checkout:

```sh
npm ci --prefix outputs/dsh-codex-engine
npm ci --prefix outputs/dsh-native-engine
npm ci --prefix outputs/dsh-claude-engine
npm ci --prefix outputs/dsh-codex-client

npm run prepare:channels --prefix outputs/dsh-codex-client

npm run build --prefix outputs/dsh-codex-client
npm run desktop --prefix outputs/dsh-codex-client
```

`prepare:channels` 下载固定版本 CPython 和带哈希的预编译 Python 依赖；准备失败会保留原运行时，成功后替换生成目录。不会安装系统 Python 或更改 PATH。构建会复制三套引擎和消息通道运行时，并编译原生辅助程序。Claude Code CLI 随 SDK 平台包提供，打包时验证；账户、API 密钥和消息通道授权在本机配置。

`prepare:channels` stages the pinned CPython and hash-checked binary dependencies, preserving the previous runtime if preparation fails. It does not install system Python or change PATH. The build copies the engine/channel runtimes and compiles the native helpers. The SDK platform package supplies Claude Code CLI, checked during packaging; configure accounts, API keys and channel authorization locally.

## 检查与打包 / Verification and packaging

```sh
npm test --prefix outputs/dsh-codex-engine
npm test --prefix outputs/dsh-native-engine
npm test --prefix outputs/dsh-claude-engine
npm test --prefix outputs/dsh-codex-client
outputs/dsh-channel-runtime/python/runtime/bin/python3 -I -B \
  outputs/dsh-channel-runtime/tests/test_adapters.py
npm run package --prefix outputs/dsh-codex-client
```

打包结果在 `outputs/DSH-desktop/`。测试通过不等于完成真实账号、系统权限和长期运行验收；分发签名及公证仍需单独处理。源码上传不包含应用安装包。

Packages are generated under `outputs/DSH-desktop/`. Tests do not replace live-account, OS-permission or long-running acceptance. Distribution signing and notarization are separate steps. This source repository does not include installers.

### Windows x64 构建 / Build

在 Windows x64 全新 checkout 中，安装前述 Node/npm、uv 和 C++ 构建工具后，只需运行：

```powershell
npm run release:win --prefix outputs/dsh-codex-client
```

此命令依次为四个 JavaScript 包执行锁文件安装，再准备 Python 通道运行时、构建界面和引擎，最后执行打包。任一步失败都会停止，且不依赖用户全局安装的 JavaScript 包。仅重新打包已准备好的构建时可运行 `npm run package:win --prefix outputs/dsh-codex-client`。

打包脚本先按 Electron ABI 重建 `node-pty`，生成 `DSH-win32-x64`，使用包内 Electron 验证模块、用包内 Python 离线导入五种通道、检查 Codex/Claude CLI 版本，并启动一个本地 ConPTY 测试命令；全部成功后才生成 `outputs/DSH-desktop/installers/DSH-0.1.0-windows-x64-setup.exe`。该流程不会发布、安装应用或启动收费模型任务。NSIS 为当前用户安装，默认不自动启动应用，卸载保留用户数据。签名需要发布者另行配置；未签名安装包可能出现系统信任提示。

不支持用 Mac 的依赖目录直接交叉生成 Windows 安装包，也不应将另一系统的 `node_modules`、`python` 或 `packages` 目录复制过来。Windows 运行要求 Windows 10 1809+（ConPTY），实际最低版本还受 Electron 支持范围约束。已有 `v0.1.0-win.1` Windows 发行包；以上脚本补齐源码内可重复执行的构建流程，并不宣称与旧包逐字节相同。

From a fresh Windows x64 checkout, `npm run release:win --prefix outputs/dsh-codex-client` installs the four locked JavaScript packages, prepares Python, builds, then packages in order; any failed stage stops the pipeline. Prerequisites are Node/npm, uv and C++ Build Tools. Packaging rebuilds the terminal module for Electron, verifies the staged runtimes offline, then creates the per-user NSIS installer. The script never publishes or installs the result. Do not reuse native dependencies from another OS. Uninstall preserves user data. Signing is a separate publisher step.

Windows release acceptance remains required on a clean machine: installation and uninstall, paths with spaces/Chinese characters, terminal input/resize/Ctrl-C/child-process cleanup, Python adapter startup, and first-task recovery. macOS mock tests cannot establish these Windows results.


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
