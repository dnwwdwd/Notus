const { getDb } = require('./db');

const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
const BLOCKING = new Set(['queued', 'running', 'waiting_interaction', 'waiting_operation_confirmation', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery']);
const USER_ACTION_WAITING = ['waiting_interaction', 'waiting_operation_confirmation', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery'];
const SUPERSEDEABLE_SESSION_STATUSES = ['created', 'queued', ...USER_ACTION_WAITING];

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
    resume_job_id: row.resume_job_id || null,
    attempt_count: Number(row.attempt_count || 0), last_error: parse(row.last_error_json),
    resume_requested: Boolean(row.resume_requested),
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
    WHERE conversation_id = ? AND queue_order <= ? AND status IN ('queued','running','waiting_interaction','waiting_operation_confirmation','waiting_limit_confirmation','waiting_retry','waiting_model_recovery')`)
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
    const update = db.prepare(`UPDATE agent_task_queue SET status = 'running', run_id = NULL, resume_requested = 0, attempt_count = attempt_count + 1,
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
  if (Object.prototype.hasOwnProperty.call(updates, 'llmConfigId')) add('llm_config_id = ?', updates.llmConfigId ? String(updates.llmConfigId) : null);
  if (Object.prototype.hasOwnProperty.call(updates, 'finalMessageId')) add('final_message_id = ?', asId(updates.finalMessageId));
  if (Object.prototype.hasOwnProperty.call(updates, 'resumeJobId')) add('resume_job_id = ?', updates.resumeJobId ? String(updates.resumeJobId) : null);
  if (updates.finished) sets.push("finished_at = datetime('now')");
  if (!sets.length) return getTaskBySession(sid);
  sets.push("updated_at = datetime('now')"); values.push(sid);
  const statusGuard = updates.status === 'cancelled' ? '' : " AND status != 'cancelled'";
  getDb().prepare(`UPDATE agent_task_queue SET ${sets.join(', ')} WHERE session_id = ?${statusGuard}`).run(...values);
  return getTaskBySession(sid);
}

function wakeTask(sessionId, { llmConfigId = null, resumeJobId = undefined } = {}) {
  const sid = asId(sessionId);
  const resumeJobPatch = resumeJobId === undefined ? '' : ', resume_job_id = ?';
  const values = [llmConfigId ? String(llmConfigId) : null];
  if (resumeJobId !== undefined) values.push(resumeJobId ? String(resumeJobId) : null);
  values.push(sid);
  getDb().prepare(`UPDATE agent_task_queue SET status = 'queued', run_id = NULL, last_error_json = NULL,
    llm_config_id = COALESCE(?, llm_config_id)${resumeJobPatch}, updated_at = datetime('now')
    WHERE session_id = ? AND status IN ('waiting_interaction','waiting_operation_confirmation','waiting_limit_confirmation','waiting_retry','waiting_model_recovery')`).run(...values);
  return getTaskBySession(sid);
}

function requestTaskResume(sessionId) {
  const sid = asId(sessionId);
  if (!sid) return null;
  const db = getDb();
  db.prepare(`
    UPDATE agent_task_queue
    SET status = CASE
          WHEN status IN ('waiting_interaction','waiting_operation_confirmation','waiting_limit_confirmation','waiting_retry','waiting_model_recovery') THEN 'queued'
          ELSE status
        END,
        resume_requested = CASE WHEN status = 'running' THEN 1 ELSE 0 END,
        run_id = CASE
          WHEN status IN ('waiting_interaction','waiting_operation_confirmation','waiting_limit_confirmation','waiting_retry','waiting_model_recovery') THEN NULL
          ELSE run_id
        END,
        last_error_json = NULL,
        updated_at = datetime('now')
    WHERE session_id = ? AND status NOT IN ('completed','cancelled','failed')
  `).run(sid);
  return getTaskBySession(sid);
}

function settleTaskRun(sessionId, status, { finished = false } = {}) {
  const sid = asId(sessionId);
  if (!sid) return null;
  const requestedStatus = String(status || 'failed');
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare('SELECT resume_requested FROM agent_task_queue WHERE session_id = ?').get(sid);
    const shouldResume = Boolean(row?.resume_requested) || requestedStatus === 'queued_resume';
    db.prepare(`
      UPDATE agent_task_queue
      SET status = ?, run_id = NULL, resume_requested = 0,
          finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END,
          updated_at = datetime('now')
      WHERE session_id = ? AND status != 'cancelled'
    `).run(shouldResume ? 'queued' : requestedStatus, finished && !shouldResume ? 1 : 0, sid);
  })();
  return getTaskBySession(sid);
}

function cancelTask(sessionId) {
  const sid = asId(sessionId);
  getDb().prepare("UPDATE agent_task_queue SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now') WHERE session_id = ? AND status NOT IN ('completed','cancelled','failed')").run(sid);
  return getTaskBySession(sid);
}

function supersedePendingUserActionTasks(conversationId) {
  const cid = asId(conversationId);
  if (!cid) return [];
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT q.session_id
      FROM agent_task_queue q
      INNER JOIN agent_sessions s ON s.id = q.session_id
      WHERE q.conversation_id = ?
        AND q.status IN ('created', 'queued', 'waiting_interaction', 'waiting_operation_confirmation', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery')
        AND s.status IN ('created', 'queued', 'waiting_interaction', 'waiting_operation_confirmation', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery')
      ORDER BY q.queue_order ASC
    `).all(cid);
    const sessionIds = rows.map((row) => Number(row.session_id)).filter(Boolean);
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(', ');
    db.prepare(`
      UPDATE agent_sessions
      SET status = 'cancelled',
          cancel_requested_at = datetime('now'),
          active_run_id = NULL,
          lease_expires_at = NULL,
          state_version = state_version + 1,
          updated_at = datetime('now')
      WHERE id IN (${placeholders})
        AND status IN ('created', 'queued', 'waiting_interaction', 'waiting_operation_confirmation', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery')
    `).run(...sessionIds);
    db.prepare(`
      UPDATE agent_task_queue
      SET status = 'cancelled',
          run_id = NULL,
          finished_at = COALESCE(finished_at, datetime('now')),
          updated_at = datetime('now')
      WHERE session_id IN (${placeholders})
        AND status IN ('created', 'queued', 'waiting_interaction', 'waiting_operation_confirmation', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery')
    `).run(...sessionIds);
    db.prepare(`
      UPDATE conversation_interactions
      SET status = 'cancelled', updated_at = datetime('now')
      WHERE conversation_id = ?
        AND status IN ('pending', 'failed', 'stale')
    `).run(cid);
    return sessionIds;
  })();
}

function recoverOrphanedTasks() {
  const db = getDb();
  return db.transaction(() => {
    const missingSession = db.prepare(`
      UPDATE agent_task_queue
      SET status = 'cancelled',
          run_id = NULL,
          finished_at = COALESCE(finished_at, datetime('now')),
          updated_at = datetime('now')
      WHERE status NOT IN ('completed', 'cancelled', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM agent_sessions s WHERE s.id = agent_task_queue.session_id
        )
    `).run();
    const reconciled = db.prepare(`
      UPDATE agent_task_queue
      SET status = CASE (
            SELECT s.status
            FROM agent_sessions s
            WHERE s.id = agent_task_queue.session_id
          )
            WHEN 'rolled_back' THEN 'cancelled'
            ELSE (
              SELECT s.status
              FROM agent_sessions s
              WHERE s.id = agent_task_queue.session_id
            )
          END,
          run_id = NULL,
          finished_at = COALESCE(finished_at, datetime('now')),
          updated_at = datetime('now')
      WHERE status NOT IN ('completed', 'cancelled', 'failed')
        AND EXISTS (
          SELECT 1
          FROM agent_sessions s
          WHERE s.id = agent_task_queue.session_id
            AND s.status IN ('completed', 'cancelled', 'failed', 'rolled_back')
        )
    `).run();
    const recovered = db.prepare("UPDATE agent_task_queue SET status = 'queued', run_id = NULL, updated_at = datetime('now') WHERE status = 'running'").run();
    return Number(missingSession.changes || 0) + Number(reconciled.changes || 0) + Number(recovered.changes || 0);
  })();
}

function listTasksByConversation(conversationId) {
  return getDb().prepare('SELECT * FROM agent_task_queue WHERE conversation_id = ? ORDER BY queue_order ASC').all(asId(conversationId)).map(format);
}

module.exports = { TERMINAL, BLOCKING, USER_ACTION_WAITING, SUPERSEDEABLE_SESSION_STATUSES, createTask, getTaskBySession, getQueuePosition, claimRunnableTasks, updateTask, wakeTask, requestTaskResume, settleTaskRun, cancelTask, supersedePendingUserActionTasks, recoverOrphanedTasks, listTasksByConversation };
