const { EventEmitter } = require('events');
const { recordRunEvent } = require('./agentSession');

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
  const id = recordRunEvent({ sessionId, runId, event });
  return broadcast({ sessionId, runId, event, eventId: id });
}

function broadcast({ sessionId, runId = null, event = {}, eventId = null } = {}) {
  const payload = { ...event, session_id: Number(sessionId), run_id: runId || null, event_id: eventId };
  emitter.emit(`session:${sessionId}`, payload);
  return payload;
}

function subscribe(sessionId, listener) {
  const key = `session:${Number(sessionId)}`;
  emitter.on(key, listener);
  return () => emitter.off(key, listener);
}

module.exports = { publish, broadcast, subscribe };
