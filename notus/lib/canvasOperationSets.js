const { getDb } = require('./db');
const { sha256 } = require('./files');

const DEFAULT_EXPIRE_DAYS = 7;
const ACTIVE_STATUSES = ['pending', 'stale'];
const TERMINAL_STATUSES = ['applied', 'cancelled', 'partial'];
const PATCH_STATUSES = ['pending', 'applied', 'auto_applied', 'rolled_back', 'discarded', 'failed'];
const PATCH_APPLIED_STATUSES = ['applied', 'auto_applied'];
const PATCH_CANCELLED_STATUSES = ['rolled_back', 'discarded'];

function normalizeNullablePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function normalizeStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  if ([...ACTIVE_STATUSES, ...TERMINAL_STATUSES].includes(normalized)) return normalized;
  return fallback;
}

function hasColumn(database, table, column) {
  try {
    return database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
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

function parsePatches(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizePatchStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  return PATCH_STATUSES.includes(normalized) ? normalized : fallback;
}

function normalizePatchStates(patches = []) {
  return (Array.isArray(patches) ? patches : []).map((patch, index) => ({
    ...(patch || {}),
    patch_id: String(patch?.patch_id || patch?.id || `patch-${index}`),
    status: normalizePatchStatus(patch?.status),
  }));
}

function deriveOperationSetStatus(patches = []) {
  const normalized = normalizePatchStates(patches);
  if (normalized.length === 0) return 'pending';
  const statuses = normalized.map((patch) => normalizePatchStatus(patch.status));
  if (statuses.includes('pending') || statuses.includes('failed')) return 'pending';
  if (statuses.every((status) => PATCH_APPLIED_STATUSES.includes(status))) return 'applied';
  if (statuses.every((status) => PATCH_CANCELLED_STATUSES.includes(status))) return 'cancelled';
  return 'partial';
}

function formatRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    conversation_id: normalizeNullablePositiveInt(row.conversation_id),
    agent_session_id: normalizeNullablePositiveInt(row.agent_session_id),
    file_id: normalizeNullablePositiveInt(row.file_id),
    message_id: normalizeNullablePositiveInt(row.message_id),
    article_hash: String(row.article_hash || ''),
    mode: normalizeMode(row.mode),
    operations: parseOperations(row.operations_json),
    patches: normalizePatchStates(parsePatches(row.pathes_json)),
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
  conversation_id: snakeConversationId,
  agentSessionId = null,
  agent_session_id: snakeAgentSessionId = null,
  fileId = null,
  file_id: snakeFileId = null,
  messageId = null,
  articleHash,
  mode = 'single',
  operations = [],
  patches = [],
  status = 'pending',
  expireDays = DEFAULT_EXPIRE_DAYS,
} = {}) {
  const database = getDb();
  cleanupExpiredOperationSets(database);
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId || snakeConversationId);
  if (!normalizedConversationId) throw new Error('conversation_id is required');
  const serializedOperations = JSON.stringify(Array.isArray(operations) ? operations : []);
  const serializedPatches = JSON.stringify(normalizePatchStates(Array.isArray(patches) ? patches : []));
  const columns = [];
  const placeholders = [];
  const params = [];
  const pushColumn = (column, value, placeholder = '?') => {
    columns.push(column);
    placeholders.push(placeholder);
    if (placeholder === '?') params.push(value);
  };

  pushColumn('conversation_id', normalizedConversationId);
  if (hasColumn(database, 'canvas_operation_sets', 'agent_session_id')) {
    pushColumn('agent_session_id', normalizeNullablePositiveInt(agentSessionId || snakeAgentSessionId));
  }
  pushColumn('file_id', normalizeNullablePositiveInt(fileId || snakeFileId));
  pushColumn('message_id', normalizeNullablePositiveInt(messageId));
  pushColumn('article_hash', String(articleHash || ''));
  pushColumn('mode', normalizeMode(mode));
  pushColumn('operations_json', serializedOperations);
  if (hasColumn(database, 'canvas_operation_sets', 'pathes_json')) pushColumn('pathes_json', serializedPatches);
  pushColumn('status', normalizeStatus(status));
  columns.push('expires_at');
  placeholders.push("datetime('now', ?)");
  params.push(`+${Math.max(1, Number(expireDays) || DEFAULT_EXPIRE_DAYS)} days`);
  columns.push('updated_at');
  placeholders.push("datetime('now')");

  const result = database.prepare(`
    INSERT INTO canvas_operation_sets (
      ${columns.join(', ')}
    )
    VALUES (${placeholders.join(', ')})
  `).run(...params);
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
  if (Object.prototype.hasOwnProperty.call(updates, 'patches') && hasColumn(database, 'canvas_operation_sets', 'pathes_json')) {
    sets.push('pathes_json = ?');
    params.push(JSON.stringify(normalizePatchStates(Array.isArray(updates.patches) ? updates.patches : [])));
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
    : ['pending', 'stale', 'partial', 'applied', 'cancelled'];

  const rows = database.prepare(`
    SELECT *
    FROM canvas_operation_sets
    WHERE conversation_id = ?
      AND status IN (${statuses.map(() => '?').join(',')})
    ORDER BY created_at ASC, id ASC
  `).all(normalizedConversationId, ...statuses);

  return rows.map(formatRow);
}

function listOperationSetsBySession(sessionId, options = {}) {
  const database = getDb();
  cleanupExpiredOperationSets(database);
  if (!hasColumn(database, 'canvas_operation_sets', 'agent_session_id')) return [];
  const normalizedSessionId = normalizeNullablePositiveInt(sessionId);
  if (!normalizedSessionId) return [];
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((item) => normalizeStatus(item)).filter(Boolean)
    : ['pending', 'stale', 'partial', 'applied', 'cancelled'];
  const rows = database.prepare(`
    SELECT *
    FROM canvas_operation_sets
    WHERE agent_session_id = ?
      AND status IN (${statuses.map(() => '?').join(',')})
    ORDER BY created_at ASC, id ASC
  `).all(normalizedSessionId, ...statuses);
  return rows.map(formatRow);
}

module.exports = {
  ACTIVE_STATUSES,
  PATCH_STATUSES,
  computeArticleHash,
  createOperationSet,
  deriveOperationSetStatus,
  getOperationSetById,
  listOperationSetsByConversation,
  listOperationSetsBySession,
  markConversationOperationSetsStale,
  markOperationSetStatus,
  normalizePatchStates,
  normalizePatchStatus,
  updateOperationSet,
};
