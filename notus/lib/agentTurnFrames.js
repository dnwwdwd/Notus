const { getDb } = require('./db');
const { sha256 } = require('./files');

function asId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : null;
}

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function formatFrame(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    conversation_id: asId(row.conversation_id),
    session_id: asId(row.session_id),
    task_id: asId(row.task_id),
    source_message_id: asId(row.source_message_id),
    parent_frame_id: asId(row.parent_frame_id),
    frame_version: Number(row.frame_version || 1),
    schema_version: Number(row.schema_version || 1),
    confidence: Number(row.confidence || 0),
    facts: parseJson(row.facts_json, {}),
    intent: parseJson(row.intent_json, {}),
    provenance: parseJson(row.provenance_json, {}),
  };
}

function getTurnFrame(id, database = getDb()) {
  return formatFrame(database.prepare('SELECT * FROM agent_turn_frames WHERE id = ?').get(asId(id)));
}

function getTaskTurnFrame(taskId, database = getDb()) {
  const row = database.prepare(`
    SELECT frame.*
    FROM agent_task_turn_frames binding
    INNER JOIN agent_turn_frames frame ON frame.id = binding.turn_frame_id
    WHERE binding.task_id = ?
  `).get(asId(taskId));
  return formatFrame(row);
}

function getSessionTurnFrame(sessionId, database = getDb()) {
  const row = database.prepare(`
    SELECT frame.*
    FROM agent_turn_frames frame
    WHERE frame.session_id = ?
    ORDER BY frame.frame_version DESC, frame.id DESC
    LIMIT 1
  `).get(asId(sessionId));
  return formatFrame(row);
}

function createTurnFrame({ conversationId, sessionId = null, taskId = null, sourceMessageId = null, parentFrameId = null, changeReason = 'initial', facts = {}, intent = {}, provenance = {}, confidence = 0, fingerprint = '' } = {}) {
  const cid = asId(conversationId);
  const tid = asId(taskId);
  if (!cid) throw Object.assign(new Error('conversation_id is required'), { code: 'TURN_FRAME_CONVERSATION_REQUIRED' });
  const database = getDb();
  return database.transaction(() => {
    const previous = tid ? getTaskTurnFrame(tid, database) : null;
    const version = previous ? previous.frame_version + 1 : 1;
    const parentId = asId(parentFrameId) || previous?.id || null;
    const normalizedFingerprint = String(fingerprint || sha256(JSON.stringify({ facts, intent }))).slice(0, 128);
    if (previous) {
      database.prepare("UPDATE agent_turn_frames SET status = 'superseded', updated_at = datetime('now') WHERE id = ?")
        .run(previous.id);
    }
    const result = database.prepare(`
      INSERT INTO agent_turn_frames (
        conversation_id, session_id, task_id, source_message_id, parent_frame_id,
        frame_version, schema_version, status, change_reason, facts_json,
        intent_json, provenance_json, confidence, fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      cid,
      asId(sessionId),
      tid,
      asId(sourceMessageId),
      parentId,
      version,
      String(changeReason || 'initial'),
      JSON.stringify(facts || {}),
      JSON.stringify(intent || {}),
      JSON.stringify(provenance || {}),
      Math.min(Math.max(Number(confidence) || 0, 0), 1),
      normalizedFingerprint
    );
    if (tid) {
      database.prepare(`
        INSERT INTO agent_task_turn_frames (task_id, turn_frame_id, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(task_id) DO UPDATE SET
          turn_frame_id = excluded.turn_frame_id,
          updated_at = datetime('now')
      `).run(tid, Number(result.lastInsertRowid));
    }
    return getTurnFrame(result.lastInsertRowid, database);
  })();
}

function updateTurnFrame(id, { facts, intent, provenance, confidence, status } = {}) {
  const frameId = asId(id);
  const current = getTurnFrame(frameId);
  if (!current) return null;
  const sets = [];
  const params = [];
  const add = (sql, value) => { sets.push(sql); params.push(value); };
  if (facts !== undefined) add('facts_json = ?', JSON.stringify(facts || {}));
  if (intent !== undefined) add('intent_json = ?', JSON.stringify(intent || {}));
  if (provenance !== undefined) add('provenance_json = ?', JSON.stringify(provenance || {}));
  if (confidence !== undefined) add('confidence = ?', Math.min(Math.max(Number(confidence) || 0, 0), 1));
  if (status !== undefined) add('status = ?', String(status || 'active'));
  if (!sets.length) return current;
  sets.push("updated_at = datetime('now')");
  params.push(frameId);
  getDb().prepare(`UPDATE agent_turn_frames SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getTurnFrame(frameId);
}

module.exports = {
  createTurnFrame,
  getSessionTurnFrame,
  getTaskTurnFrame,
  getTurnFrame,
  updateTurnFrame,
};
