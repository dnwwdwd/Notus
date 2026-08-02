const { EventEmitter } = require('events');
const { recordRunEvent } = require('./agentSession');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

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
