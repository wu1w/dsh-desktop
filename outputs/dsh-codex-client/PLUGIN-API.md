# 独立 DSH 的插件接口

这是本客户端实际实现的 Cordis 接口，不代表原 DSH 社区插件全部兼容。插件是具有本机 Node 权限的代码；资源应通过 `ctx.effect` 注册清理。外观停止时回到宿主恢复页，原生壳不内置聊天和文件界面。

本地包需要 `dsh-plugin.json`，包含 `id`、`type`（appearance/feature/engine）、`version`、中英文 `name` 和可选 `entry`（默认 index.mjs）。ID 使用以小写字母开头的2–80位小写字母、数字和连字符。安装仅复制和登记，不执行入口；启用才导入 `apply(ctx, host)`。界面提供启用、停用和外部包卸载；内置包可以停用。

## 功能替换

`host.registerRoute({matches(segments, method), handle(environment)})` 注册本插件的 API。environment 包含 request、response、segments、url、body、json、locale；沿用宿主认证与错误处理。一个插件注册一个路由分发器，可以自行处理多个动作。feature 路由自动提供以自身 manifest.id 命名的能力。

`host.registerFeature(canonicalId)` 可接替另一功能的标准能力。例如先停用内置 feature-files，再启用提供 feature-files 能力的外部文件插件。现有外观依据实际注册表开放控件，而不是因为内置包停用了就一直禁用。原提供者仍运行时会冲突，不能抢占。

功能提供者须实现该能力的完整接口与语义；注册不是对其功能正确性的自动认证。当前标准能力为 feature-projects、feature-chat、feature-files、feature-terminal、feature-integrations、feature-git、feature-automations、feature-images。行为指令另外通过 registerInstructionProfile 注册。

注册自动跟随 Cordis 生命周期清理，也返回可提前调用的清理函数。路由停止入场后等待在途操作，资源依然必须自行取消：例如通过 ctx.effect 关闭 ProjectGit、命令进程、定时器、文件监听和连接。直接在模块顶层创建的未知资源不会自动回收。副作用初始化失败也必须可清理。

`host.hasFeature(canonicalId)` 查询当前真实注册能力，可在异步动作开始前再次检查。功能停用后不得继续启动新的后台执行。

`GET /api/state` 中 features 为当前标准能力ID；只有真实注册才会进入列表，manifest声明不会自行提供能力。外部提供者及原提供者停止后，能力及其控件同步停用。

## 引擎替换

`host.registerEngine(id, {capabilities, async create(options)})` 注册可选择的执行引擎。引擎ID遵循相同安全字符规则，并且可以与插件ID不同。一个包可注册多个引擎。create 返回 `{engine, dispose}`，engine 遵循客户端的持久会话/事件/队列接口；未实现的能力在 capabilities 中设为 false，不得模拟成功。

引擎注册表公开为 engineProviders：每项包含真实 id、pluginId 和 capabilities。设置与恢复壳使用这个注册表选择，不能由包名称猜引擎ID。选中的提供者停用时仅结束自己的运行时；独立会话映射保留。原生应用的 GPT/Claude 登录不是可复用的隐式依赖。

create 得到独立 dataDir、固定运行时 binary 和凭据解析回调等现有选项。凭据不应进入 manifest、前端、模型提示词、配置文本或日志。Codex 与 Claude 的实际适配和能力界限分别见上一级核验记录。

## 外观替换

`host.registerAppearance({root, entry, styles, exportName})` 注册本地外观资源目录、ESM入口、样式文件和挂载函数名。资源经宿主范围检查和白名单提供。挂载函数接收容器并返回异步清理函数；清理应先等待草稿落盘，再卸载界面、监听和连接。保持后台协议与模型逻辑在对应功能/引擎插件。

内置示例是 appearance-codex，实际入口为 mountDshAppearance。停用后宿主恢复页仍可安装和管理插件。外观模块、功能模块和引擎是不同的注册对象，可独立更换。

## 验收边界

已用真实 Cordis 和临时本地包验证功能接替、冲突、失败回收、落盘回滚、停止与重启保留，以及包内宿主的实际文件读取接替。自行注册原 DSH SDK 服务的社区插件还需逐项适配；不会把本接口的通过报告成整个旧生态的兼容。外部 ESM 在线升级已使用独立版本目录，嵌套依赖随版本更新；任意第三方资源回收和完整安装迁移仍须逐项验收。

本地自动化的调度、执行器和路由均由feature-automations加载，宿主只提供通用会话/引擎服务。终端native helper由feature-terminal创建和清理，构建时编译并打包，运行时不依赖编译器。


## 活动与退出

`host.registerActivityProvider(id, snapshot)` 注册同步的内存活动快照，返回自动随Cordis清理的移除函数。snapshot返回`[{id,kind,count,projectId?}]`，kind为terminal/command/automation/unknown，count为正整数。id必须对应具体进程或运行实例，任务替换应换id；不要把prompt、命令正文、凭据放入快照。异步、异常或非法快照被视为未核实活动，不能据此直接退出。`GET /api/state.activities`提供经过筛选的快照，真实模型另有sessions.running与activeTurnId。停用和关闭仍须由提供者实际取消、释放自己的资源。

内置外观的退出握手锁定 app-shell、body 门户和每个已打开的 dialog；握手期间新打开的 dialog 由生命周期内的观察器补锁。文档捕获 Escape 与 cancel，避免原生 CloseWatcher 绕过 inert；退出时在途的鼠标事件也不会关闭下拉门户。失败、取消或外观卸载时移除监听、断开观察、恢复此前 inert 状态，并尽力恢复仍连接的原焦点。桌面菜单回调和全局快捷键同步遵守交互锁；这是外观内的交互保护，不是对任意外部脚本或系统进程的事务锁。

宿主恢复页属于最小启动与插件恢复底座，不实现聊天界面。client.json损坏时不加载功能或引擎插件，防止在不可核对记录的情况下继续调度。


## Git 功能提供者

feature-git 当前有 GET `projects/:id/git/status` 与 `diff?path=...&staged=0|1`。status新增 `revision`、`writeCapabilities:{stage,unstage,commit,reasonCode?}` 和可选 `identity:{name,email}`。缺少写能力的旧提供者仍可只读审阅，外观不能猜测写能力。

POST `stage` / `unstage` 接收 `{path,revision}`；POST `commit` 接收 `{message,revision,name?,email?}`。返回 `{status,commit?}`，commit为 `{oid,shortOid,subject}`。仅提交已暂存范围，不自动暂存，也不改身份配置。revision失效/不确定结果必须明确返回错误，调用方不可自动重试。界面提交先读取新status并核对范围，再由用户二次确认。

默认提供者使用自己的临时index和原生index.lock。提交用commit-tree产生对象，再以原生update-ref事务在prepare持锁后核对HEAD归属和旧OID；源码/原生故障回归与包内API证据另行记录。普通SHA-1、Git≥2.30、无转换属性/冲突/子模块/linked worktree等受支持；文件16MiB、快照总32MiB和metadata5万项为当前限制。失败可能遗留未引用对象；工作文件和用户Git配置不写，不能把它宣称成对任意外部进程或文件系统攻击者的OS原子CAS。

Git活动按整个operation的稳定UUID注册，涵盖子进程之间的Node文件阶段；停用中止并等待自己的全部操作。替换提供者应保留这些生命周期、限制和错误语义。


Git草稿为feature-git的独立资源：GET `git-drafts?projectId=...` 返回 `{draft:null|{projectId,message,authorName,authorEmail,version,updatedAt}}`；POST `git-drafts/save` 接收三字段及 `{projectId,baseVersion}` 返回 `{draft}`；POST `git-drafts/clear` 接收 `{projectId,baseVersion}` 返回 `{cleared}`。缺行baseVersion为null；每次保存产生新UUID，版本不匹配返回GIT_DRAFT_CHANGED，不可自动覆盖。替换提供者须保留自动保存、错误保护与close等待已接收写入的契约；停用保留独立记录，不把作者草稿写入Git配置。

## 事件恢复约定

`/api/events`以JSON SSE消息和15秒注释心跳工作，每次订阅先发权威approvals-sync。连接恢复不等同于事件重放。内置外观45秒无字节会断开并重新握手；bootstrap总期限15秒、16MiB响应上限，单事件4MiB。重新订阅后并行补读state与当前session，拥有15秒恢复期限；期间已收到state事件时不应用较旧state快照，历史/队列仍各自保留live版本保护。

内置外观在恢复时派发 `dsh-stream-restored`，detail含 `{generation,signal,waitUntil(operation)}`；已打开的独立预览可同步注册自己的只读恢复Promise，响应同一signal并拒绝应用取消后的迟到结果。不要在此自动重发Turn、队列写入或审批答案。事件源不提供历史Last-Event-ID重放保证；完整记录以会话接口读取结果为准。


## 文件内容与引用

feature-files的文本GET/POST现明确只接收最多2MiB严格UTF-8且无NUL的普通文件。GET版本为原始UTF-8字节SHA-256，保留BOM和CRLF；读取期间增长亦按实际字节有界。非法编码FILE_ENCODING、提交非法Unicode/NUL为FILE_INVALID_TEXT，均不会用替换字符覆盖原文件。替换提供者应保留canonical版本/并发写保护和这些错误语义。

内置外观对项目引用解析位置并用当前DocumentSession定位，同文件有未保存输入时不重读。位置只属于捕获的projectId+path，不作为URL或文件API路径的一部分；列按Unicode字符计数，越界保留内容并显示提示。编辑器将textarea规范化的LF最小变化映射回原文，保留未改行尾/BOM，新插入换行沿用首个现有行尾。这不是通用富文档或全语言语法编辑器。

`POST /api/projects/:id/open {path}` 要求项目内实际路径，默认提供者等待 `/usr/bin/open`（macOS）或 `xdg-open`（Linux）自身退出0，才返回 `{ok:true,accepted:true}`；此语义为系统已接受请求，不承诺窗口出现。外观对无accepted确认的替换提供者显示未确认错误，不冒称打开成功。默认4并发、10秒后取消自己的launcher；TERM/KILL后仍无法确认退出则FILE_OPEN_CLEANUP_FAILED，保留活动供排查，不扫描或关闭已移交的独立应用。错误仅返回共享错误码/双语文案，不泄漏launcher stderr或模型凭据。

`host.registerBeforeStop(async ({reason,pluginId})=>{...})` 是显式停用前确认，支持disable/shutdown，当前fiber最多64项，并返回注销函数。宿主暂停新路由入场后逐项等待，再交给Cordis实际dispose。拒绝时不写停用设置、不移除原fiber/活动/路由；错误显示，允许资源实际完成后重新停用。资源可能已进入closed状态，拒绝不能回滚已发生的外部清理；实现须让重复close安全。内置系统启动器使用此钩子，ctx.effect仍作最终兜底。不能依赖Cordis effect disposer异常向上传播；未知异常按PLUGIN_STOP_FAILED隐藏原细节。

PluginHost.close失败会返回PLUGIN_CLEANUP_FAILED，在该类中保留未确认资源并允许再次close；整个宿主shutdown的最终context.dispose仍会撤销注册并退出，不能把类级重试能力冒充不可终止OS进程的永久接管，也不能把所有未接入此钩子的第三方effects保证成可确认释放。

`GET /api/projects/:id/file-info?path=...` 只接受GET、三段路由和单个path参数，返回普通文件 `{path,name,size,modifiedAt}`，不含正文或编辑版本。大小为bytes、时间为ISO；不受2MiB文本限制。实际fd/路径/dev/ino/size/mtime/ctime/canonical重核、O_NOFOLLOW/O_NONBLOCK，非普通文件和变化拒绝，句柄总会关闭。它不是OS级无竞态保证。

内置外观仅在文本GET明确BINARY_FILE/FILE_ENCODING/FILE_LIMIT时请求元数据，显示不可编辑fallback及手动系统打开；不自动启动应用。替换提供者未实现元数据或返回错目标/不完整信息时保留原预览并报错。fallback不恢复或清理已有文本备份，也不把空占位正文保存为文件；正常关闭flush保持这一语义。列表API仍使用原entries形状与2000项限制，前端没有冒充已完成后端分页。

项目恢复key在POSIX按原始文件名语义处理，允许非NUL控制字符/反斜线/冒号字面，仍拒绝原生绝对路径、精确上级段和超4096 UTF8 bytes。Windows保留其专用反斜线/drive规则，未在Mac冒称实测Windows。恢复正文2MiB、128份/16MiB不变；私有JSON读取上限固定按正文6倍、每份4096byte路径6倍及元数据预算计算，为100MiB+1024。显式两个旧Windows-like非法断言仅在Windows执行，其余原断言保留。

attachmentDrafts的API/客户端索引验证使用同一函数，path采用实际OS分隔符规则及4KiB bytes，NUL/空/原生绝对/精确上级拒绝。name/MIME字段限制与每draft50项保留；出现无效attachmentDrafts时整笔preferences请求拒绝，不局部保存theme等其它字段。原1M附件偏好payload及8MiB索引上限保留。界面每批上传20项/10MB，同步上传锁与当前附件快照避免同事件越50或双上传；失败释放锁，未发送任何模型推理作为本地附件测试。

外观的文档恢复同步器错误回调现在附带冻结的 `{kind,projectId,path}`，不附正文或秘密。非当前文件的旧clear错误不覆盖新预览的提示；原promise仍reject、失败记录与flush重试保留，正常关闭仍会报告未完成的持久化。save失败继续可见，不以隐藏过期清理提示冒充恢复存储成功。

## 内置资源停用补充（2026-10-24）

终端、Git、自动化与系统文件启动器均使用 registerBeforeStop。多个资源必须全部尝试并等待，不可用 Promise.all 的首个拒绝提前返回后撤销尚在清理的注册；本机实现使用 allSettled 后明确汇总错误。普通 ctx.effect 仍作兜底，不能用它的成功返回证明清理完成。

项目命令停止确认跟踪进程组退出及管道关闭；未确认返回 COMMAND_STOP_FAILED 并保留 registry。PTY 的 native helper 与 JS 必须配套：guardian 仅保留 stderr 控制管，清理自身 PTY session 后输出完整 DSH_PTY_GUARD_DONE 行；缺失/非法/失败回执返回 PTY_STOP_FAILED，保留 cleanupPending 活动，不能由 helper close 或其组消失猜测完成。主动 setsid 并关闭全部继承管道的独立 daemon 不在完整进程树保证内。

Git 停用中止并等待 operation、实际子进程、自己创建的 index lock 和临时资源；10秒期限未确认时 GIT_CLEANUP_FAILED。重试只清理，不重放 stage/commit。Git 草稿等待已接收写入，停用期间发生写入失败时保留保护标记，恢复后由用户重试同项目保存/清除，成功才解除；正常 validation/CAS 冲突或读取错误不永久阻止停用。

自动化 close 最多10秒等待实际执行终态；超时 AUTOMATION_STOP_FAILED，保留运行活动、durable claim 和独立存储锁，且不会在隐藏的超时续体中释放锁。结果未知时不重放任务；晚到实际终态后需显式重试停用。单次失败不能永久缓存为 closing，锁释放失败也可重试。

整个宿主关闭会依次尝试命令、引擎与插件、Cordis、写入与存储、socket 和宿主锁，某项失败不会跳过其余资源，最后向调用方返回清理错误。整个宿主退出的强制 context.dispose 不能被描述为不可终止 OS 进程的清理成功；插件类内失败重试与宿主最终退出是不同边界。


## 静态图片功能插件

`feature-images` 独立于 `feature-files` 注册，可由外部提供者在内置提供者停用后通过 `registerFeature('feature-images')` 接替。内置外观仅在实际能力存在，且文本读取明确为二进制、非法编码或过大时尝试图片接口；普通文本/SVG源代码不在图片解码上下文执行。外观与功能插件分别管理组件、临时 URL 与宿主 I/O，不将功能焊入 Electron 壳。

- `GET /api/projects/:id/image-info?path=...` 返回 `{path,name,size,modifiedAt,version,mime,width,height}`。`version` 为实际原字节的小写 SHA-256，`modifiedAt` 为ISO时间。路径必须与请求对应，MIME只允许 `image/png`、`image/jpeg`、`image/webp`。
- `GET /api/projects/:id/image?path=...&version=...` 要求同一64位小写hash；版本不符返回 `IMAGE_CHANGED`。成功响应是原字节，固定 Content-Type、Content-Length、X-DSH-Image-Version、nosniff/no-store。两接口都要求宿主本机cookie与capability，不能把原始API当无授权img标签地址。
- 限制：16MiB、32000000像素、单边16384；静态PNG/JPEG/WebP的受支持子集。APNG/WebP动画、SVG/GIF、异常容器与不支持编码明确拒绝。容器/CRC/头结构检查不等于服务端完整解码；像素解码交给浏览器，外观必须处理onError、实际尺寸与EXIF旋转。
- 实际路径/canonical/fd/dev/ino/size/mtime/ctime读取前后重核；普通文件、O_NOFOLLOW/O_NONBLOCK、有界读取和关闭。不是恶意外部写入下的OS原子快照保证。敏感元数据、外部别名和非普通文件拒绝。
- 读取/传输活动使用同一稳定身份，网络写出前不可因response.end已调用就移除；并发最多4项。10秒读取或清理期限，停用先拒绝新请求、取消自己I/O与未完成response，再等待实际fd/传输收尾；失败 `IMAGE_CLEANUP_FAILED`，保留活动和插件，显式重试只清理、不重放请求。HTTP断开亦清理自身资源。

客户端先验证元数据、原始响应头/实际大小和SHA-256，再创建自有Blob URL。请求有15秒截止且可取消，不自动重试读/写；切换目标前后通过project/path/version身份丢弃迟到内容。组件只读，不将空占位内容或图片字节交给文本保存/恢复；停用显示可操作回退，开启后重新加载。Blob URL仅用于img-src，脚本CSP仍为self；卸载、失败、切图或关闭时撤销对应URL。

`IMAGE_UNSUPPORTED` 等格式回退可保留文件信息/系统打开；`IMAGE_CHANGED`、权限/真实读取错误和替换提供者的错误元数据不能伪装成普通无预览能力。不得把路由声明/配置启用冒充实际解码或传输完成。


数据目录锁由宿主独占，保持 proper-lockfile 的30秒stale/5秒heartbeat与原始compromised检测。首次失锁记为DATA_LOCK_LOST并保留cause仅供本地排查；正常重复release仍拒绝，不忽略ERELEASED。失锁后新入场和上传完成后的操作均拒绝；初始化期间失锁也等待收尾并拒绝startup，不返回可操作host。运行期结束SSE与资源，关闭报告原失锁原因而非二次release症状。该行为没有修复外部进程改写mtime，也不授权自动续锁或重放任务。

## 事件缓冲与原生状态优先级

事件负载结构保持不变。宿主 EventClients 按连接 FIFO 发帧；write(false) 的当前帧已被接收，后续帧等待 drain，不重复发送。连接的 pendingBytes 与 response.writableLength 合计限制8MiB、pending帧最多256、单帧4MiB，连续阻塞10秒销毁该连接；关闭释放自己的队列、监听器与计时器，不妨碍其它连接。限制不包括序列化之前的对象、瞬时序列化内存或内核 TCP 缓冲。异常断流仍通过既有只读补同步恢复，不承诺中间事件重放。

外观对队列变更后的 GET 使用开始时的原生队列版本，期间有新原生事件则拒绝旧结果；失败后的只读补 GET 同样处理。发送消息 HTTP ACK 只在同会话、同历史代际且没有更新原生事件时乐观标记 running，不能复活已完成的回合。业务写入不会因此自动重试。历史等价记录可保留引用身份，但每次原生事件仍更新 liveSequence/liveVersions；JSON 所有权复制后冻结，不冻结调用者数据。

## 外观插件的键盘状态

这些行为均属于可替换外观，不写入桌面壳：Dropdown portal以触发按钮的页面Tab顺序退场，禁用/卸载清理自己RAF、ResizeObserver、搜索timer及窗口监听器；同一菜单关闭后清空typeahead前缀，中文组合键保留输入法默认处理。原生状态更新移除/禁用已聚焦选项时，将焦点留在可操作菜单，不能因body获得焦点失去Escape。公共keyboard helper只判断事件标志与兼容码，无时间窗猜测。

submit入口与发送按钮共用引擎归属限制，不能通过Enter或直接表单触发跨引擎请求，不自动切换内核或重发。AgentPanel使用是否存在运行中智能体的布尔值管理1秒显示刷新，普通session数组更新不重置timer；首render和focus/visible恢复按当前wall clock计算，停用或无运行项时清理监听。没有改变会话执行或模型计费语义。


## MCP 表单提供者

`host.approvals.registerHandler(method, normalize)` 注册同步响应构造器，返回代次安全、可重复调用的移除函数。同方法只能有一个活动处理器；插件应通过 `ctx.effect` 绑定这个移除函数，并用 `host.registerFeature('feature-mcp-forms')` 声明实际界面能力。内置提供者在 `server/plugins/feature-mcp-forms.mjs`。返回 Promise/thenable、异常 then getter 或非对象被拒绝，且拒绝 Promise 已被消费，不允许它成为宿主未处理拒绝。此接口用于同步校验与原生结果构造，不在其中启动工具或后台任务。

内置 `mcpElicitationResult(request,body)` 使用 shared/mcp-elicitation.js 的同一有限 schema 校验。HTTP 回应沿用 `{allow:boolean}`，MCP 增加 `elicitationAction:accept|decline|cancel`；接受还需严格 typed `content`。allow 与动作不一致拒绝。未指定动作时 true 对应 accept、false 对应 decline；关闭界面显式发送 cancel。原生回应为 `{action,content,_meta:null}`，拒绝/取消的 content 为 null。原生 AppServer 的下游 RMCP 序列化可能省略 content:null，不把这当成丢值。

没有活动处理器时，默认桥接仅允许 MCP decline/cancel，不允许接受。插件停用释放自己的注册，原生 MCP 服务及未结束请求仍由引擎/审批桥管理；不能将表单插件停用描述为已经关闭整个 MCP 服务。恢复时原请求可重新填写；回答不进入 state、preferences 或 SSE。处理器不能把答案写入公开记录，外部提供者应保留此契约。

标准 form 的平面字段、严格 typed 内容与限制以 shared/mcp-elicitation.js 为准；format、未知 schema 关键词、嵌套及扩展/URL问询不支持。UI 数字文本转换与服务端 typed 校验分开，服务端拒绝数字字符串。默认值不构造内容，required 只表示必须有 own 字段，不自动强制非空；字符串长度按 Unicode 字符、容量按 UTF-8 字节。

### Bundled messaging plugins

`channel-feishu`, `channel-qq`, `channel-weixin`, `channel-dingtalk`, `channel-wecom` are independently enabled feature plugins. They register `/api/channels/<platform>` plus configure/connect/disconnect, QR and explicit outbox resolution routes. They use the same local capability and cookie authorization as other routes; there is no unauthenticated inbound HTTP endpoint. The host supplies `TaskRecovery`, native sessions, transcript reads and before-stop lifecycle hooks. `session.channel` records platform/binding/peer/chat/type for persistent IM categorization. `channel-runtime` is a generated copy of the adjacent authoritative `dsh-channel-runtime` directory.


## 自我开发与版本恢复（2026-10-26）

设置 → 插件 → 自我开发：可创建/编辑草稿、检查源码、热加载、查看版本和恢复旧版。每次应用使用独立的代码目录，不覆盖正在使用的文件；最多展示最近 30 个版本，旧文件不自动删除。版本还原不会还原聊天、记忆、agent Markdown 或插件已写到外部的文件。

三个引擎均提供 `dsh_plugins`。先 `guide`，然后 `create`/`checkout` → `files`/`read` → `write` → `validate` → `apply`。每次写入返回新 `digest`；write/validate/apply 必须传确切 digest，apply/rollback 另需当前 `expectedRevision`（未安装用 `new`）。相对路径与大小有界检查，不接受目录穿越、符号链接和旧摘要覆盖。validate 仅检查语法、不执行代码；apply 才执行插件并跑注册的自检。

用户在设置中授权指定聊天后，该聊天才可写入、应用、回退和执行插件工具；撤销会阻止新操作及尚未应用的更新。授权跟随稳定聊天 ID，切换引擎保留；fork 不继承授权。IM、定时任务、已停止/归档聊天和子智能体不能使用该写入通道。Codex 用独立 bearer + 每会话 token 的 MCP；其他引擎通过同一宿主校验器调用。插件本身是可信 Node 代码，不是 OS 安全沙箱，不应让不可信插件处理敏感数据。

新增 `host.registerTool({name,description,inputSchema,execute})`，name 是连字符 ID。工具通过 `dsh_plugins tools/call` 实时可见，不必重启聊天。`execute(input,{signal,sessionId})` 返回 JSON 值，输入业务错误应返回结构化结果或带 code 的错误；未分类异常视为插件故障，当前版本有上一版则自动恢复，没有则停用。插件工具执行中禁止卸载/更新，避免双份运行。

新增 `host.registerHealthCheck(async()=>boolean)`：应用前检查，运行后每 30 秒复查；false/异常触发恢复。检查须有界返回，资源始终通过 Cordis effect 和 before-stop 钩子回收。异步清理拒绝时保留原插件并报告，不能伪装热更新成功。

`plugins.json` 的 pending 记录在拆旧版本之前持久化；未提交就退出时，下次启动先还原旧指针，再加载任何外部代码。代码摘要不符或重启加载失败时尝试最近完整版本。提交文件失败会撤销新注册并恢复原运行版本。外观更新还需独立 shell 确认异步 mount 成功；挂载/资源加载失败自动撤销，⌘⌥P 可进入独立恢复面板。资源 URL 含 revision 路径，嵌套 JS/CSS 相对引用也随版本更新。

热更新作用于外部功能/工具/界面/引擎提供者。当前引擎、聊天与集成基础提供者须先在设置停止引擎再更新，避免终止运行中的任务或覆盖用户的停止意图；恢复执行由用户显式启动。修改宿主启动器、Electron 二进制或内置模块仍走构建和重启发布。阻塞 Node 事件循环的死循环、未登记的模块顶层副作用及外部数据迁移，不能承诺在线无损恢复。
