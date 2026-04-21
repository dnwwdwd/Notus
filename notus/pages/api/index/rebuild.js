const { ensureRuntime } = require('../../../lib/runtime');
const { rebuildIndex } = require('../../../lib/indexer');
const { listMarkdownFiles } = require('../../../lib/files');
const { createLogger, createRequestContext } = require('../../../lib/logger');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/index/rebuild');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('index.rebuild.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const files = listMarkdownFiles();
    logger.info('index.rebuild.started', { total: files.length });
    if (files.length === 0) {
      send(res, { type: 'done', total: 0, indexed: 0, skipped: 0, failed: 0, request_id: context.request_id });
      res.end();
      return;
    }

    const result = await rebuildIndex((progress) => {
      send(res, { type: 'progress', ...progress });
    });
    logger.info('index.rebuild.completed', { total: files.length, ...result });
    send(res, { type: 'done', total: files.length, ...result, request_id: context.request_id });
  } catch (error) {
    logger.error('index.rebuild.failed', { error });
    send(res, { type: 'error', error: error.message, request_id: context.request_id });
  }

  res.end();
}
