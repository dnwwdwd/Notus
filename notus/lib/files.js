const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb, getSetting } = require('./db');
const { getEffectiveConfig } = require('./config');
const {
  buildMarkdownMetadata,
  generateStableId,
  injectFrontmatterId,
  extractVisiblePrimaryHeading,
  mergeEditorVisibleMarkdown,
  normalizeFileNameBase,
  rewriteVisibleMarkdownPrimaryHeading,
  splitEditorVisibleMarkdown,
} = require('./markdownMeta');

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

function normalizeFileName(inputName) {
  const raw = String(inputName || '').replace(/\\/g, '/').trim();
  if (!raw) throw new Error('name is required');
  if (raw.includes('/')) throw new Error('name must not include path separators');
  return ensureMarkdownPath(raw);
}

function buildRenamedPath(relativePath, nextName) {
  const normalizedName = normalizeFileName(nextName);
  const parentPath = getParentPath(relativePath);
  return [parentPath, normalizedName].filter(Boolean).join('/');
}

function isTitleFilenameBindingEnabled() {
  return String(getSetting('editor_title_filename_binding_enabled', 'false')).trim() === 'true';
}

function getBindingTitleFromContent(content = '') {
  return normalizeFileNameBase(extractVisiblePrimaryHeading(content));
}

function pathExists(relativePath) {
  const config = getEffectiveConfig();
  const target = resolveInside(config.notesDir, ensureMarkdownPath(relativePath));
  return fs.existsSync(target.absolutePath);
}

function applyVisibleTitleBinding(fileContent = '', nextTitle = '') {
  const { visibleContent, hiddenFrontmatter } = splitEditorVisibleMarkdown(fileContent);
  const updatedVisibleContent = rewriteVisibleMarkdownPrimaryHeading(visibleContent, nextTitle);
  return mergeEditorVisibleMarkdown(updatedVisibleContent, hiddenFrontmatter);
}

function extractTitle(filePath, content = '') {
  const match = String(content || '').match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return getBaseName(filePath).replace(/\.md$/i, '');
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function formatSqliteDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  return safeDate.toISOString().slice(0, 19).replace('T', ' ');
}

function getFileUpdatedAt(relativePath) {
  const config = getEffectiveConfig();
  const target = resolveInside(config.notesDir, ensureMarkdownPath(relativePath));
  const stats = fs.statSync(target.absolutePath);
  return formatSqliteDate(stats.mtime);
}

function getFileStat(relativePath) {
  const config = getEffectiveConfig();
  const target = resolveInside(config.notesDir, ensureMarkdownPath(relativePath));
  return fs.statSync(target.absolutePath);
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
  const tmpPath = `${target.absolutePath}.notus-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, target.absolutePath);
  } catch (error) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    throw error;
  }
  return target.relativePath;
}

function resolveStableId(db, existingRow, frontmatterId = '') {
  const current = String(existingRow?.stable_id || '').trim();
  if (current) return current;

  const candidate = String(frontmatterId || '').trim();
  if (candidate) {
    const duplicate = db.prepare('SELECT id FROM files WHERE stable_id = ?').get(candidate);
    if (!duplicate || Number(duplicate.id) === Number(existingRow?.id || 0)) return candidate;
  }

  let generated = generateStableId();
  while (db.prepare('SELECT id FROM files WHERE stable_id = ?').get(generated)) {
    generated = generateStableId();
  }
  return generated;
}

function serializeJson(value) {
  return JSON.stringify(value || null);
}

function parseJsonSafe(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildFileRecordPayload(db, normalized, source, existingRow = null, stat = null) {
  const fileStat = stat || getFileStat(normalized);
  const metadata = buildMarkdownMetadata(source, normalized, fileStat);
  const stableId = resolveStableId(db, existingRow, metadata.frontmatterId);
  return {
    stableId,
    frontmatterId: metadata.frontmatterId,
    title: metadata.title || extractTitle(normalized, source),
    hash: sha256(source),
    size: metadata.size,
    mtime: metadata.mtime,
    charCount: metadata.charCount,
    tokenCount: metadata.tokenCount,
    frontmatter: serializeJson(metadata.frontmatter),
    tags: serializeJson(metadata.tags),
    headingOutline: serializeJson(metadata.headingOutline),
  };
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

function upsertFileRecord(relativePath, content = null, indexed = 0) {
  const db = getDb();
  const normalized = ensureMarkdownPath(relativePath);
  const source = content === null ? readMarkdownFile(normalized) : String(content || '');
  const existing = db.prepare('SELECT * FROM files WHERE path = ?').get(normalized);
  const payload = buildFileRecordPayload(db, normalized, source, existing);
  const updatedAt = getFileUpdatedAt(normalized);

  const result = db.prepare(`
    INSERT INTO files (
      path, stable_id, title, hash, size, mtime, char_count, token_count,
      frontmatter, tags, heading_outline, indexed, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      stable_id = CASE
        WHEN files.stable_id IS NULL OR files.stable_id = '' THEN excluded.stable_id
        ELSE files.stable_id
      END,
      title = excluded.title,
      hash = CASE WHEN files.hash IS NULL OR files.hash = '' THEN excluded.hash ELSE files.hash END,
      size = excluded.size,
      mtime = excluded.mtime,
      char_count = excluded.char_count,
      token_count = excluded.token_count,
      frontmatter = excluded.frontmatter,
      tags = excluded.tags,
      heading_outline = excluded.heading_outline,
      indexed = excluded.indexed,
      index_error = NULL,
      updated_at = excluded.updated_at
  `).run(
    normalized,
    payload.stableId,
    payload.title,
    payload.hash,
    payload.size,
    payload.mtime,
    payload.charCount,
    payload.tokenCount,
    payload.frontmatter,
    payload.tags,
    payload.headingOutline,
    indexed,
    updatedAt
  );

  const row = db.prepare('SELECT * FROM files WHERE path = ?').get(normalized);
  return { ...row, inserted: result.changes > 0 };
}

function syncFilesFromDisk() {
  const db = getDb();
  const paths = listMarkdownFiles();
  const seen = new Set(paths);

  paths.forEach((relativePath) => {
    const content = readMarkdownFile(relativePath);
    let existing = db.prepare('SELECT * FROM files WHERE path = ?').get(relativePath);
    let payload = buildFileRecordPayload(db, relativePath, content, existing);

    if (!existing && payload.frontmatterId) {
      const renamed = db.prepare(`
        SELECT *
        FROM files
        WHERE stable_id = ?
          AND path != ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(payload.frontmatterId, relativePath);
      if (renamed && !seen.has(renamed.path)) {
        db.prepare('UPDATE files SET path = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(relativePath, renamed.id);
        existing = { ...renamed, path: relativePath };
        payload = buildFileRecordPayload(db, relativePath, content, existing);
      }
    }

    const updatedAt = getFileUpdatedAt(relativePath);
    db.prepare(`
      INSERT INTO files (
        path, stable_id, title, hash, size, mtime, char_count, token_count,
        frontmatter, tags, heading_outline, indexed, updated_at
      )
      VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(path) DO UPDATE SET
        stable_id = CASE
          WHEN files.stable_id IS NULL OR files.stable_id = '' THEN excluded.stable_id
          ELSE files.stable_id
        END,
        title = excluded.title,
        size = excluded.size,
        mtime = excluded.mtime,
        char_count = excluded.char_count,
        token_count = excluded.token_count,
        frontmatter = excluded.frontmatter,
        tags = excluded.tags,
        heading_outline = excluded.heading_outline,
        updated_at = excluded.updated_at
    `).run(
      relativePath,
      payload.stableId,
      payload.title,
      payload.size,
      payload.mtime,
      payload.charCount,
      payload.tokenCount,
      payload.frontmatter,
      payload.tags,
      payload.headingOutline,
      updatedAt
    );
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
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(id));
  if (!row) return null;
  const content = readMarkdownFile(row.path);
  return {
    id: row.id,
    stable_id: row.stable_id || null,
    path: row.path,
    title: row.title || extractTitle(row.path, content),
    name: getBaseName(row.path),
    content,
    indexed: row.indexed,
    hash: row.hash || '',
    token_count: Number(row.token_count || 0),
    heading_outline: parseJsonSafe(row.heading_outline, []),
    updated_at: row.updated_at,
  };
}

function getFileByPath(filePath) {
  syncFilesFromDisk();
  const db = getDb();
  const normalized = ensureMarkdownPath(filePath);
  const row = db.prepare('SELECT * FROM files WHERE path = ?').get(normalized);
  if (!row) return null;
  const content = readMarkdownFile(row.path);
  return {
    id: row.id,
    stable_id: row.stable_id || null,
    path: row.path,
    title: row.title || extractTitle(row.path, content),
    name: getBaseName(row.path),
    content,
    indexed: row.indexed,
    hash: row.hash || '',
    token_count: Number(row.token_count || 0),
    heading_outline: parseJsonSafe(row.heading_outline, []),
    updated_at: row.updated_at,
  };
}

function getAllFiles() {
  syncFilesFromDisk();
  const db = getDb();
  return db.prepare(`
    SELECT id, path, title, indexed, updated_at, index_error
    FROM files
    ORDER BY datetime(updated_at) DESC, path COLLATE NOCASE
  `).all().map((row) => ({
    id: row.id,
    path: row.path,
    title: row.title || getBaseName(row.path).replace(/\.md$/i, ''),
    name: getBaseName(row.path),
    indexed: row.indexed,
    updated_at: row.updated_at,
    status: row.index_error ? 'error' : (row.indexed ? undefined : 'indexing'),
  }));
}

function compareUpdatedAtDesc(left, right) {
  const leftTime = Date.parse(String(left?.updated_at || ''));
  const rightTime = Date.parse(String(right?.updated_at || ''));
  const timeDiff = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  if (timeDiff !== 0) return timeDiff;
  return String(left?.name || '').localeCompare(String(right?.name || ''), 'zh-Hans-CN');
}

function sortTree(nodes) {
  nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
    if (left.type === 'file' && right.type === 'file') {
      return compareUpdatedAtDesc(left, right);
    }
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
      title: file.title,
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
  const initialContent = content || `# ${getBaseName(filePath).replace(/\.md$/i, '')}\n\n`;
  const finalPath = writeMarkdownFile(filePath, injectFrontmatterId(initialContent));
  const row = upsertFileRecord(finalPath, readMarkdownFile(finalPath), 0);
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
  const row = upsertFileRecord(finalPath, String(content || ''), 0);
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

function updateFile(id, content, options = {}) {
  const existing = getFileById(id);
  if (!existing) throw new Error('file not found');
  const source = String(content || '');
  const finalPath = writeMarkdownFile(existing.path, source);
  const row = upsertFileRecord(finalPath, source, 0);
  const savedFile = {
    id: row.id,
    path: row.path,
    title: row.title,
    name: getBaseName(row.path),
    content: source,
    indexed: row.indexed,
    updated_at: row.updated_at,
  };

  const bindingEnabled = options.titleFilenameBindingEnabled !== undefined
    ? Boolean(options.titleFilenameBindingEnabled)
    : isTitleFilenameBindingEnabled();
  if (!bindingEnabled) {
    return {
      ...savedFile,
      title_binding_applied: false,
      title_binding_warning: '',
    };
  }

  const currentBaseName = getBaseName(existing.path).replace(/\.md$/i, '');
  const nextBaseName = getBindingTitleFromContent(source);
  if (!nextBaseName || nextBaseName === currentBaseName) {
    return {
      ...savedFile,
      title_binding_applied: false,
      title_binding_warning: '',
    };
  }

  const nextPath = buildRenamedPath(existing.path, nextBaseName);
  if (pathExists(nextPath)) {
    return {
      ...savedFile,
      title_binding_applied: false,
      title_binding_warning: `正文已保存，但目标文件名「${nextBaseName}」已存在，未同步文件名。`,
    };
  }

  const renamedFile = renameFile(existing.path, nextPath);
  return {
    ...renamedFile,
    title_binding_applied: true,
    title_binding_warning: '',
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
  if (oldTarget.relativePath === newTarget.relativePath) {
    const current = getFileByPath(oldTarget.relativePath);
    if (!current) throw new Error('file not found');
    return {
      ...current,
      old_path: oldTarget.relativePath,
      new_path: newTarget.relativePath,
    };
  }
  if (fs.existsSync(newTarget.absolutePath)) {
    throw new Error(`目标文件已存在：${newTarget.relativePath}`);
  }
  fs.mkdirSync(path.dirname(newTarget.absolutePath), { recursive: true });
  fs.renameSync(oldTarget.absolutePath, newTarget.absolutePath);
  getDb().prepare('UPDATE files SET path = ?, title = ?, updated_at = ? WHERE path = ?')
    .run(
      newTarget.relativePath,
      getBaseName(newTarget.relativePath).replace(/\.md$/i, ''),
      getFileUpdatedAt(newTarget.relativePath),
      oldTarget.relativePath
    );
  upsertFileRecord(newTarget.relativePath, readMarkdownFile(newTarget.relativePath), 0);
  const current = getFileByPath(newTarget.relativePath);
  if (!current) throw new Error('file not found');
  return {
    ...current,
    old_path: oldTarget.relativePath,
    new_path: newTarget.relativePath,
  };
}

function syncFileHeadingToName(id, nextTitle) {
  const existing = getFileById(id);
  if (!existing) throw new Error('file not found');

  const resolvedTitle = normalizeFileNameBase(nextTitle) || getBaseName(existing.path).replace(/\.md$/i, '');
  const nextContent = applyVisibleTitleBinding(existing.content, resolvedTitle);
  if (nextContent === existing.content) {
    return {
      ...existing,
      title_binding_applied: false,
      title_binding_warning: '',
    };
  }

  return updateFile(id, nextContent, { titleFilenameBindingEnabled: false });
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
  const orderMap = new Map(normalizedIds.map((id, index) => [id, index]));
  const rows = getDb().prepare(`
    SELECT id, path, title, indexed, updated_at
    FROM files
    WHERE id IN (${placeholders})
  `).all(...normalizedIds);

  return rows
    .sort((left, right) => (orderMap.get(left.id) || 0) - (orderMap.get(right.id) || 0))
    .map((row) => ({
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
  buildRenamedPath,
  buildFileRecordPayload,
  extractTitle,
  sha256,
  formatSqliteDate,
  getFileUpdatedAt,
  getFileStat,
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
  createFile,
  createFolder,
  saveFileByPath,
  updateFile,
  deleteFile,
  isTitleFilenameBindingEnabled,
  renameFile,
  syncFileHeadingToName,
  moveFiles,
};
