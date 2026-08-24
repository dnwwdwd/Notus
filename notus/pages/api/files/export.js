const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { ensureRuntime } = require('../../../lib/runtime');
const { getEffectiveConfig } = require('../../../lib/config');
const {
  getAllFiles,
  listFilesByIds,
  listFilesByPaths,
  normalizeRelativePath,
  resolveInside,
} = require('../../../lib/files');

function encodeContentDispositionFilename(filename = '') {
  const original = String(filename || '').trim() || 'notus-export.zip';
  const asciiFallback = original
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\]/g, '_')
    .trim() || 'notus-export.zip';
  const encoded = encodeURIComponent(original)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');

  return `attachment; filename=\"${asciiFallback}\"; filename*=UTF-8''${encoded}`;
}

function uniqueFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    if (!file?.path || seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function listFilesByFolder(folderPath = '') {
  const folder = normalizeRelativePath(folderPath);
  const prefix = `${folder}/`;
  return getAllFiles().filter((file) => String(file?.path || '').startsWith(prefix));
}

function singleDownloadFilename(file = {}) {
  return path.posix.basename(String(file.path || 'notus-export.md')) || 'notus-export.md';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const ids = String(req.query.ids || '')
    .split(',')
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  const paths = String(req.query.paths || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const folder = String(req.query.folder || '').trim();
  const mode = String(req.query.mode || '').trim();

  const files = uniqueFiles([
    ...listFilesByIds(ids),
    ...listFilesByPaths(paths),
    ...(folder ? listFilesByFolder(folder) : []),
  ]);

  if (files.length === 0) {
    return res.status(400).json({ error: '至少选择一个文件', code: 'NO_FILES_SELECTED' });
  }

  if (mode === 'file') {
    if (files.length !== 1 || folder) {
      return res.status(400).json({ error: '单文件下载只能选择一个 Markdown 文件', code: 'INVALID_SINGLE_FILE_EXPORT' });
    }
    const file = files[0];
    const target = resolveInside(getEffectiveConfig().notesDir, file.path);
    if (!fs.existsSync(target.absolutePath)) {
      return res.status(404).json({ error: '文件不存在', code: 'FILE_NOT_FOUND' });
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', encodeContentDispositionFilename(singleDownloadFilename(file)));
    return res.status(200).send(fs.readFileSync(target.absolutePath));
  }

  const folderName = folder ? path.posix.basename(normalizeRelativePath(folder)) : '';
  const filename = folderName
    ? `${folderName}.zip`
    : `notus-export-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', encodeContentDispositionFilename(filename));

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message, code: 'EXPORT_FAILED' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);

  const config = getEffectiveConfig();
  const notesRootName = path.basename(path.resolve(config.notesDir)) || 'notes';
  const notesRoot = path.resolve(config.notesDir);
  const assetsRoot = path.resolve(config.assetsDir);
  const assetsInsideNotes = assetsRoot === notesRoot || assetsRoot.startsWith(`${notesRoot}${path.sep}`);
  const assetsArchiveRoot = assetsInsideNotes
    ? path.posix.join(notesRootName, path.relative(notesRoot, assetsRoot).replace(/\\/g, '/'))
    : (path.basename(assetsRoot) || 'assets');
  files.forEach((file) => {
    const target = resolveInside(config.notesDir, file.path);
    if (fs.existsSync(target.absolutePath)) {
      archive.file(target.absolutePath, { name: path.posix.join(notesRootName, file.path) });
    }
  });

  if (fs.existsSync(config.assetsDir)) {
    archive.directory(config.assetsDir, assetsArchiveRoot);
  }

  await archive.finalize();
}
