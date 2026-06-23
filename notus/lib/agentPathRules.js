const path = require('path');

function normalizeAgentPath(input, { allowRoot = false, ensureMarkdown = false } = {}) {
  const raw = String(input || '').replace(/\\/g, '/').trim();
  if (!raw || raw === '.') {
    if (allowRoot) return '';
    throw new Error('path is required');
  }
  if (raw.includes('\0')) throw new Error('invalid path');
  if (path.isAbsolute(raw)) throw new Error('absolute paths are not allowed');
  let normalized = path.posix.normalize(raw).replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    if (allowRoot && (!normalized || normalized === '.')) return '';
    throw new Error('invalid path');
  }
  if (ensureMarkdown && !/\.md$/i.test(normalized)) normalized += '.md';
  return normalized;
}

function resolveInsideNotes(notesDir, relativePath, { allowRoot = false } = {}) {
  const normalized = normalizeAgentPath(relativePath, { allowRoot });
  const base = path.resolve(notesDir);
  const absolute = normalized ? path.resolve(base, normalized) : base;
  if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) {
    throw new Error('path escapes notes directory');
  }
  return { absolutePath: absolute, relativePath: normalized };
}

function normalizeAuthorizedPaths(paths = []) {
  const input = Array.isArray(paths) ? paths : [];
  const normalized = input
    .map((item) => normalizeAgentPath(item, { allowRoot: true }))
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return normalized.length > 0 ? normalized : [''];
}

function getAgentPathDir(filePath) {
  const dir = path.posix.dirname(filePath);
  return dir === '.' ? '' : dir;
}

function isPathSafe(targetPath, authorizedPaths = [], operation = 'modify') {
  let target;
  try {
    target = normalizeAgentPath(targetPath, { allowRoot: false, ensureMarkdown: true });
  } catch {
    return false;
  }
  const op = String(operation || 'modify').trim();
  const targetDir = getAgentPathDir(target);
  return normalizeAuthorizedPaths(authorizedPaths).some((authPath) => {
    if (!authPath) return true;
    if (target === authPath) return true;
    if (target.startsWith(`${authPath}/`)) return true;
    if (op === 'create' && /\.md$/i.test(authPath)) return targetDir === getAgentPathDir(authPath);
    return false;
  });
}

module.exports = {
  getAgentPathDir,
  isPathSafe,
  normalizeAgentPath,
  normalizeAuthorizedPaths,
  resolveInsideNotes,
};
