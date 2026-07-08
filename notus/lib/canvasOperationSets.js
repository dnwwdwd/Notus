const { getDb } = require('./db');
const { sha256 } = require('./files');
const { createDiffHunks } = require('./fileRevisionDiff');

const DEFAULT_EXPIRE_DAYS = 7;
const ACTIVE_STATUSES = ['pending', 'stale'];
const TERMINAL_STATUSES = [
  'applied',
  'cancelled',
  'partial',
  'discarded',
  'superseded',
  'apply_failed',
  'rolled_back',
  'rollback_conflict',
];
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
  const revisionType = String(row.revision_type || '').trim();
  const revisionBaseContent = String(row.revision_base_content || '');
  const revisionDraftContent = String(row.revision_draft_content || '');
  const revision = revisionType === 'file_revision'
    ? {
      type: revisionType,
      file_path: String(row.revision_file_path || ''),
      base_hash: String(row.revision_base_hash || ''),
      draft_hash: String(row.revision_draft_hash || ''),
      applied_hash: String(row.revision_applied_hash || ''),
      error_message: String(row.revision_error || ''),
      parent_operation_set_id: normalizeNullablePositiveInt(row.revision_parent_id),
      sequence_no: Number(row.revision_sequence_no || 0),
      applied_at: row.revision_applied_at || null,
      discarded_at: row.revision_discarded_at || null,
      rolled_back_at: row.revision_rolled_back_at || null,
      diff_hunks: createDiffHunks(revisionBaseContent, revisionDraftContent),
      base_line_count: revisionBaseContent ? revisionBaseContent.split('\n').length : 0,
      draft_line_count: revisionDraftContent ? revisionDraftContent.split('\n').length : 0,
    }
    : null;
  return {
    id: Number(row.id),
    conversation_id: normalizeNullablePositiveInt(row.conversation_id),
    agent_session_id: normalizeNullablePositiveInt(row.agent_session_id),
    file_id: normalizeNullablePositiveInt(row.file_id),
    message_id: normalizeNullablePositiveInt(row.message_id),
    article_hash: String(row.article_hash || ''),
    mode: normalizeMode(row.mode),
    type: revisionType || normalizeMode(row.mode),
    revision_type: revisionType || '',
    revision_file_path: revision?.file_path || '',
    revision,
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
  revisionType = '',
  revision_type: snakeRevisionType = '',
  revisionFilePath = '',
  revision_file_path: snakeRevisionFilePath = '',
  revisionBaseHash = '',
  revision_base_hash: snakeRevisionBaseHash = '',
  revisionDraftHash = '',
  revision_draft_hash: snakeRevisionDraftHash = '',
  revisionAppliedHash = '',
  revision_applied_hash: snakeRevisionAppliedHash = '',
  revisionBaseContent = '',
  revision_base_content: snakeRevisionBaseContent = '',
  revisionDraftContent = '',
  revision_draft_content: snakeRevisionDraftContent = '',
  revisionError = '',
  revision_error: snakeRevisionError = '',
  revisionParentId = null,
  revision_parent_id: snakeRevisionParentId = null,
  revisionSequenceNo = 0,
  revision_sequence_no: snakeRevisionSequenceNo = 0,
  revisionAppliedAt = null,
  revision_applied_at: snakeRevisionAppliedAt = null,
  revisionDiscardedAt = null,
  revision_discarded_at: snakeRevisionDiscardedAt = null,
  revisionRolledBackAt = null,
  revision_rolled_back_at: snakeRevisionRolledBackAt = null,
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
  if (hasColumn(database, 'canvas_operation_sets', 'revision_type')) {
    pushColumn('revision_type', String(revisionType || snakeRevisionType || ''));
    pushColumn('revision_file_path', String(revisionFilePath || snakeRevisionFilePath || ''));
    pushColumn('revision_base_hash', String(revisionBaseHash || snakeRevisionBaseHash || ''));
    pushColumn('revision_draft_hash', String(revisionDraftHash || snakeRevisionDraftHash || ''));
    pushColumn('revision_applied_hash', String(revisionAppliedHash || snakeRevisionAppliedHash || ''));
    pushColumn('revision_base_content', String(revisionBaseContent || snakeRevisionBaseContent || ''));
    pushColumn('revision_draft_content', String(revisionDraftContent || snakeRevisionDraftContent || ''));
    pushColumn('revision_error', String(revisionError || snakeRevisionError || ''));
    pushColumn('revision_parent_id', normalizeNullablePositiveInt(revisionParentId || snakeRevisionParentId));
    pushColumn('revision_sequence_no', Math.max(0, Number(revisionSequenceNo || snakeRevisionSequenceNo) || 0));
    pushColumn('revision_applied_at', revisionAppliedAt || snakeRevisionAppliedAt || null);
    pushColumn('revision_discarded_at', revisionDiscardedAt || snakeRevisionDiscardedAt || null);
    pushColumn('revision_rolled_back_at', revisionRolledBackAt || snakeRevisionRolledBackAt || null);
  }
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
  [
    ['revisionType', 'revision_type', (value) => String(value || '')],
    ['revisionFilePath', 'revision_file_path', (value) => String(value || '')],
    ['revisionBaseHash', 'revision_base_hash', (value) => String(value || '')],
    ['revisionDraftHash', 'revision_draft_hash', (value) => String(value || '')],
    ['revisionAppliedHash', 'revision_applied_hash', (value) => String(value || '')],
    ['revisionBaseContent', 'revision_base_content', (value) => String(value ?? '')],
    ['revisionDraftContent', 'revision_draft_content', (value) => String(value ?? '')],
    ['revisionError', 'revision_error', (value) => String(value || '')],
    ['revisionParentId', 'revision_parent_id', normalizeNullablePositiveInt],
    ['revisionSequenceNo', 'revision_sequence_no', (value) => Math.max(0, Number(value) || 0)],
    ['revisionAppliedAt', 'revision_applied_at', (value) => value || null],
    ['revisionDiscardedAt', 'revision_discarded_at', (value) => value || null],
    ['revisionRolledBackAt', 'revision_rolled_back_at', (value) => value || null],
  ].forEach(([key, column, normalize]) => {
    if (Object.prototype.hasOwnProperty.call(updates, key) && hasColumn(database, 'canvas_operation_sets', column)) {
      sets.push(`${column} = ?`);
      params.push(normalize(updates[key]));
    }
  });
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
      AND COALESCE(revision_type, '') != 'file_revision'
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
    : ['pending', 'stale', 'partial', 'applied', 'cancelled', 'discarded', 'superseded', 'apply_failed', 'rolled_back', 'rollback_conflict'];

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
    : ['pending', 'stale', 'partial', 'applied', 'cancelled', 'discarded', 'superseded', 'apply_failed', 'rolled_back', 'rollback_conflict'];
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
