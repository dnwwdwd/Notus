const { ensureRuntime } = require('../../../lib/runtime');
const { importFileBatch, pruneImportJobs, resolveBudgets, DEFAULT_MAX_FILES, DEFAULT_MAX_BYTES } = require('../../../lib/fileImport');
const { normalizeJobId } = require('../../../lib/importJobs');
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
    job_id: jobId = '',
    max_files: maxFiles,
    max_bytes: maxBytes,
  } = req.body || {};

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files is required', code: 'FILES_REQUIRED', request_id: context.request_id });
  }
  if (!['skip', 'overwrite'].includes(conflictPolicy)) {
    return res.status(400).json({ error: 'conflict_policy must be skip or overwrite', code: 'INVALID_CONFLICT_POLICY', request_id: context.request_id });
  }
  let resolvedJobId = '';
  try {
    resolvedJobId = normalizeJobId(jobId);
  } catch (error) {
    return res.status(400).json({ error: error.message, code: error.code || 'IMPORT_JOB_ID_INVALID', request_id: context.request_id });
  }

  const budgets = resolveBudgets({ maxFiles, maxBytes });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  logger.info('files.import.started', {
    total: files.length,
    parent_path: parentPath || '',
    conflict_policy: conflictPolicy,
    job_id: resolvedJobId || null,
    max_files: budgets.maxFiles,
    max_bytes: budgets.maxBytes,
  });

  try {
    pruneImportJobs();
  } catch (error) {
    logger.warn('files.import.prune_failed', { error });
  }

  const result = await importFileBatch({
    parentPath,
    conflictPolicy,
    files,
    jobId: resolvedJobId,
    maxFiles: budgets.maxFiles,
    maxBytes: budgets.maxBytes,
    logger,
    onEvent: (event) => send(res, event),
  });

  const { summary, remaining } = result;
  const paused = remaining > 0;

  logger.info(paused ? 'files.import.paused' : 'files.import.completed', {
    total: files.length,
    imported: summary.imported,
    overwritten: summary.overwritten,
    skipped: summary.skipped,
    failed: summary.failed,
    warnings: summary.warnings,
    remaining,
    job_id: resolvedJobId || null,
  });

  send(res, {
    type: 'done',
    ...summary,
    total: files.length,
    processed: result.processed,
    remaining,
    paused,
    job_id: resolvedJobId || null,
    default_max_files: DEFAULT_MAX_FILES,
    default_max_bytes: DEFAULT_MAX_BYTES,
    request_id: context.request_id,
  });
  res.end();
}
