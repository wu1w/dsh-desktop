# DSH Computer Use

入口：聊天输入框的 **加号 → 使用电脑**，或输入 **/computer**。功能作为“电脑操作”插件独立启停。

1. 连接 DSH 浏览器或选择正在运行的本机应用（Windows 原生适配器仍待实机验收）。
2. 在聊天里说明任务。三种引擎共用同一个目标、观察和停止机制。
3. 右侧查看目标画面，输入框里的状态按钮可随时展开。点击“停止控制”立即撤销连接；聊天停止、插件停用、引擎退出或切换也会撤销。

## 浏览器

每个聊天使用独立的临时浏览器环境。不会读取已有浏览器标签页、Cookie 或登录状态。支持页面文字与控件观察、导航、输入、点击、快捷键、滚动、前进和后退。关闭目标窗口会断开控制。下载、额外窗口与站点权限请求暂不开放。

## 平台能力与验收状态

| 能力 | macOS | Windows |
| --- | --- | --- |
| 独立 DSH 浏览器 | 已实现，不依赖辅助功能或屏幕录制授权 | 已实现相同 Electron 浏览器路径，待 Windows 实机验收 |
| 本机应用控制 | macOS 原生辅助程序，需要辅助功能授权 | 已实现 UI Automation 适配器；C# 编译与真实桌面操作尚未在 Windows 验收 |

状态接口分别返回 `browserAvailable` 和 `nativeAvailable`。Windows 不启动 macOS 辅助程序，不打开 macOS 权限页面。macOS 辅助程序缺失或启动失败时，浏览器仍可使用；本机应用页显示可重试的错误。宿主也校验这些能力，不能通过绕开界面调用不支持的目标。

本轮离线测试使用模拟 Electron 窗口和系统进程，验证 Windows 浏览器可用、浏览器隔离与关闭清理、原生协议输入与窗口绑定、非交互桌面状态、失效子进程隔离，以及 macOS 辅助程序故障降级；没有将模拟测试当作 Windows 实机验收。发行前需在 Windows 安装包中验证浏览器连接、HTTP(S) 导航、中文输入、观察令牌失效、用户关闭窗口和停止控制。

Windows 原生适配器使用 Windows 自带 PowerShell 5.1 的固定 MTA 启动代码，通过 `Add-Type` 加载随包 C# 源码，调用 .NET UI Automation 和 user32；不下载模块、不更改执行策略、不请求管理员或 `uiAccess`。Constrained Language Mode 或应用策略阻止编译时，界面显示策略阻止，浏览器保持可用。UI Automation 在无窗口 MTA 线程运行，遵循 [Microsoft 线程模型建议](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)。

目标绑定包含 PID、进程启动时间与 HWND，窗口销毁、PID 复用和窗口重建后必须由用户重新连接，不能自动选择同一进程的其他窗口。控件动作采用 Invoke/SelectionItem/Toggle/Value pattern；键盘与滚动使用 SendInput。变更操作消耗观察令牌，检查当前焦点、控件身份和窗口边界；输入部分送达时仅尽力释放已注入的按键/鼠标按钮，不重放动作。密码和验证码字段由用户操作。现有模型工具仍仅接受控件 ID，不开放截图坐标点击。

需要已登录用户的活动会话和普通 `Default` 输入桌面。服务会话、断开的远程会话、锁屏/UAC、跨会话或更高完整性目标会被拒绝；没有恢复桌面、提升权限或修改安全策略的代码。截图只匹配所绑定 HWND，不回退到屏幕或其他窗口。窗口和显示器边界使用物理像素，可含负坐标，截图元数据单独给出缩放后的图像尺寸与映射比例；缩放不会被当作点击坐标。参见 [Microsoft UI Automation 安全说明](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)、[SendInput 与 UIPI](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。

**待实机验收**：Windows 10/11 干净安装的 C# 编译、标准用户 UIA 控件读写、按键/滚动与停止、中文输入、密码/验证码保护、多显示器负坐标及混合 DPI、目标关闭/重建、UAC/锁屏拒绝、截图 HWND 一致性与策略受限失败。当前仅完成 Mac 上的 JavaScript 协议/模拟 Electron 测试与源码复核，不能据此宣布 Windows 原生控制已验收。状态字段 `nativeValidation: pending-windows-device` 和界面提示保留此边界。

## 本机应用

使用 DSH 自己的 macOS 辅助功能适配器，目标绑定到所选应用进程。辅助功能权限由 macOS 管理；未授权时不能点击和输入。屏幕录制用于显示所选窗口的预览，找不到该窗口时不会替换成其他窗口。权限页提供检测和系统设置入口。

支持读取控件、对可操作控件执行点击和设置值、快捷键及滚动。密码与验证码由用户填写。部分应用不提供可访问控件，因此本版不能操作其纯图片、画布或自定义控件。

## 当前能力边界

现有 DeepSeek 路由按文字模型接入：模型依据页面文字及辅助功能控件操作，截图只供用户查看，不把图片编码塞进文字上下文。因此本版不是基于截图坐标的完整视觉代理，也不能声称与 Codex 或 ZCode 全部能力等同。浏览器的跨域 iframe、闭合 Shadow DOM、原生拖拽和视觉定位尚未开放。

授权只保留在当前进程内；重启、引擎切换或退出后需要重新连接。IM 会话和子智能体任务不允许直接连接电脑控制。模型调用经当前聊天的活动任务和目标授权校验，不能凭另一个聊天的 ID 操作其目标。过期观察、目标内容改变、停止后的排队调用、可能已执行但未收到结果的操作均不会盲目重放。

## 来源

参考 ZCode 公开仓库 commit `3c5b227649371507ddc4eb46ac5133afe6db1cab` 和其 Browser Use 文档。该版本的 `packages/zcode-cua` 明确是不可执行的占位包。本实现自行编写浏览器宿主、macOS 辅助功能适配器和三引擎桥接，没有复制其不可用核心，也未提取已安装 ZCode 应用的私有组件。

- https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/zcode-cua
- https://zcode.z.ai/en/docs/browser-use
