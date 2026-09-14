// 使用现有会话读取权限获取目标任务票据，不把当前活动任务的凭据用于历史任务。
export async function refreshAgentSessionAccess(conversationId, sessionId, { signal } = {}) {
  if (!conversationId || !sessionId) throw new Error('缺少任务所属对话');
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { cache: 'no-store', signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '读取任务权限失败');
  const session = payload.agent_sessions?.find((item) => Number(item.id) === Number(sessionId));
  if (!session) throw new Error('该任务不属于当前对话');
  return session;
}
