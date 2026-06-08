const { getDb } = require('./db');
const {
  DEFAULT_SCOPES,
  SCOPE_KEYS,
  normalizeConversationScopes,
  serializeScope,
} = require('./workspaceScope');

const DEFAULT_TITLE = '新对话';

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
    preview: String(row.preview || ''),
    preview_role: row.preview_role || '',
  };
}

function parseMessageRow(row) {
  return {
    ...row,
    id: Number(row.id),
    conversation_id: Number(row.conversation_id),
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
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation.id);
  return true;
}

function listConversations({ kind = null, fileId, draftKey, limit = 20 } = {}) {
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      c.*,
      COALESCE((SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id), 0) AS message_count,
      COALESCE((SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1), '') AS preview,
      COALESCE((SELECT m.role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1), '') AS preview_role
    FROM conversations c
    ${where}
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT ?
  `).all(...params, normalizedLimit);

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

function appendConversationMessage({ conversationId, role, content, citations = null, meta = null } = {}) {
  const db = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) {
    throw new Error('conversation_id is required');
  }
  const normalizedRole = ['user', 'assistant', 'tool'].includes(role) ? role : 'user';
  const messageContent = String(content || '');
  const serializedCitations = citations === null || citations === undefined
    ? null
    : JSON.stringify(citations);
  const serializedMeta = meta === null || meta === undefined
    ? null
    : JSON.stringify(meta);

  const result = db.prepare(`
    INSERT INTO messages (conversation_id, role, content, citations, meta)
    VALUES (?, ?, ?, ?, ?)
  `).run(normalizedConversationId, normalizedRole, messageContent, serializedCitations, serializedMeta);

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
  resetConversationScopes,
  syncConversationBinding,
  touchConversation,
  updateConversationScopes,
};
