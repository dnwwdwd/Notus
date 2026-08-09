const { getDb } = require('./db');

const OPEN_SEGMENT_STATUSES = ['requesting', 'retrying', 'queued_resume', 'waiting_retry', 'waiting_model_recovery', 'dispatching_tools', 'waiting_operation_confirmation'];

function normalizePositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatWindow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    execution_segment_id: Number(row.execution_segment_id),
    window_no: Number(row.window_no),
    run_id: row.run_id || null,
    llm_config_id: row.llm_config_id || null,
    status: String(row.status || 'requesting'),
    retry_attempts: Number(row.retry_attempts || 0),
    retry_limit: Number(row.retry_limit || 0),
    error_category: row.error_category || null,
    error_code: row.error_code || null,
    started_at: row.started_at || null,
    updated_at: row.updated_at || null,
    finished_at: row.finished_at || null,
  };
}

function formatSegment(row, windows = null) {
  if (!row) return null;
  const result = {
    id: Number(row.id),
    session_id: Number(row.session_id),
    sequence_no: Number(row.sequence_no),
    loop_index: Number(row.loop_index),
    status: String(row.status || 'requesting'),
    label: String(row.label || ''),
    tool_names: parseJsonArray(row.tool_names_json),
    started_at: row.started_at || null,
    updated_at: row.updated_at || null,
    completed_at: row.completed_at || null,
  };
  if (windows) result.request_windows = windows;
  return result;
}

function getExecutionSegment(id) {
  const segmentId = normalizePositiveInt(id);
  if (!segmentId) return null;
  return formatSegment(getDb().prepare('SELECT * FROM agent_execution_segments WHERE id = ?').get(segmentId));
}

function getOpenExecutionSegment(sessionId) {
  const sid = normalizePositiveInt(sessionId);
  if (!sid) return null;
  const row = getDb().prepare(`
    SELECT * FROM agent_execution_segments
    WHERE session_id = ? AND status IN (${OPEN_SEGMENT_STATUSES.map(() => '?').join(',')})
    ORDER BY sequence_no DESC LIMIT 1
  `).get(sid, ...OPEN_SEGMENT_STATUSES);
  return formatSegment(row);
}

function beginExecutionSegment(sessionId, loopIndex, options = {}) {
  const sid = normalizePositiveInt(sessionId);
  if (!sid) throw new Error('session_id is required');
  const db = getDb();
  const reusable = options.reuseOpen !== false ? getOpenExecutionSegment(sid) : null;
  if (reusable) {
    db.prepare(`
      UPDATE agent_execution_segments
      SET loop_index = ?, status = 'requesting', updated_at = datetime('now')
      WHERE id = ?
    `).run(Math.max(0, Number(loopIndex) || 0), reusable.id);
    return getExecutionSegment(reusable.id);
  }
  const next = db.prepare('SELECT COALESCE(MAX(sequence_no), 0) + 1 AS value FROM agent_execution_segments WHERE session_id = ?').get(sid);
  const result = db.prepare(`
    INSERT INTO agent_execution_segments (session_id, sequence_no, loop_index, status, label)
    VALUES (?, ?, ?, 'requesting', ?)
  `).run(sid, Number(next?.value || 1), Math.max(0, Number(loopIndex) || 0), String(options.label || ''));
  return getExecutionSegment(result.lastInsertRowid);
}

function beginRequestWindow(executionSegmentId, options = {}) {
  const segmentId = normalizePositiveInt(executionSegmentId);
  if (!segmentId) throw new Error('execution_segment_id is required');
  const db = getDb();
  const next = db.prepare('SELECT COALESCE(MAX(window_no), 0) + 1 AS value FROM agent_llm_request_windows WHERE execution_segment_id = ?').get(segmentId);
  const result = db.prepare(`
    INSERT INTO agent_llm_request_windows (
      execution_segment_id, window_no, run_id, llm_config_id, retry_limit
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    segmentId,
    Number(next?.value || 1),
    String(options.runId || '') || null,
    String(options.llmConfigId || '') || null,
    Math.max(0, Number(options.retryLimit) || 0)
  );
  return formatWindow(db.prepare('SELECT * FROM agent_llm_request_windows WHERE id = ?').get(result.lastInsertRowid));
}

function recordRequestRetry(requestWindowId, attempt, error = {}) {
  const id = normalizePositiveInt(requestWindowId);
  if (!id) return null;
  const db = getDb();
  db.prepare(`
    UPDATE agent_llm_request_windows
    SET status = 'retrying', retry_attempts = ?, error_category = ?, error_code = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    Math.max(0, Number(attempt) || 0),
    String(error.category || '') || null,
    String(error.code || error.publicCode || '') || null,
    id
  );
  db.prepare(`
    UPDATE agent_execution_segments SET status = 'retrying', updated_at = datetime('now')
    WHERE id = (SELECT execution_segment_id FROM agent_llm_request_windows WHERE id = ?)
  `).run(id);
  return formatWindow(db.prepare('SELECT * FROM agent_llm_request_windows WHERE id = ?').get(id));
}

function finishRequestWindow(requestWindowId, status, error = {}) {
  const id = normalizePositiveInt(requestWindowId);
  if (!id) return null;
  const db = getDb();
  db.prepare(`
    UPDATE agent_llm_request_windows
    SET status = ?, error_category = ?, error_code = ?, updated_at = datetime('now'), finished_at = datetime('now')
    WHERE id = ?
  `).run(
    String(status || 'completed'),
    String(error.category || '') || null,
    String(error.code || error.publicCode || '') || null,
    id
  );
  return formatWindow(db.prepare('SELECT * FROM agent_llm_request_windows WHERE id = ?').get(id));
}

function updateExecutionSegment(id, updates = {}) {
  const segmentId = normalizePositiveInt(id);
  if (!segmentId) return null;
  const sets = [];
  const values = [];
  if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
    sets.push('status = ?');
    values.push(String(updates.status || 'requesting'));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'label')) {
    sets.push('label = ?');
    values.push(String(updates.label || ''));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'toolNames')) {
    sets.push('tool_names_json = ?');
    values.push(JSON.stringify(Array.isArray(updates.toolNames) ? updates.toolNames : []));
  }
  if (updates.completed) sets.push("completed_at = datetime('now')");
  if (sets.length === 0) return getExecutionSegment(segmentId);
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE agent_execution_segments SET ${sets.join(', ')} WHERE id = ?`).run(...values, segmentId);
  return getExecutionSegment(segmentId);
}

function listExecutionSegments(sessionId) {
  const sid = normalizePositiveInt(sessionId);
  if (!sid) return [];
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_execution_segments WHERE session_id = ? ORDER BY sequence_no ASC').all(sid);
  const windowRows = db.prepare(`
    SELECT w.* FROM agent_llm_request_windows w
    JOIN agent_execution_segments s ON s.id = w.execution_segment_id
    WHERE s.session_id = ? ORDER BY s.sequence_no ASC, w.window_no ASC
  `).all(sid);
  const windowsBySegment = new Map();
  windowRows.forEach((row) => {
    const key = Number(row.execution_segment_id);
    const list = windowsBySegment.get(key) || [];
    list.push(formatWindow(row));
    windowsBySegment.set(key, list);
  });
  return rows.map((row) => formatSegment(row, windowsBySegment.get(Number(row.id)) || []));
}

module.exports = {
  beginExecutionSegment,
  beginRequestWindow,
  finishRequestWindow,
  getExecutionSegment,
  getOpenExecutionSegment,
  listExecutionSegments,
  recordRequestRetry,
  updateExecutionSegment,
};
