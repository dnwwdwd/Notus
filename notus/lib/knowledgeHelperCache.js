const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const store = new Map();

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function buildKnowledgeHelperCacheKey(kind, payload = {}) {
  const hash = crypto.createHash('sha1').update(stableStringify(payload)).digest('hex');
  return `${String(kind || 'helper').trim()}:${hash}`;
}

function readKnowledgeHelperCache(key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;

  const entry = store.get(normalizedKey);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(normalizedKey);
    return null;
  }
  return entry.value;
}

function writeKnowledgeHelperCache(key, value, ttlMs = DEFAULT_TTL_MS) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return value;
  const ttl = Math.max(Number(ttlMs) || DEFAULT_TTL_MS, 1000);
  store.set(normalizedKey, {
    value,
    expiresAt: Date.now() + ttl,
  });
  return value;
}

function clearKnowledgeHelperCache() {
  store.clear();
}

module.exports = {
  DEFAULT_TTL_MS,
  buildKnowledgeHelperCacheKey,
  readKnowledgeHelperCache,
  writeKnowledgeHelperCache,
  clearKnowledgeHelperCache,
};
