const { getDb } = require('./db');
const {
  DEFAULT_SCOPES,
  SCOPE_KEYS,
  normalizeConversationScopes,
  serializeScope,
} = require('./workspaceScope');

const DEFAULT_TITLE = '新对话';
const ACTIVE_AGENT_SESSION_STATUSES = [
  'waiting_interaction',
  'waiting_limit_confirmation',
  'waiting_retry',
  'waiting_model_recovery',
  'queued_resume',
  'running',
  'created',
];
const AGENT_SESSION_STATUS_PRIORITY_SQL = `
  CASE s.status
    WHEN 'waiting_interaction' THEN 0
    WHEN 'waiting_limit_confirmation' THEN 1
    WHEN 'waiting_retry' THEN 2
    WHEN 'waiting_model_recovery' THEN 2
    WHEN 'queued_resume' THEN 3
    WHEN 'running' THEN 4
    WHEN 'created' THEN 5
    ELSE 99
  END
`;

function normalizeKind(kind) {
  return kind === 'canvas' ? 'canvas' : 'knowledge';
}

function normalizeNullablePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

function normalizeDraftKey(value) {
  const next = String(value || '').trim();
  return next || null;
}

function normalizeLimit(value, fallback = 20, max = 100) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.min(Math.max(Math.floor(next), 1), max);
}

function buildConversationTitle(input) {
  const text = String(input || '').trim();
  return (text || DEFAULT_TITLE).slice(0, 40);
}

function toConversationRow(row) {
  if (!row) return null;
  const scopes = normalizeConversationScopes(row);
  return {
    ...row,
    id: Number(row.id),
    file_id: normalizeNullablePositiveInt(row.file_id),
    draft_key: normalizeDraftKey(row.draft_key),
    ...scopes,
    message_count: Number(row.message_count || 0),
    agent_session_count: Number(row.agent_session_count || 0),
    active_agent_session_count: Number(row.active_agent_session_count || 0),
    active_agent_status: String(row.active_agent_status || ''),
    preview: String(row.preview || ''),
    preview_role: row.preview_role || '',
  };
}

function parseMessageRow(row) {
  return {
    ...row,
    id: Number(row.id),
    conversation_id: Number(row.conversation_id),
    type: row.type || 'text',
    citations: row.citations ? JSON.parse(row.citations) : [],
    meta: row.meta ? JSON.parse(row.meta) : null,
  };
}

function getConversation(id) {
  const conversationId = normalizeNullablePositiveInt(id);
  if (!conversationId) return null;
  const db = getDb();
  return toConversationRow(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId));
}

function deleteConversation(id) {
  const conversation = getConversation(id);
  if (!conversation) return false;
  const db = getDb();
  const resultArtifacts = db.prepare(`
    SELECT relative_path
    FROM agent_tool_result_artifacts
    WHERE conversation_id = ? AND relative_path IS NOT NULL
  `).all(conversation.id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation.id);
  try {
    require('./agentToolResultStore').removeArtifactFiles(resultArtifacts);
  } catch {
    // 数据库已完成删除。未能删除的文件由启动清理器处理。
  }
  return true;
}

function listConversations({ kind = null, fileId, draftKey, query = '', limit = 20 } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];

  const normalizedKind = kind ? normalizeKind(kind) : null;
  const normalizedFileId = fileId === undefined ? undefined : normalizeNullablePositiveInt(fileId);
  const normalizedDraftKey = draftKey === undefined ? undefined : normalizeDraftKey(draftKey);
  const normalizedLimit = normalizeLimit(limit, 20, 100);

  if (normalizedKind) {
    conditions.push('c.kind = ?');
    params.push(normalizedKind);
  }

  if (fileId !== undefined) {
    if (normalizedFileId) {
      conditions.push('c.file_id = ?');
      params.push(normalizedFileId);
    } else {
      conditions.push('c.file_id IS NULL');
    }
  }

  if (draftKey !== undefined) {
    if (normalizedDraftKey) {
      conditions.push('c.draft_key = ?');
      params.push(normalizedDraftKey);
    } else {
      conditions.push('c.draft_key IS NULL');
    }
  }

  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (normalizedQuery) {
    const fuzzyQuery = `%${normalizedQuery}%`;
    conditions.push(`(
      LOWER(c.title) LIKE ?
      OR EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id
          AND m.role IN ('user', 'assistant')
          AND LOWER(m.content) LIKE ?
      )
    )`);
    params.push(fuzzyQuery, fuzzyQuery);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const activeStatusPlaceholders = ACTIVE_AGENT_SESSION_STATUSES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT
      c.*,
      COALESCE((SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant')), 0) AS message_count,
      COALESCE((SELECT COUNT(*) FROM agent_sessions s WHERE s.conversation_id = c.id), 0) AS agent_session_count,
      COALESCE((
        SELECT s.status
        FROM agent_sessions s
        WHERE s.conversation_id = c.id
          AND s.status IN (${activeStatusPlaceholders})
        ORDER BY ${AGENT_SESSION_STATUS_PRIORITY_SQL}, s.id ASC
        LIMIT 1
      ), '') AS active_agent_status,
      COALESCE((
        SELECT COUNT(*)
        FROM agent_sessions s
        WHERE s.conversation_id = c.id
          AND s.status IN (${activeStatusPlaceholders})
      ), 0) AS active_agent_session_count,
      COALESCE((SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant') ORDER BY m.id DESC LIMIT 1), '') AS preview,
      COALESCE((SELECT m.role FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant') ORDER BY m.id DESC LIMIT 1), '') AS preview_role
    FROM conversations c
    ${where}
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT ?
  `).all(...ACTIVE_AGENT_SESSION_STATUSES, ...ACTIVE_AGENT_SESSION_STATUSES, ...params, normalizedLimit);

  return rows.map(toConversationRow);
}

function createConversation({ kind = 'knowledge', title, fileId = null, draftKey = null, scopes = {} } = {}) {
  const db = getDb();
  const normalizedKind = normalizeKind(kind);
  const normalizedFileId = normalizeNullablePositiveInt(fileId);
  const normalizedDraftKey = normalizeDraftKey(draftKey);
  const normalizedScopes = normalizeConversationScopes({
    ...DEFAULT_SCOPES,
    ...scopes,
    write_scope: scopes.write_scope || (normalizedFileId
      ? { type: 'current_file', file_id: normalizedFileId }
      : DEFAULT_SCOPES.write_scope),
  });
  const result = db.prepare(`
    INSERT INTO conversations (
      kind, title, file_id, draft_key,
      read_scope, retrieval_scope, write_scope, style_scope,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    normalizedKind,
    buildConversationTitle(title),
    normalizedFileId,
    normalizedDraftKey,
    serializeScope(normalizedScopes.read_scope, DEFAULT_SCOPES.read_scope),
    serializeScope(normalizedScopes.retrieval_scope, DEFAULT_SCOPES.retrieval_scope),
    serializeScope(normalizedScopes.write_scope, DEFAULT_SCOPES.write_scope),
    serializeScope(normalizedScopes.style_scope, DEFAULT_SCOPES.style_scope)
  );
  return getConversation(result.lastInsertRowid);
}

function ensureConversation({ conversationId, kind = 'knowledge', title, fileId = null, draftKey = null, scopes = {} } = {}) {
  const existing = getConversation(conversationId);
  if (existing) return existing;
  return createConversation({ kind, title, fileId, draftKey, scopes });
}

function appendConversationMessage({ conversationId, role, type = 'text', content, citations = null, meta = null } = {}) {
  const db = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) {
    throw new Error('conversation_id is required');
  }
  const normalizedRole = ['user', 'assistant', 'tool', 'system'].includes(role) ? role : 'user';
  const normalizedType = String(type || 'text').trim() || 'text';
  const messageContent = String(content || '');
  const serializedCitations = citations === null || citations === undefined
    ? null
    : JSON.stringify(citations);
  const serializedMeta = meta === null || meta === undefined
    ? null
    : JSON.stringify(meta);

  const result = db.prepare(`
    INSERT INTO messages (conversation_id, role, type, content, citations, meta)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(normalizedConversationId, normalizedRole, normalizedType, messageContent, serializedCitations, serializedMeta);

  return Number(result.lastInsertRowid);
}

function touchConversation(conversationId) {
  const db = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) return;
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(normalizedConversationId);
}

function syncConversationBinding(conversationId, { fileId, draftKey, title } = {}) {
  const db = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) return null;

  const sets = [];
  const params = [];

  if (fileId !== undefined) {
    sets.push('file_id = ?');
    params.push(normalizeNullablePositiveInt(fileId));
  }

  if (draftKey !== undefined) {
    sets.push('draft_key = ?');
    params.push(normalizeDraftKey(draftKey));
  }

  if (title !== undefined) {
    sets.push('title = ?');
    params.push(buildConversationTitle(title));
  }

  if (sets.length === 0) {
    return getConversation(normalizedConversationId);
  }

  sets.push("updated_at = datetime('now')");
  db.prepare(`
    UPDATE conversations
    SET ${sets.join(', ')}
    WHERE id = ?
  `).run(...params, normalizedConversationId);

  return getConversation(normalizedConversationId);
}

function updateConversationScopes(conversationId, scopes = {}) {
  const db = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) return null;
  const existing = getConversation(normalizedConversationId);
  if (!existing) return null;
  const merged = normalizeConversationScopes({
    ...existing,
    ...scopes,
  });
  const sets = [];
  const params = [];

  SCOPE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(scopes, key)) {
      sets.push(`${key} = ?`);
      params.push(serializeScope(merged[key], DEFAULT_SCOPES[key]));
    }
  });

  if (sets.length === 0) return existing;
  sets.push("updated_at = datetime('now')");
  db.prepare(`
    UPDATE conversations
    SET ${sets.join(', ')}
    WHERE id = ?
  `).run(...params, normalizedConversationId);

  return getConversation(normalizedConversationId);
}

function resetConversationScopes(conversationId) {
  return updateConversationScopes(conversationId, DEFAULT_SCOPES);
}

function rebindDraftConversations({ kind = 'canvas', draftKey, fileId } = {}) {
  const db = getDb();
  const normalizedDraftKey = normalizeDraftKey(draftKey);
  const normalizedFileId = normalizeNullablePositiveInt(fileId);
  if (!normalizedDraftKey || !normalizedFileId) return 0;

  const result = db.prepare(`
    UPDATE conversations
    SET file_id = ?, draft_key = NULL, updated_at = datetime('now')
    WHERE kind = ? AND draft_key = ?
  `).run(normalizedFileId, normalizeKind(kind), normalizedDraftKey);

  return Number(result.changes || 0);
}

function getConversationMessages(conversationId) {
  const db = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) return [];
  const rows = db.prepare(`
    SELECT *
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
  `).all(normalizedConversationId);
  return rows.map(parseMessageRow);
}

function getConversationMessageById(messageId) {
  const db = getDb();
  const normalizedMessageId = normalizeNullablePositiveInt(messageId);
  if (!normalizedMessageId) return null;
  const row = db.prepare(`
    SELECT *
    FROM messages
    WHERE id = ?
  `).get(normalizedMessageId);
  return row ? parseMessageRow(row) : null;
}

function rewriteConversationFromMessage({ conversationId, messageId, content } = {}) {
  const db = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  const normalizedMessageId = normalizeNullablePositiveInt(messageId);
  if (!normalizedConversationId) throw new Error('conversation_id is required');
  if (!normalizedMessageId) throw new Error('message_id is required');

  const nextContent = String(content || '').trim();
  if (!nextContent) throw new Error('content is required');

  return db.transaction(() => {
    const anchor = db.prepare(`
      SELECT *
      FROM messages
      WHERE id = ? AND conversation_id = ? AND role = 'user'
    `).get(normalizedMessageId, normalizedConversationId);
    if (!anchor) {
      const error = new Error('目标用户消息不存在');
      error.code = 'MESSAGE_NOT_FOUND';
      throw error;
    }

    const previousMeta = anchor.meta ? JSON.parse(anchor.meta) : null;
    const nextMeta = {
      ...(previousMeta && typeof previousMeta === 'object' ? previousMeta : {}),
      rewritten: true,
      rewritten_at: new Date().toISOString(),
    };
    const previousUserQuery = String(previousMeta?.user_query || '').trim();
    const previousGoal = String(previousMeta?.agent_goal || '').trim();
    nextMeta.user_query = nextContent;
    if (previousGoal && previousUserQuery && previousGoal.endsWith(previousUserQuery)) {
      nextMeta.agent_goal = `${previousGoal.slice(0, -previousUserQuery.length)}${nextContent}`;
    }

    db.prepare(`
      UPDATE messages
      SET content = ?, meta = ?
      WHERE id = ?
    `).run(nextContent, JSON.stringify(nextMeta), normalizedMessageId);

    const futureRows = db.prepare(`
      SELECT id
      FROM messages
      WHERE conversation_id = ? AND id > ?
      ORDER BY id ASC
    `).all(normalizedConversationId, normalizedMessageId);
    const deletedMessageIds = futureRows.map((row) => Number(row.id));

    db.prepare(`
      DELETE FROM messages
      WHERE conversation_id = ? AND id > ?
    `).run(normalizedConversationId, normalizedMessageId);

    const cutoff = String(anchor.created_at || '');
    const cancelledSessionIds = db.prepare(`
      SELECT id
      FROM agent_sessions
      WHERE conversation_id = ?
        AND (created_at >= ? OR updated_at >= ?)
    `).all(normalizedConversationId, cutoff, cutoff).map((row) => Number(row.id));
    db.prepare(`
      UPDATE agent_sessions
      SET status = CASE
          WHEN status IN ('completed', 'failed', 'cancelled', 'rolled_back') THEN status
          ELSE 'cancelled'
        END,
        cancel_requested_at = CASE
          WHEN status IN ('completed', 'failed', 'cancelled', 'rolled_back') THEN cancel_requested_at
          ELSE datetime('now')
        END,
        messages_checkpoint = NULL,
        checkpoint_tool_use_id = NULL,
        updated_at = datetime('now')
      WHERE conversation_id = ?
        AND (created_at >= ? OR updated_at >= ?)
    `).run(normalizedConversationId, cutoff, cutoff);

    if (cancelledSessionIds.length > 0) {
      const placeholders = cancelledSessionIds.map(() => '?').join(', ');
      db.prepare(`
        UPDATE agent_task_queue
        SET status = 'cancelled',
            run_id = NULL,
            finished_at = COALESCE(finished_at, datetime('now')),
            updated_at = datetime('now')
        WHERE session_id IN (${placeholders})
          AND status NOT IN ('completed', 'failed', 'cancelled')
      `).run(...cancelledSessionIds);
    }

    db.prepare(`
      UPDATE conversation_interactions
      SET status = 'cancelled', updated_at = datetime('now')
      WHERE conversation_id = ?
        AND status IN ('pending', 'failed', 'stale')
        AND (
          COALESCE(message_id, 0) > ?
          OR COALESCE(answer_message_id, 0) > ?
          OR created_at >= ?
        )
    `).run(normalizedConversationId, normalizedMessageId, normalizedMessageId, cutoff);

    db.prepare(`
      UPDATE canvas_operation_sets
      SET status = CASE
          WHEN status IN ('applied', 'rolled_back', 'discarded', 'cancelled', 'superseded') THEN status
          ELSE 'cancelled'
        END,
        updated_at = datetime('now')
      WHERE conversation_id = ?
        AND (
          COALESCE(message_id, 0) > ?
          OR created_at >= ?
        )
    `).run(normalizedConversationId, normalizedMessageId, cutoff);

    touchConversation(normalizedConversationId);

    return {
      conversation: getConversation(normalizedConversationId),
      message: getConversationMessageById(normalizedMessageId),
      deleted_message_ids: deletedMessageIds,
      deleted_count: deletedMessageIds.length,
      cancelled_session_ids: cancelledSessionIds,
    };
  })();
}

function getConversationHistory(conversationId, { limit = 12, includeTool = false } = {}) {
  const db = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) return [];
  const normalizedLimit = normalizeLimit(limit, 12, 50);
  const roleClause = includeTool ? '' : "AND role IN ('user','assistant')";
  const rows = db.prepare(`
    SELECT *
    FROM messages
    WHERE conversation_id = ?
    ${roleClause}
      AND COALESCE(type, 'text') = 'text'
    ORDER BY id DESC
    LIMIT ?
  `).all(normalizedConversationId, normalizedLimit).reverse();

  return rows.map((row) => ({
    id: Number(row.id),
    role: row.role,
    content: String(row.content || ''),
    meta: row.meta ? JSON.parse(row.meta) : null,
  }));
}

module.exports = {
  buildConversationTitle,
  createConversation,
  appendConversationMessage,
  ensureConversation,
  getConversation,
  deleteConversation,
  getConversationMessageById,
  getConversationMessages,
  getConversationHistory,
  listConversations,
  rebindDraftConversations,
  rewriteConversationFromMessage,
  resetConversationScopes,
  syncConversationBinding,
  touchConversation,
  updateConversationScopes,
};
