export const developmentErrors={
  PLUGIN_ENGINE_MUST_STOP:['更新当前引擎或聊天基础插件前，请先在设置中停止引擎；聊天会保留。','Stop the engine in Settings before updating its provider or core chat plugin. Chats are preserved.'],
  PLUGIN_UPDATE_FAILED:['新版本启动失败，已撤销此次更新并恢复原状态。','The new version could not start. The update was reverted.'],
  PLUGIN_BUSY:['插件仍在使用中，请在任务结束后重试。','The plugin is in use. Retry after the task finishes.'],
  PLUGIN_VERIFY_PENDING:['正在确认新界面能否正常加载，请稍候；可用 ⌘⌥P 打开恢复面板。','Waiting for the new interface to mount. Use ⌘⌥P for recovery.'],
  PLUGIN_REVISION_CHANGED:['运行版本已经改变，请刷新后重试。','The running version changed. Refresh and retry.'],
  PLUGIN_DRAFT_CHANGED:['草稿已更新，请重新读取文件，避免覆盖其他修改。','The draft changed. Read it again before editing.'],
  PLUGIN_DRAFT_EXISTS:['已有草稿，已保留其中的修改，请打开后继续。','A draft already exists. Open it to continue without overwriting edits.'],
  PLUGIN_VALIDATION_FAILED:['检查未通过，请修复代码后再应用。','Validation failed. Fix the source before applying.'],
  PLUGIN_HEALTH_FAILED:['新插件自检失败，已恢复原版本。','The new plugin failed its health check. The previous version was restored.'],
  PLUGIN_APPEARANCE_FAILED:['新界面加载失败，已恢复原界面。','The new interface failed to load. The previous interface was restored.'],
  PLUGIN_INTERRUPTED:['上次更新未完成，已恢复更新前的插件。','The previous update was interrupted. The earlier plugin was restored.'],
  PLUGIN_ROLLBACK_FAILED:['插件恢复未完成，请保留文件并重新启动 DSH，或打开恢复面板。','Plugin recovery is incomplete. Keep the files and restart DSH or open recovery.'],
  PLUGIN_VERSION_UNKNOWN:['此版本不可用，请刷新版本记录。','This version is unavailable. Refresh the history.'],
  PLUGIN_TOOL_UNKNOWN:['此工具所属的插件已停用或更新，请重新读取工具列表。','The tool plugin was disabled or updated. Read the tool list again.'],
  PLUGIN_DEVELOPMENT_DENIED:['请先在“设置 → 插件 → 自我开发”中允许此聊天开发插件。','Grant this chat plugin development in Settings → Plugins → Self development.'],
  PLUGIN_CHAT_INACTIVE:['此聊天已停止或没有插件开发权限。IM、自动任务和子智能体不能修改插件。','This chat is inactive or cannot develop plugins. IM, scheduled tasks and subagents cannot modify plugins.'],
  PLUGIN_LIMIT:['插件超过大小或文件数量限制。','The plugin exceeds the size or file count limit.']
};
export const developmentLocales={
  'zh-CN':{
    process_plugin_active:'正在开发插件',process_plugin_done:'已使用插件工具',devTitle:'自我开发',devHelp:'让 DSH 在聊天中为自己编写工具、改进功能和界面。每次更新保存版本，启动或界面加载失败会自动恢复。',devGrant:'允许此聊天开发和应用插件',devGrantHelp:'仅授权所选聊天。插件会以 DSH 的本机权限运行；关闭后立即停止接受新修改。',devChat:'选择聊天',devNoChat:'先创建一个聊天',devCreate:'创建插件',devId:'插件 ID（如 my-helper）',devOpen:'打开草稿',devCheckout:'从运行版本创建草稿',devSelect:'选择一个插件',devFile:'文件',devNewFile:'输入相对路径以新增文件',devSave:'保存草稿',devValidate:'检查代码',devApply:'检查并热加载',devHistory:'版本记录',devRestore:'恢复此版本',devCurrent:'当前版本',devReady:'检查通过，可以应用',devApplied:'已热加载',devVerifying:'正在确认界面',devRolledBack:'已恢复上一版',devDirty:'有未保存的修改',devDiscard:'放弃当前尚未保存的代码修改？',devCode:'插件源代码',devEmpty:'创建插件后，可以让已授权的聊天继续编写。',devBoundary:'热更新覆盖插件、工具和界面。核心启动器更新仍需重启；回退不撤销插件对外部文件的写入。',devRecovery:'恢复面板：⌘⌥P',devVersionsEmpty:'应用后会在这里保存可恢复的版本。',devRefresh:'重新读取',devTemplate:'新插件已准备好，可在聊天中使用 dsh_plugins 继续开发。'
  },
  en:{
    process_plugin_active:'Developing plugins',process_plugin_done:'Used plugin tools',devTitle:'Self development',devHelp:'Let DSH build its own tools, features and interface in a chat. Updates keep version history and restore the previous version on startup or interface failure.',devGrant:'Allow this chat to develop and apply plugins',devGrantHelp:'Only the selected chat is granted access. Plugins run with DSH’s local permissions. Revoking stops new changes immediately.',devChat:'Select chat',devNoChat:'Create a chat first',devCreate:'Create plugin',devId:'Plugin ID (e.g. my-helper)',devOpen:'Open draft',devCheckout:'Create draft from running version',devSelect:'Select a plugin',devFile:'File',devNewFile:'Enter a relative path to add a file',devSave:'Save draft',devValidate:'Check code',devApply:'Check and hot-load',devHistory:'Version history',devRestore:'Restore version',devCurrent:'Current version',devReady:'Checks passed. Ready to apply.',devApplied:'Hot-loaded',devVerifying:'Verifying interface',devRolledBack:'Previous version restored',devDirty:'Unsaved changes',devDiscard:'Discard your unsaved source edits?',devCode:'Plugin source',devEmpty:'Create a plugin, then continue building it in an authorized chat.',devBoundary:'Hot updates cover plugins, tools and interfaces. Core launcher changes require a restart. Rollback does not undo writes to external files.',devRecovery:'Recovery: ⌘⌥P',devVersionsEmpty:'Recoverable versions appear here after applying.',devRefresh:'Reload source',devTemplate:'Your new plugin is ready. Continue developing with dsh_plugins in a chat.'
  }
};
