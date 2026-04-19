const path = require('path');
const { ensureRuntime } = require('../../../lib/runtime');
const { ensureMarkdownPath, getFileByPath, normalizeRelativePath, saveFileByPath } = require('../../../lib/files');
const { indexFile } = require('../../../lib/indexer');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildTargetPath(parentPath, name) {
  const normalizedName = normalizeRelativePath(String(name || '').replace(/\\/g, '/'));
  const normalizedParent = parentPath ? normalizeRelativePath(parentPath) : '';
  return ensureMarkdownPath([normalizedParent, normalizedName].filter(Boolean).join('/'));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const {
    parentPath = '',
    conflict_policy: conflictPolicy = 'skip',
    files = [],
  } = req.body || {};

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files is required', code: 'FILES_REQUIRED' });
  }
  if (!['skip', 'overwrite'].includes(conflictPolicy)) {
    return res.status(400).json({ error: 'conflict_policy must be skip or overwrite', code: 'INVALID_CONFLICT_POLICY' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const summary = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (let index = 0; index < files.length; index += 1) {
    const current = files[index] || {};
    const displayName = current.name || `文件-${index + 1}.md`;
    send(res, {
      type: 'progress',
      current: index + 1,
      total: files.length,
      currentFile: displayName,
    });

    try {
      const targetPath = buildTargetPath(parentPath, displayName);
      if (!/\.md$/i.test(targetPath)) {
        throw new Error('仅支持导入 .md 文件');
      }

      const existing = getFileByPath(targetPath);
      if (existing && conflictPolicy === 'skip') {
        summary.skipped += 1;
        send(res, {
          type: 'file',
          status: 'skipped',
          name: displayName,
          path: targetPath,
        });
        continue;
      }

      const saved = saveFileByPath(targetPath, String(current.content || ''));
      const indexResult = await indexFile(saved.path);
      if (existing) summary.overwritten += 1;
      else summary.imported += 1;

      send(res, {
        type: 'file',
        status: existing ? 'overwritten' : 'imported',
        id: saved.id,
        name: displayName,
        path: saved.path,
        indexed: indexResult.embeddingFailed ? 0 : 1,
      });
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ name: displayName, error: error.message });
      send(res, {
        type: 'file',
        status: 'failed',
        name: displayName,
        error: error.message,
      });
    }
  }

  send(res, { type: 'done', ...summary, total: files.length });
  return res.end();
}
