const { getDb } = require('./db');
const { sha256 } = require('./files');

const DEFAULT_EXPIRE_DAYS = 7;
const ACTIVE_STATUSES = ['pending', 'stale'];
const TERMINAL_STATUSES = ['applied', 'cancelled'];

function normalizeNullablePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function normalizeStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  if ([...ACTIVE_STATUSES, ...TERMINAL_STATUSES].includes(normalized)) return normalized;
  return fallback;
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'single';
}

function parseOperations(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    conversation_id: normalizeNullablePositiveInt(row.conversation_id),
    file_id: normalizeNullablePositiveInt(row.file_id),
    message_id: normalizeNullablePositiveInt(row.message_id),
    article_hash: String(row.article_hash || ''),
    mode: normalizeMode(row.mode),
    operations: parseOperations(row.operations_json),
    status: normalizeStatus(row.status),
    expires_at: row.expires_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function computeArticleHash(article = {}) {
  const payload = {
    title: article?.title || '',
    file_id: article?.file_id || article?.fileId || null,
    blocks: Array.isArray(article?.blocks)
      ? article.blocks.map((block) => ({
        id: block.id,
        type: block.type,
        content: block.content || '',
      }))
      : [],
  };
  return sha256(JSON.stringify(payload));
}

function cleanupExpiredOperationSets(database = getDb()) {
  database.prepare(`
    UPDATE canvas_operation_sets
    SET status = 'cancelled', updated_at = datetime('now')
    WHERE status IN ('pending', 'stale')
      AND expires_at IS NOT NULL
      AND expires_at <= datetime('now')
  `).run();
}

function createOperationSet({
  conversationId,
  fileId = null,
  messageId = null,
  articleHash,
  mode = 'single',
  operations = [],
  status = 'pending',
  expireDays = DEFAULT_EXPIRE_DAYS,
} = {}) {
  const database = getDb();
  cleanupExpiredOperationSets(database);
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) throw new Error('conversation_id is required');
  const serializedOperations = JSON.stringify(Array.isArray(operations) ? operations : []);
  const result = database.prepare(`
    INSERT INTO canvas_operation_sets (
      conversation_id, file_id, message_id, article_hash, mode, operations_json, status, expires_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now'))
  `).run(
    normalizedConversationId,
    normalizeNullablePositiveInt(fileId),
    normalizeNullablePositiveInt(messageId),
    String(articleHash || ''),
    normalizeMode(mode),
    serializedOperations,
    normalizeStatus(status),
    `+${Math.max(1, Number(expireDays) || DEFAULT_EXPIRE_DAYS)} days`
  );
  return getOperationSetById(result.lastInsertRowid);
}

function getOperationSetById(id) {
  const database = getDb();
  const row = database.prepare(`
    SELECT *
    FROM canvas_operation_sets
    WHERE id = ?
  `).get(normalizeNullablePositiveInt(id));
  return formatRow(row);
}

function markOperationSetStatus(id, status) {
  const database = getDb();
  const normalizedId = normalizeNullablePositiveInt(id);
  if (!normalizedId) return null;
  database.prepare(`
    UPDATE canvas_operation_sets
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(normalizeStatus(status), normalizedId);
  return getOperationSetById(normalizedId);
}

function updateOperationSet(id, updates = {}) {
  const database = getDb();
  const normalizedId = normalizeNullablePositiveInt(id);
  if (!normalizedId) return null;

  const sets = [];
  const params = [];
  if (Object.prototype.hasOwnProperty.call(updates, 'messageId')) {
    sets.push('message_id = ?');
    params.push(normalizeNullablePositiveInt(updates.messageId));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
    sets.push('status = ?');
    params.push(normalizeStatus(updates.status));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'operations')) {
    sets.push('operations_json = ?');
    params.push(JSON.stringify(Array.isArray(updates.operations) ? updates.operations : []));
  }
  if (sets.length === 0) return getOperationSetById(normalizedId);
  sets.push("updated_at = datetime('now')");
  database.prepare(`
    UPDATE canvas_operation_sets
    SET ${sets.join(', ')}
    WHERE id = ?
  `).run(...params, normalizedId);
  return getOperationSetById(normalizedId);
}

function markConversationOperationSetsStale(conversationId, articleHash) {
  const database = getDb();
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId || !articleHash) return 0;
  const result = database.prepare(`
    UPDATE canvas_operation_sets
    SET status = 'stale', updated_at = datetime('now')
    WHERE conversation_id = ?
      AND status = 'pending'
      AND article_hash != ?
  `).run(normalizedConversationId, String(articleHash));
  return Number(result.changes || 0);
}

function listOperationSetsByConversation(conversationId, options = {}) {
  const database = getDb();
  cleanupExpiredOperationSets(database);
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) return [];
  const articleHash = String(options.articleHash || '').trim();
  if (articleHash) markConversationOperationSetsStale(normalizedConversationId, articleHash);

  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((item) => normalizeStatus(item)).filter(Boolean)
    : ['pending', 'stale'];

  const rows = database.prepare(`
    SELECT *
    FROM canvas_operation_sets
    WHERE conversation_id = ?
      AND status IN (${statuses.map(() => '?').join(',')})
    ORDER BY created_at ASC, id ASC
  `).all(normalizedConversationId, ...statuses);

  return rows.map(formatRow);
}

module.exports = {
  ACTIVE_STATUSES,
  computeArticleHash,
  createOperationSet,
  getOperationSetById,
  listOperationSetsByConversation,
  markConversationOperationSetsStale,
  markOperationSetStatus,
  updateOperationSet,
};
