const { ensureRuntime } = require('../../../lib/runtime');
const {
  getGenerationById,
  sanitizeGenerationForApi,
} = require('../../../lib/indexGenerations');
const { getIndexCoordinator } = require('../../../lib/indexCoordinator');
const { createLogger, createRequestContext } = require('../../../lib/logger');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const generation = getIndexCoordinator().startRebuild({ kind: 'manual_rebuild' });
    send(res, {
      type: 'queued',
      generation: sanitizeGenerationForApi(generation),
      request_id: context.request_id,
    });

    let lastSignature = '';
    while (true) {
      const latest = getGenerationById(generation.id);
      if (!latest) {
        break;
      }

      const progress = latest.progress_object || {};
      const signature = JSON.stringify([
        latest.state,
        latest.processed_files,
        latest.total_files,
        progress.current,
        progress.total,
        progress.currentFile,
        progress.status,
        progress.dirty_files,
        progress.error,
      ]);

      if (signature !== lastSignature) {
        lastSignature = signature;

        if (latest.state === 'catching_up') {
          send(res, {
            type: 'catching_up',
            generation_id: latest.id,
            dirty_files: Number(progress.dirty_files || 0),
            currentFile: progress.currentFile || '',
            request_id: context.request_id,
          });
        } else if (latest.state === 'failed') {
          send(res, {
            type: 'failed',
            generation_id: latest.id,
            error: progress.error || latest.error_summary || '索引重建失败',
            request_id: context.request_id,
          });
          send(res, {
            type: 'done',
            generation: sanitizeGenerationForApi(latest),
            failed: 1,
            request_id: context.request_id,
          });
          break;
        } else {
          send(res, {
            type: 'progress',
            generation_id: latest.id,
            current: Number(progress.current || latest.processed_files || 0),
            total: Number(progress.total || latest.total_files || 0),
            currentFile: progress.currentFile || '',
            status: progress.status || latest.state,
            error: progress.error || null,
            request_id: context.request_id,
          });
        }
      }

      if (latest.activated_at || latest.state === 'active') {
        send(res, {
          type: 'activated',
          generation: sanitizeGenerationForApi(latest),
          request_id: context.request_id,
        });
        send(res, {
          type: 'done',
          generation: sanitizeGenerationForApi(latest),
          indexed: Number(latest.total_files || 0),
          skipped: 0,
          failed: 0,
          total: Number(latest.total_files || 0),
          request_id: context.request_id,
        });
        break;
      }

      await sleep(500);
    }
  } catch (error) {
    logger.error('index.rebuild.failed', { error });
    send(res, { type: 'failed', error: error.message, request_id: context.request_id });
    send(res, { type: 'done', failed: 1, request_id: context.request_id });
  }

  res.end();
}
