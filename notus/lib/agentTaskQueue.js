const { getDb } = require('./db');

const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
const BLOCKING = new Set(['queued', 'running', 'waiting_interaction', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery']);

function asId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : null;
}

function parse(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function format(row) {
  if (!row) return null;
  return {
    id: Number(row.id), session_id: Number(row.session_id), conversation_id: Number(row.conversation_id),
    status: row.status, queue_order: Number(row.queue_order), input: parse(row.input_json, {}),
    llm_config_id: row.llm_config_id || null, approval_mode: row.approval_mode || 'auto_confirm',
    user_message_id: row.user_message_id ? Number(row.user_message_id) : null, run_id: row.run_id || null,
    attempt_count: Number(row.attempt_count || 0), last_error: parse(row.last_error_json),
    started_at: row.started_at || null, finished_at: row.finished_at || null,
    final_message_id: row.final_message_id ? Number(row.final_message_id) : null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function getTaskBySession(sessionId) {
  return format(getDb().prepare('SELECT * FROM agent_task_queue WHERE session_id = ?').get(asId(sessionId)));
}

function createTask({ sessionId, conversationId, input = {}, llmConfigId = null, approvalMode = 'auto_confirm', userMessageId = null } = {}) {
  const sid = asId(sessionId); const cid = asId(conversationId);
  if (!sid || !cid) throw Object.assign(new Error('session_id and conversation_id are required'), { code: 'AGENT_TASK_INPUT_INVALID' });
  const db = getDb();
  return db.transaction(() => {
    const exists = db.prepare('SELECT * FROM agent_task_queue WHERE session_id = ?').get(sid);
    if (exists) return format(exists);
    const queueOrder = Number(db.prepare('SELECT COALESCE(MAX(queue_order), 0) + 1 AS value FROM agent_task_queue WHERE conversation_id = ?').get(cid)?.value || 1);
    db.prepare(`INSERT INTO agent_task_queue (session_id, conversation_id, queue_order, input_json, llm_config_id, approval_mode, user_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sid, cid, queueOrder, JSON.stringify(input || {}), llmConfigId ? String(llmConfigId) : null, String(approvalMode || 'auto_confirm'), asId(userMessageId));
    return format(db.prepare('SELECT * FROM agent_task_queue WHERE session_id = ?').get(sid));
  })();
}

function getQueuePosition(sessionId) {
  const task = getTaskBySession(sessionId);
  if (!task) return null;
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM agent_task_queue
    WHERE conversation_id = ? AND queue_order <= ? AND status IN ('queued','running','waiting_interaction','waiting_limit_confirmation','waiting_retry','waiting_model_recovery')`)
    .get(task.conversation_id, task.queue_order);
  return Number(row?.count || 0);
}

function claimRunnableTasks() {
  const db = getDb();
  return db.transaction(() => {
    const candidates = db.prepare(`SELECT q.* FROM agent_task_queue q
      WHERE q.status = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM agent_task_queue earlier
        WHERE earlier.conversation_id = q.conversation_id AND earlier.queue_order < q.queue_order
          AND earlier.status NOT IN ('completed', 'cancelled', 'failed')
      ) ORDER BY q.created_at ASC, q.id ASC`).all();
    const update = db.prepare(`UPDATE agent_task_queue SET status = 'running', run_id = NULL, attempt_count = attempt_count + 1,
      started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now') WHERE id = ? AND status = 'queued'`);
    return candidates.filter((row) => update.run(row.id).changes).map((row) => format({ ...row, status: 'running', attempt_count: Number(row.attempt_count || 0) + 1 }));
  })();
}

function updateTask(sessionId, updates = {}) {
  const sid = asId(sessionId); const sets = []; const values = [];
  const add = (sql, value) => { sets.push(sql); values.push(value); };
  if (updates.status) add('status = ?', String(updates.status));
  if (Object.prototype.hasOwnProperty.call(updates, 'runId')) add('run_id = ?', updates.runId || null);
  if (Object.prototype.hasOwnProperty.call(updates, 'lastError')) add('last_error_json = ?', updates.lastError ? JSON.stringify(updates.lastError) : null);
  if (Object.prototype.hasOwnProperty.call(updates, 'finalMessageId')) add('final_message_id = ?', asId(updates.finalMessageId));
  if (updates.finished) sets.push("finished_at = datetime('now')");
  if (!sets.length) return getTaskBySession(sid);
  sets.push("updated_at = datetime('now')"); values.push(sid);
  getDb().prepare(`UPDATE agent_task_queue SET ${sets.join(', ')} WHERE session_id = ?`).run(...values);
  return getTaskBySession(sid);
}

function wakeTask(sessionId) {
  const sid = asId(sessionId);
  getDb().prepare(`UPDATE agent_task_queue SET status = 'queued', run_id = NULL, last_error_json = NULL,
    updated_at = datetime('now') WHERE session_id = ? AND status IN ('waiting_interaction','waiting_limit_confirmation','waiting_retry','waiting_model_recovery')`).run(sid);
  return getTaskBySession(sid);
}

function cancelTask(sessionId) {
  const sid = asId(sessionId);
  getDb().prepare("UPDATE agent_task_queue SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now') WHERE session_id = ? AND status NOT IN ('completed','cancelled','failed')").run(sid);
  return getTaskBySession(sid);
}

function recoverOrphanedTasks() {
  const db = getDb();
  const result = db.prepare("UPDATE agent_task_queue SET status = 'queued', run_id = NULL, updated_at = datetime('now') WHERE status = 'running'").run();
  return Number(result.changes || 0);
}

function listTasksByConversation(conversationId) {
  return getDb().prepare('SELECT * FROM agent_task_queue WHERE conversation_id = ? ORDER BY queue_order ASC').all(asId(conversationId)).map(format);
}

module.exports = { TERMINAL, BLOCKING, createTask, getTaskBySession, getQueuePosition, claimRunnableTasks, updateTask, wakeTask, cancelTask, recoverOrphanedTasks, listTasksByConversation };
