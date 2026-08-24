const { EventEmitter } = require('events');
const { recordRunEvent, sanitizeRunEvent } = require('./agentSession');

// Next.js 在开发模式和部分 server bundle 中可能多次加载此模块。Worker 与
// SSE Route 必须订阅同一个进程内事件源，否则持久化事件写入成功后，页面仍会
// 收不到实时通知并最终显示网络错误。
const EVENT_BUS_KEY = '__notus_agent_run_event_bus__';
const emitter = globalThis[EVENT_BUS_KEY] || (() => {
  const next = new EventEmitter();
  next.setMaxListeners(0);
  globalThis[EVENT_BUS_KEY] = next;
  return next;
})();

function publish({ sessionId, runId = null, event = {} } = {}) {
  const safeEvent = sanitizeRunEvent(event);
  if (!safeEvent) return null;
  const id = recordRunEvent({ sessionId, runId, event: safeEvent });
  return broadcast({ sessionId, runId, event: safeEvent, eventId: id });
}

function broadcast({ sessionId, runId = null, event = {}, eventId = null } = {}) {
  const payload = { ...event, session_id: Number(sessionId), run_id: runId || null, event_id: eventId };
  emitter.emit(`session:${sessionId}`, payload);
  return payload;
}

function attachInteractionResumeTicket(event = {}, { sessionId, issueTicket, canIssueResumeTicket = false } = {}) {
  const interactionId = Number(event?.interaction?.id || event?.interaction_id || 0);
  const isPendingInteraction = event?.type === 'artifact'
    && event?.artifact_type === 'interaction'
    && event?.interaction?.status === 'pending'
    && Number.isFinite(interactionId)
    && interactionId > 0;
  if (!canIssueResumeTicket || !isPendingInteraction || typeof issueTicket !== 'function') return event;
  const resumeTicket = issueTicket({ sessionId, interactionId, action: 'respond' });
  return resumeTicket ? { ...event, resume_ticket: resumeTicket } : event;
}

function subscribe(sessionId, listener) {
  const key = `session:${Number(sessionId)}`;
  emitter.on(key, listener);
  return () => emitter.off(key, listener);
}

module.exports = { publish, broadcast, subscribe, attachInteractionResumeTicket };
