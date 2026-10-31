export const engineLocales={
 'zh-CN':{engineLabel:'执行引擎',engineName_codex:'Codex',engineName_dsh_native:'DSH 原生',engineName_claude_code:'Claude Code',engineCurrent:'正在使用',engineSwitching:'正在交接会话…',engineSwitchHelp:'在 DSH 原生、Codex 和 Claude Code 之间切换。聊天历史与智能体设定随会话保留；执行中的任务完成后切换。',engineMenuHint:'共用聊天历史、设定与记忆',enginePending:'任务结束后切换至 {engine}',engineCancelPending:'保留当前引擎',engineSwitchDone:'已切换至 {engine}',engineDetail_dsh_native:'DeepSeek Harness 原生执行循环',engineDetail_codex:'Codex 工具与工作区执行',engineDetail_claude_code:'Claude Code 文件与项目执行'},
 en:{engineLabel:'Execution engine',engineName_codex:'Codex',engineName_dsh_native:'DSH Native',engineName_claude_code:'Claude Code',engineCurrent:'In use',engineSwitching:'Transferring conversation…',engineSwitchHelp:'Switch between DSH Native, Codex and Claude Code. Conversation history and agent settings stay with each chat. Active tasks finish before switching.',engineMenuHint:'Shared history, settings and memory',enginePending:'Switch to {engine} after the task finishes',engineCancelPending:'Keep current engine',engineSwitchDone:'Switched to {engine}',engineDetail_dsh_native:'DeepSeek Harness native agent loop',engineDetail_codex:'Codex tools and workspace execution',engineDetail_claude_code:'Claude Code file and project execution'}
};
export const engineErrors={
 ENGINE_SWITCHING:['正在交接会话，请稍候。草稿已保留。','Conversation transfer is in progress. Your draft is preserved.'],
 CONTEXT_TOO_LARGE:['会话或设定超过完整交接上限。已保留原引擎，未截断上下文。','The conversation or settings exceed the complete transfer limit. The original engine is preserved; no context was truncated.'],
 CONTEXT_IMAGE_UNSUPPORTED:['此聊天包含图片，暂不能完整交接到另一引擎。已保留原引擎和全部记录。','This chat contains images that cannot yet be fully transferred. The original engine and all records are preserved.'],
 CONTEXT_INVALID:['会话交接记录无法核实，已保留原记录。','The conversation transfer record could not be verified. Original records are preserved.']
};
