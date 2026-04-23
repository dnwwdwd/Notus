const { ensureRuntime } = require('../../../lib/runtime');
const { ensureMarkdownPath, getFileByPath, normalizeRelativePath, saveFileByPath } = require('../../../lib/files');
const { queueFileIndexing } = require('../../../lib/fileIndexing');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildTargetPath(parentPath, name) {
  const normalizedName = normalizeRelativePath(String(name || '').replace(/\\/g, '/'));
  const normalizedParent = parentPath ? normalizeRelativePath(parentPath) : '';
  return ensureMarkdownPath([normalizedParent, normalizedName].filter(Boolean).join('/'));
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/files/import');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('files.import.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const {
    parentPath = '',
    conflict_policy: conflictPolicy = 'skip',
    files = [],
  } = req.body || {};

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files is required', code: 'FILES_REQUIRED', request_id: context.request_id });
  }
  if (!['skip', 'overwrite'].includes(conflictPolicy)) {
    return res.status(400).json({ error: 'conflict_policy must be skip or overwrite', code: 'INVALID_CONFLICT_POLICY', request_id: context.request_id });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const summary = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    failed: 0,
    warnings: 0,
    errors: [],
    warning_items: [],
  };

  logger.info('files.import.started', {
    total: files.length,
    parent_path: parentPath || '',
    conflict_policy: conflictPolicy,
  });

  for (let index = 0; index < files.length; index += 1) {
    const current = files[index] || {};
    const displayName = current.name || `文件-${index + 1}.md`;
    send(res, {
      type: 'progress',
      stage: 'saving',
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
      const indexResult = await queueFileIndexing(saved.path, logger, { action: 'import' });
      if (existing) summary.overwritten += 1;
      else summary.imported += 1;

      send(res, {
        type: 'file',
        status: existing ? 'overwritten' : 'imported',
        id: saved.id,
        name: displayName,
        path: saved.path,
        index_state: indexResult.index_state,
        active_generation_id: indexResult.active_generation_id,
      });
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ name: displayName, error: error.message });
      logger.error('files.import.file_failed', { file_name: displayName, error });
      send(res, {
        type: 'file',
        status: 'failed',
        name: displayName,
        error: error.message,
      });
    }
  }

  logger.info('files.import.completed', {
    total: files.length,
    imported: summary.imported,
    overwritten: summary.overwritten,
    skipped: summary.skipped,
    failed: summary.failed,
    warnings: summary.warnings,
  });

  send(res, { type: 'done', ...summary, total: files.length, request_id: context.request_id });
  res.end();
}
