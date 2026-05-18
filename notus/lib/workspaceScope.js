const { getDb } = require('./db');

const DEFAULT_SCOPES = {
  read_scope: { type: 'all' },
  retrieval_scope: { type: 'all' },
  write_scope: { type: 'current_file' },
  style_scope: { type: 'auto' },
};

const SCOPE_KEYS = Object.keys(DEFAULT_SCOPES);
const VALID_TYPES = new Set(['all', 'path', 'files', 'tags', 'auto', 'current_file']);

function parseScope(value, fallback = { type: 'all' }) {
  if (!value) return fallback;
  if (typeof value === 'object') return normalizeScope(value, fallback);
  try {
    return normalizeScope(JSON.parse(value), fallback);
  } catch {
    return fallback;
  }
}

function normalizePositiveIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item)))];
}

function normalizeStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

function normalizeScope(scope = {}, fallback = { type: 'all' }) {
  const type = VALID_TYPES.has(scope?.type) ? scope.type : fallback.type || 'all';
  if (type === 'path') return { type, paths: normalizeStrings(scope.paths) };
  if (type === 'files') return { type, file_ids: normalizePositiveIds(scope.file_ids || scope.fileIds) };
  if (type === 'tags') return { type, tags: normalizeStrings(scope.tags) };
  if (type === 'auto') return { type, query: String(scope.query || '').trim() };
  if (type === 'current_file') return { type, file_id: Number(scope.file_id || scope.fileId || 0) || null };
  return { type: 'all' };
}

function normalizeConversationScopes(input = {}) {
  return SCOPE_KEYS.reduce((acc, key) => {
    acc[key] = parseScope(input[key], DEFAULT_SCOPES[key]);
    return acc;
  }, {});
}

function serializeScope(scope, fallback) {
  return JSON.stringify(normalizeScope(scope, fallback));
}

function scopeFromLegacyReference({ referenceMode = 'auto', referenceFileIds = [] } = {}) {
  const fileIds = normalizePositiveIds(referenceFileIds);
  if (referenceMode === 'manual') return { type: 'files', file_ids: fileIds };
  return { type: 'all' };
}

function scopeFromLegacyStyle({ styleMode = 'auto', styleFileIds = [] } = {}) {
  const fileIds = normalizePositiveIds(styleFileIds);
  if (styleMode === 'manual') return { type: 'files', file_ids: fileIds };
  return { type: 'auto' };
}

function describeScope(scope = {}) {
  const normalized = normalizeScope(scope);
  if (normalized.type === 'all') return '全库';
  if (normalized.type === 'auto') return '自动匹配';
  if (normalized.type === 'current_file') return normalized.file_id ? `当前文件 ${normalized.file_id}` : '当前文件';
  if (normalized.type === 'files') return `指定文件 ${normalized.file_ids.length} 篇`;
  if (normalized.type === 'path') return `路径 ${normalized.paths.join(', ') || '空'}`;
  if (normalized.type === 'tags') return `标签 ${normalized.tags.join(', ') || '空'}`;
  return '全库';
}

function resolveScopeFileIds(scope = {}, context = {}) {
  const normalized = normalizeScope(scope);
  const db = getDb();

  if (normalized.type === 'files') return normalized.file_ids;
  if (normalized.type === 'current_file') {
    const id = Number(normalized.file_id || context.activeFileId || context.active_file_id || 0);
    return Number.isFinite(id) && id > 0 ? [Math.floor(id)] : [];
  }
  if (normalized.type === 'path') {
    if (normalized.paths.length === 0) return [];
    const clauses = normalized.paths.map(() => '(path = ? OR path LIKE ?)');
    const params = normalized.paths.flatMap((item) => {
      const clean = item.replace(/\/+$/, '');
      return [clean, `${clean}/%`];
    });
    return db.prepare(`
      SELECT id
      FROM files
      WHERE ${clauses.join(' OR ')}
      ORDER BY path COLLATE NOCASE
    `).all(...params).map((row) => Number(row.id));
  }
  if (normalized.type === 'tags') {
    if (normalized.tags.length === 0) return [];
    const rows = db.prepare(`
      SELECT id, tags
      FROM files
      WHERE tags IS NOT NULL AND tags != ''
    `).all();
    return rows
      .filter((row) => {
        try {
          const tags = JSON.parse(row.tags);
          return Array.isArray(tags) && tags.some((tag) => normalized.tags.includes(String(tag)));
        } catch {
          return false;
        }
      })
      .map((row) => Number(row.id));
  }
  return [];
}

function isScopeUnrestricted(scope = {}) {
  const normalized = normalizeScope(scope);
  return normalized.type === 'all' || normalized.type === 'auto';
}

function resolveCombinedScopeFileIds(primaryScope = {}, readScope = {}, context = {}) {
  const primary = normalizeScope(primaryScope);
  const read = normalizeScope(readScope);
  const primaryRestricted = !isScopeUnrestricted(primary);
  const readRestricted = !isScopeUnrestricted(read);

  if (!primaryRestricted && !readRestricted) {
    return { fileIds: [], restrictToFileIds: false };
  }

  const primaryIds = primaryRestricted ? resolveScopeFileIds(primary, context) : null;
  const readIds = readRestricted ? resolveScopeFileIds(read, context) : null;

  if (primaryRestricted && readRestricted) {
    const readSet = new Set(readIds);
    return {
      fileIds: primaryIds.filter((id) => readSet.has(id)),
      restrictToFileIds: true,
    };
  }

  return {
    fileIds: primaryRestricted ? primaryIds : readIds,
    restrictToFileIds: true,
  };
}

function countScopeFiles(scope = {}, context = {}) {
  const normalized = normalizeScope(scope);
  if (normalized.type === 'all' || normalized.type === 'auto') {
    const row = getDb().prepare('SELECT COUNT(*) AS count FROM files').get();
    return Number(row?.count || 0);
  }
  return resolveScopeFileIds(normalized, context).length;
}

function validateScope(scope = {}, context = {}) {
  const normalized = normalizeScope(scope);
  if (['files', 'path', 'tags', 'current_file'].includes(normalized.type)) {
    const count = countScopeFiles(normalized, context);
    return {
      ok: count > 0,
      scope: normalized,
      doc_count: count,
      warning: count === 0 ? '所选范围内没有笔记' : '',
    };
  }
  return { ok: true, scope: normalized, doc_count: countScopeFiles(normalized, context), warning: '' };
}

module.exports = {
  DEFAULT_SCOPES,
  SCOPE_KEYS,
  countScopeFiles,
  describeScope,
  isScopeUnrestricted,
  normalizeConversationScopes,
  normalizeScope,
  parseScope,
  resolveCombinedScopeFileIds,
  resolveScopeFileIds,
  scopeFromLegacyReference,
  scopeFromLegacyStyle,
  serializeScope,
  validateScope,
};
