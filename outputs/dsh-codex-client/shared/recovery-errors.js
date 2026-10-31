export const recoveryErrors={
  TASK_RECOVERY_PENDING:['此任务正在恢复，请先停止或等待恢复后再发送。','This task is recovering. Stop it or wait for recovery before sending.'],
  TASK_STATE_UNVERIFIED:['尚未核实上一轮是否结束，已保留任务。请稍后重试继续任务。','The previous turn has not been verified as ended. The task is preserved. Retry Resume later.'],
  TASK_NOT_RESUMABLE:['此任务已经完成或仍在执行。','This task is already complete or still running.'],
  TASK_QUEUE_PENDING:['此聊天仍有排队消息，请先处理消息队列。','This chat still has queued messages. Resolve the queue first.'],
  TASK_RECOVERY_STORAGE:['未能保存任务恢复状态，已暂停自动续跑，请检查磁盘后重试。','Task recovery state could not be saved. Automatic continuation is paused. Check the disk and retry.'],
  TURN_STATE_UNKNOWN:['上一轮请求的结果尚未核实，请先核对任务状态。','The outcome of the previous request is unverified. Check the task state first.'],
  INTERRUPT_TIMEOUT:['停止请求尚未确认，任务仍被保留，暂不能重复启动。','The stop request has not been confirmed. The task is retained and cannot be started again yet.'],
  IDLE_TIMEOUT:['执行引擎长时间未返回进展，任务已保留。','The engine did not report progress before the idle deadline. The task is preserved.'],
};

export function continuationText(locale='zh-CN'){
  return locale.startsWith('zh')
    ? '继续完成本聊天中尚未完成的任务。先根据已有对话、工具结果和当前文件核对已完成的工作，从中断处继续。不要重复执行已经成功的写入、提交、发送或其他外部操作；结果不明确时先核实，无法核实就询问我。沿用原任务范围和权限，完成后验证结果。'
    : 'Continue the unfinished task in this chat. First inspect the existing conversation, tool results, and current files to establish what already completed, then continue from the interruption. Do not repeat successful writes, commits, sends, or other external actions. Verify uncertain results first and ask me if they cannot be verified. Keep the original scope and permissions, and validate the result when finished.';
}
