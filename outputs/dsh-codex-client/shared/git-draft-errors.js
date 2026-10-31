export const gitDraftErrors={
  GIT_DRAFT_CHANGED:['提交草稿已在其他窗口或进程中改变。当前输入已保留，请核对后再选择。','The commit draft changed in another window or process. Your input is preserved. Review it before continuing.'],
  GIT_DRAFT_INVALID:['提交草稿格式无效，请检查输入。','The commit draft is invalid. Check the input.'],
  GIT_DRAFT_LIMIT:['提交草稿超过恢复存储上限，当前输入尚未保存。','The commit draft exceeds the recovery storage limit. The current input was not saved.'],
  GIT_DRAFT_STORAGE_UNSAFE:['提交草稿位置异常，已保留原文件并停止写入。','The commit draft location is unsafe. The original file is preserved and writes stopped.'],
  GIT_DRAFT_CORRUPT:['提交草稿记录损坏，原文件已保留。Git 审阅仍可使用。','Commit draft records are corrupt. The original file is preserved. Git review remains available.'],
  GIT_DRAFT_READ_FAILED:['无法读取提交草稿，请保留输入并重试。','The commit draft could not be read. Keep your input and retry.'],
  GIT_DRAFT_WRITE_FAILED:['提交草稿未能保存，请保留当前输入后重试。','The commit draft could not be saved. Keep the current input and retry.'],
  GIT_DRAFT_CLOSED:['提交草稿服务已停用，请重新启用 Git 插件。','Commit draft storage is disabled. Enable the Git plugin again.'],
  GIT_DRAFT_BUSY:['另一个进程正在保存提交草稿，请稍后重试。','Another process is saving commit drafts. Retry shortly.'],
  GIT_DRAFT_PROTOCOL:['提交草稿服务返回了无法读取的记录。当前输入已保留，请重试。','Commit draft storage returned an unreadable record. Your input is preserved. Retry.'],
  GIT_DRAFT_UNAVAILABLE:['提交草稿服务暂时无法连接。当前输入已保留，请恢复连接后重试。','Commit draft storage is unavailable. Your input is preserved. Reconnect and retry.'],
};
