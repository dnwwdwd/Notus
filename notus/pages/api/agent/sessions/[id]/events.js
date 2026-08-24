const { ensureRuntime } = require('../../../../../lib/runtime');
const { getSession, listRunEvents, validateSessionAccess } = require('../../../../../lib/agentSession');
const { issueCapability, validateCapability } = require('../../../../../lib/agentControlPlane');
const { subscribe, attachInteractionResumeTicket } = require('../../../../../lib/agentRunEventBus');
const { getTaskBySession, getQueuePosition } = require('../../../../../lib/agentTaskQueue');

function send(res, payload) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.flush?.();
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error?.message || '运行时不可用', code: 'RUNTIME_ERROR' });
  const sessionId = Number(req.query.id || 0);
  // capability 和 session token 都只能走请求头，不能进入 URL、浏览器历史或代理日志。
  const ticket = req.headers['x-agent-control-ticket'];
  const token = req.headers['x-agent-session-token'];
  const access = ticket ? validateCapability(ticket, { sessionId, action: 'session_read' }) : validateSessionAccess(sessionId, token);
  if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  const canIssueResumeTicket = !ticket;
  try { getSession(sessionId); } catch { return res.status(404).json({ error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND' }); }
  const after = Math.max(0, Number(req.query.after || 0) || 0);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, no-transform');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let cursor = after;
  const forward = (event) => {
    const id = Number(event.event_id || 0);
    if (id && id <= cursor) return;
    if (id) cursor = id;
    // session_read 只允许读取事件；只有持有该 session 原始 token 的连接，才可为
    // 待回答 interaction 取得一次性 respond 票据。
    send(res, attachInteractionResumeTicket(event, { sessionId, issueTicket: issueCapability, canIssueResumeTicket }));
  };
  // 先订阅再补发，避免读取与订阅之间丢失刚落库的事件；cursor 去重保证顺序。
  const unsubscribe = subscribe(sessionId, forward);
  listRunEvents(sessionId).filter((item) => item.id > cursor).forEach((item) => forward({ ...item.payload, session_id: sessionId, run_id: item.run_id, event_id: item.id, created_at: item.created_at }));
  const task = getTaskBySession(sessionId);
  send(res, { type: 'task_state', session_id: sessionId, status: task?.status || getSession(sessionId).status, queue_position: getQueuePosition(sessionId), task_id: task?.id || null });
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 15_000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
}
