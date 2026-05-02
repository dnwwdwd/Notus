const KNOWN_TARGETS = new Set(['web', 'electron', 'lazycat']);

function normalizeRuntimeTarget(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return KNOWN_TARGETS.has(normalized) ? normalized : null;
}

function looksLikeLazycatPath(value) {
  const target = String(value || '').trim();
  return target.startsWith('/lzcapp/');
}

function inferRuntimeTarget(env = process.env) {
  const explicitTarget = normalizeRuntimeTarget(env.NOTUS_RUNTIME_TARGET);
  if (explicitTarget) return explicitTarget;

  if (
    looksLikeLazycatPath(env.NOTES_DIR)
    || looksLikeLazycatPath(env.ASSETS_DIR)
    || looksLikeLazycatPath(env.DB_PATH)
    || looksLikeLazycatPath(env.NOTUS_DATA_ROOT)
  ) {
    return 'lazycat';
  }

  return 'web';
}

module.exports = {
  KNOWN_TARGETS,
  inferRuntimeTarget,
  normalizeRuntimeTarget,
};
