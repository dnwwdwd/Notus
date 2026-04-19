const fs = require('fs');
const archiver = require('archiver');
const { ensureRuntime } = require('../../../lib/runtime');
const { getEffectiveConfig } = require('../../../lib/config');
const { listFilesByIds, listFilesByPaths, resolveInside } = require('../../../lib/files');

function uniqueFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    if (!file?.path || seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
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

  const files = uniqueFiles([
    ...listFilesByIds(ids),
    ...listFilesByPaths(paths),
  ]);

  if (files.length === 0) {
    return res.status(400).json({ error: '至少选择一个文件', code: 'NO_FILES_SELECTED' });
  }

  const filename = `notus-export-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

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
  files.forEach((file) => {
    const target = resolveInside(config.notesDir, file.path);
    if (fs.existsSync(target.absolutePath)) {
      archive.file(target.absolutePath, { name: file.path });
    }
  });

  await archive.finalize();
}
