const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');

function normalizeRelativePath(inputPath) {
  const raw = String(inputPath || '').replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0')) throw new Error('path is required');
  if (path.isAbsolute(raw)) throw new Error('absolute paths are not allowed');

  const normalized = path.posix.normalize(raw).replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error('invalid path');
  }
  return normalized;
}

function ensureMarkdownPath(inputPath) {
  const normalized = normalizeRelativePath(inputPath);
  return /\.md$/i.test(normalized) ? normalized : `${normalized}.md`;
}

function resolveInside(baseDir, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, normalized);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('path escapes notes directory');
  }
  return { absolutePath: resolved, relativePath: normalized };
}

function getParentPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function getBaseName(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').split('/').pop() || '';
}

function extractTitle(filePath, content = '') {
  const match = String(content || '').match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return getBaseName(filePath).replace(/\.md$/i, '');
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readMarkdownFile(relativePath) {
  const config = getEffectiveConfig();
  const target = resolveInside(config.notesDir, relativePath);
  return fs.readFileSync(target.absolutePath, 'utf8');
}

function writeMarkdownFile(relativePath, content) {
  const config = getEffectiveConfig();
  const target = resolveInside(config.notesDir, ensureMarkdownPath(relativePath));
  fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
  fs.writeFileSync(target.absolutePath, content, 'utf8');
  return target.relativePath;
}

function listMarkdownFiles() {
  const config = getEffectiveConfig();
  fs.mkdirSync(config.notesDir, { recursive: true });
  const root = path.resolve(config.notesDir);
  const assets = path.resolve(config.assetsDir);
  const results = [];

  function walk(dir) {
    if (dir === assets || dir.startsWith(`${assets}${path.sep}`)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (entry.name.startsWith('.')) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        results.push(path.relative(root, absolute).replace(/\\/g, '/'));
      }
    });
  }

  walk(root);
  return results.sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

function listFolders() {
  const config = getEffectiveConfig();
  fs.mkdirSync(config.notesDir, { recursive: true });
  const root = path.resolve(config.notesDir);
  const assets = path.resolve(config.assetsDir);
  const folders = new Set();

  function walk(dir) {
    if (dir === assets || dir.startsWith(`${assets}${path.sep}`)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (entry.name.startsWith('.')) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        folders.add(path.relative(root, absolute).replace(/\\/g, '/'));
        walk(absolute);
      }
    });
  }

  walk(root);
  return [...folders].filter(Boolean).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

function syncFileRecord(relativePath, content = null, options = {}) {
  const db = getDb();
  const normalized = ensureMarkdownPath(relativePath);
  const source = content === null ? readMarkdownFile(normalized) : String(content || '');
  const title = extractTitle(normalized, source);
  const hash = sha256(source);
  const hasIndexedFlag = options.indexed !== undefined && options.indexed !== null;
  const indexed = hasIndexedFlag ? Number(options.indexed) : null;

  if (hasIndexedFlag) {
    db.prepare(`
      INSERT INTO files (path, title, hash, indexed, index_error, updated_at)
      VALUES (?, ?, ?, ?, NULL, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        hash = excluded.hash,
        indexed = excluded.indexed,
        index_error = NULL,
        updated_at = excluded.updated_at
    `).run(normalized, title, hash, indexed);
  } else {
    db.prepare(`
      INSERT INTO files (path, title, hash, indexed, updated_at)
      VALUES (?, ?, ?, 0, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        hash = excluded.hash
    `).run(normalized, title, hash);
  }

  const row = db.prepare('SELECT * FROM files WHERE path = ?').get(normalized);
  return row;
}

function syncFilesFromDisk() {
  const db = getDb();
  const paths = listMarkdownFiles();
  const seen = new Set(paths);

  paths.forEach((relativePath) => {
    syncFileRecord(relativePath, null, { indexed: undefined });
  });

  const rows = db.prepare('SELECT path FROM files').all();
  rows.forEach((row) => {
    if (!seen.has(row.path)) {
      db.prepare('DELETE FROM files WHERE path = ?').run(row.path);
    }
  });
}

function getFileById(id) {
  syncFilesFromDisk();
  const db = getDb();
  const row = db.prepare(`
    SELECT
      f.*,
      s.status AS index_state
    FROM files f
    LEFT JOIN file_index_status s ON s.file_id = f.id
    WHERE f.id = ?
  `).get(Number(id));
  if (!row) return null;
  const content = readMarkdownFile(row.path);
  return {
    id: row.id,
    path: row.path,
    title: row.title || extractTitle(row.path, content),
    name: getBaseName(row.path),
    content,
    indexed: row.indexed,
    index_state: row.index_state || (row.indexed ? 'ready' : 'queued'),
    updated_at: row.updated_at,
  };
}

function getFileByPath(filePath) {
  syncFilesFromDisk();
  const db = getDb();
  const normalized = ensureMarkdownPath(filePath);
  const row = db.prepare(`
    SELECT
      f.*,
      s.status AS index_state
    FROM files f
    LEFT JOIN file_index_status s ON s.file_id = f.id
    WHERE f.path = ?
  `).get(normalized);
  if (!row) return null;
  const content = readMarkdownFile(row.path);
  return {
    id: row.id,
    path: row.path,
    title: row.title || extractTitle(row.path, content),
    name: getBaseName(row.path),
    content,
    indexed: row.indexed,
    index_state: row.index_state || (row.indexed ? 'ready' : 'queued'),
    updated_at: row.updated_at,
  };
}

function getAllFiles() {
  syncFilesFromDisk();
  const db = getDb();
  return db.prepare(`
    SELECT
      f.id,
      f.path,
      f.title,
      f.indexed,
      f.updated_at,
      f.index_error,
      s.status AS index_state
    FROM files f
    LEFT JOIN file_index_status s ON s.file_id = f.id
    ORDER BY path COLLATE NOCASE
  `).all().map((row) => ({
    id: row.id,
    path: row.path,
    title: row.title || getBaseName(row.path).replace(/\.md$/i, ''),
    name: getBaseName(row.path),
    indexed: row.indexed,
    index_state: row.index_state || (row.indexed ? 'ready' : 'queued'),
    updated_at: row.updated_at,
    status: row.index_state === 'failed'
      ? 'error'
      : (row.index_state === 'queued' || row.index_state === 'running' || (!row.indexed && !row.index_state))
        ? 'indexing'
        : undefined,
  }));
}

function sortTree(nodes) {
  nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-Hans-CN');
  });
  nodes.forEach((node) => {
    if (node.children) sortTree(node.children);
  });
}

function buildTree() {
  const roots = [];
  const folderNodes = new Map();
  const folders = listFolders();
  const files = getAllFiles();

  const getFolderNode = (folderPath) => {
    if (!folderPath) return null;
    if (folderNodes.has(folderPath)) return folderNodes.get(folderPath);
    const node = {
      type: 'folder',
      name: getBaseName(folderPath),
      path: folderPath,
      children: [],
    };
    folderNodes.set(folderPath, node);
    const parent = getFolderNode(getParentPath(folderPath));
    if (parent) parent.children.push(node);
    else roots.push(node);
    return node;
  };

  folders.forEach(getFolderNode);

  files.forEach((file) => {
    const parent = getFolderNode(getParentPath(file.path));
    const node = {
      type: 'file',
      id: file.id,
      name: file.name,
      path: file.path,
      indexed: file.indexed,
      status: file.status,
      updated_at: file.updated_at,
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
  });

  sortTree(roots);
  return roots;
}

function createFolder(folderPath) {
  const config = getEffectiveConfig();
  const target = resolveInside(config.notesDir, folderPath);
  fs.mkdirSync(target.absolutePath, { recursive: true });
  return {
    type: 'folder',
    path: target.relativePath,
    name: getBaseName(target.relativePath),
  };
}

function createFile(filePath, content = '') {
  const finalPath = writeMarkdownFile(filePath, content || `# ${getBaseName(filePath).replace(/\.md$/i, '')}\n\n`);
  const row = syncFileRecord(finalPath, readMarkdownFile(finalPath), { indexed: 0 });
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    name: getBaseName(row.path),
    content: readMarkdownFile(row.path),
    indexed: row.indexed,
    updated_at: row.updated_at,
  };
}

function saveFileByPath(filePath, content = '') {
  const finalPath = writeMarkdownFile(filePath, String(content || ''));
  const row = syncFileRecord(finalPath, String(content || ''), { indexed: 0 });
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    name: getBaseName(row.path),
    content: String(content || ''),
    indexed: row.indexed,
    updated_at: row.updated_at,
  };
}

function updateFile(id, content) {
  const existing = getFileById(id);
  if (!existing) throw new Error('file not found');
  const finalPath = writeMarkdownFile(existing.path, String(content || ''));
  const row = syncFileRecord(finalPath, String(content || ''), { indexed: 0 });
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    name: getBaseName(row.path),
    content: String(content || ''),
    indexed: row.indexed,
    updated_at: row.updated_at,
  };
}

function deleteFile(id) {
  const existing = getFileById(id);
  if (!existing) return false;
  const config = getEffectiveConfig();
  const target = resolveInside(config.notesDir, existing.path);
  if (fs.existsSync(target.absolutePath)) fs.unlinkSync(target.absolutePath);
  getDb().prepare('DELETE FROM files WHERE id = ?').run(Number(id));
  return true;
}

function renameFile(oldPath, newPath) {
  const config = getEffectiveConfig();
  const oldTarget = resolveInside(config.notesDir, oldPath);
  const newTarget = resolveInside(config.notesDir, ensureMarkdownPath(newPath));
  fs.mkdirSync(path.dirname(newTarget.absolutePath), { recursive: true });
  fs.renameSync(oldTarget.absolutePath, newTarget.absolutePath);
  getDb().prepare('UPDATE files SET path = ?, title = ?, updated_at = datetime("now") WHERE path = ?')
    .run(newTarget.relativePath, getBaseName(newTarget.relativePath).replace(/\.md$/i, ''), oldTarget.relativePath);
  return syncFileRecord(newTarget.relativePath, readMarkdownFile(newTarget.relativePath), { indexed: 0 });
}

function moveFiles(paths, dest) {
  const destination = dest ? normalizeRelativePath(dest) : '';
  return paths.map((itemPath) => {
    const baseName = getBaseName(itemPath);
    return renameFile(itemPath, destination ? `${destination}/${baseName}` : baseName);
  });
}

function listFilesByIds(ids = []) {
  syncFilesFromDisk();
  const normalizedIds = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  if (normalizedIds.length === 0) return [];
  const placeholders = normalizedIds.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT id, path, title, indexed, updated_at
    FROM files
    WHERE id IN (${placeholders})
    ORDER BY path COLLATE NOCASE
  `).all(...normalizedIds);

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    title: row.title || getBaseName(row.path).replace(/\.md$/i, ''),
    name: getBaseName(row.path),
    indexed: row.indexed,
    updated_at: row.updated_at,
  }));
}

function listFilesByPaths(paths = []) {
  return paths
    .map((itemPath) => getFileByPath(itemPath))
    .filter(Boolean);
}

module.exports = {
  normalizeRelativePath,
  ensureMarkdownPath,
  resolveInside,
  getParentPath,
  getBaseName,
  extractTitle,
  sha256,
  readMarkdownFile,
  writeMarkdownFile,
  listMarkdownFiles,
  syncFilesFromDisk,
  getFileById,
  getFileByPath,
  getAllFiles,
  listFilesByIds,
  listFilesByPaths,
  buildTree,
  syncFileRecord,
  createFile,
  createFolder,
  saveFileByPath,
  updateFile,
  deleteFile,
  renameFile,
  moveFiles,
};
