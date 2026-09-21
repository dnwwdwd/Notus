// Session state is authoritative; individual failures remain in the expanded trace.
export function agentTraceState({ sessionStatus = '', loading = false, tailStatus = 'done', hasError = false } = {}) {
  if (sessionStatus === 'completed') return { label: '已处理', running: false, needsAction: false };
  if (sessionStatus === 'cancelled') return { label: '已取消', running: false, needsAction: false };
  const waiting = ['waiting_confirm', 'waiting_interaction', 'waiting_operation_confirmation', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery'].includes(sessionStatus);
  if (sessionStatus === 'failed' || waiting) return { label: '需要处理', running: false, needsAction: true };
  if (sessionStatus === 'queued') return { label: '任务已提交', running: true, needsAction: false };
  if (loading || ['created', 'running'].includes(sessionStatus)) return { label: '正在处理', running: true, needsAction: false };
  if (tailStatus === 'cancelled') return { label: '已取消', running: false, needsAction: false };
  const needsAction = hasError || ['waiting', 'action_required', 'failed', 'error', 'stopped'].includes(tailStatus);
  return { label: needsAction ? '需要处理' : '已处理', running: false, needsAction };
}
