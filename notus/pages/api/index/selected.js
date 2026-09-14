const { ensureRuntime } = require('../../../lib/runtime');
const { getDb } = require('../../../lib/db');
const { indexSelectedPaths } = require('../../../lib/indexer');
const { createLogger, createRequestContext } = require('../../../lib/logger');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeFileIds(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/index/selected');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('index.selected.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const fileIds = normalizeFileIds(req.body?.file_ids);
  if (fileIds.length === 0) {
    return res.status(400).json({ error: '至少选择一个待索引文件', code: 'FILE_IDS_REQUIRED', request_id: context.request_id });
  }

  const db = getDb();
  const lookup = db.prepare('SELECT id, path FROM files WHERE id = ? AND indexed = 0');
  const selected = fileIds.map((id) => lookup.get(id)).filter(Boolean);
  const selectedIds = new Set(selected.map((row) => Number(row.id)));
  const skipped = fileIds
    .filter((id) => !selectedIds.has(id))
    .map((id) => ({ id, reason: '文件已索引、已删除或不再可处理' }));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const result = selected.length > 0
      ? await indexSelectedPaths(selected.map((row) => row.path), (progress) => send(res, { type: 'progress', ...progress }))
      : { indexed: 0, skipped: 0, failed: 0, errors: [] };
    const summary = {
      ...result,
      skipped: Number(result.skipped || 0) + skipped.length,
      skipped_items: skipped,
      total: fileIds.length,
      request_id: context.request_id,
    };
    logger.info('index.selected.completed', {
      requested: fileIds.length,
      processed: selected.length,
      ...summary,
    });
    send(res, { type: 'done', ...summary });
  } catch (error) {
    if (error.code === 'INDEX_BATCH_IN_PROGRESS') {
      send(res, { type: 'error', error: error.message, code: error.code, request_id: context.request_id });
    } else {
      logger.error('index.selected.failed', { error, requested: fileIds.length });
      send(res, { type: 'error', error: error.message, code: error.code || 'INDEX_SELECTED_FAILED', request_id: context.request_id });
    }
  }

  res.end();
}
