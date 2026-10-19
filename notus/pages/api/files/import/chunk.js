const { ensureRuntime } = require('../../../../lib/runtime');
const { importSingleFile, MAX_CHUNKED_FILE_BYTES } = require('../../../../lib/fileImport');
const {
  MAX_CHUNK_BYTES,
  MAX_TOTAL_CHUNKS,
  assembleChunks,
  pruneImportChunks,
  removeStagingItem,
  saveChunkRecord,
  writeChunkFile,
} = require('../../../../lib/importChunks');
const { buildItemKey, getJobRecord, normalizeJobId, pruneImportJobs } = require('../../../../lib/importJobs');
const { createLogger, createRequestContext } = require('../../../../lib/logger');

export const config = {
  api: {
    bodyParser: {
      // 单片上限 4MiB，留足 JSON 包装与转义余量，远低于整体导入的 50mb 兜底。
      sizeLimit: '12mb',
    },
  },
};

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseChunkIndex(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : NaN;
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/files/import/chunk');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('files.import.chunk_runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const {
    parentPath = '',
    conflict_policy: conflictPolicy = 'skip',
    job_id: jobId = '',
    name = '',
    chunk_index: chunkIndexRaw,
    total_chunks: totalChunksRaw,
    content = '',
    finalize: finalizeRaw,
  } = req.body || {};

  const displayName = String(name || '').trim();
  if (!displayName) {
    return res.status(400).json({ error: 'name is required', code: 'IMPORT_CHUNK_NAME_REQUIRED', request_id: context.request_id });
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
  if (!resolvedJobId) {
    return res.status(400).json({ error: '分片上传必须携带 job_id', code: 'IMPORT_CHUNK_JOB_REQUIRED', request_id: context.request_id });
  }

  const chunkIndex = parseChunkIndex(chunkIndexRaw);
  const totalChunks = parseChunkIndex(totalChunksRaw);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return res.status(400).json({ error: 'chunk_index 必须是从 0 开始的整数', code: 'IMPORT_CHUNK_INDEX_INVALID', request_id: context.request_id });
  }
  if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_TOTAL_CHUNKS) {
    return res.status(400).json({ error: `total_chunks 必须是 1 到 ${MAX_TOTAL_CHUNKS} 之间的整数`, code: 'IMPORT_CHUNK_TOTAL_INVALID', request_id: context.request_id });
  }
  if (chunkIndex >= totalChunks) {
    return res.status(400).json({ error: 'chunk_index 不能大于等于 total_chunks', code: 'IMPORT_CHUNK_INDEX_INVALID', request_id: context.request_id });
  }

  const chunkContent = content == null ? '' : String(content);
  if (Buffer.byteLength(chunkContent, 'utf8') > MAX_CHUNK_BYTES) {
    return res.status(413).json({
      error: `单个分片超过 ${Math.round(MAX_CHUNK_BYTES / 1024 / 1024)}MB 上限，请缩小分片体积后重试`,
      code: 'IMPORT_CHUNK_TOO_LARGE',
      request_id: context.request_id,
    });
  }

  const itemKey = buildItemKey(parentPath, displayName);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    pruneImportJobs();
    pruneImportChunks();
  } catch (error) {
    logger.warn('files.import.chunk_prune_failed', { error });
  }

  // 幂等回放优先于分片处理：同一 job 内该文件已经成功落盘时，直接回放既有结果，
  // 不再接收分片，也不重复写盘与索引。
  const previous = getJobRecord(resolvedJobId, itemKey);
  if (previous && ['imported', 'overwritten'].includes(String(previous.status || ''))) {
    const replayed = String(previous.status) === 'overwritten' ? 'overwritten' : 'imported';
    logger.info('files.import.chunk_replay', { name: displayName, job_id: resolvedJobId });
    send(res, {
      type: 'file',
      status: replayed,
      name: displayName,
      path: previous.path || '',
      replay: true,
    });
    send(res, {
      type: 'done',
      imported: replayed === 'imported' ? 1 : 0,
      overwritten: replayed === 'overwritten' ? 1 : 0,
      skipped: 0,
      failed: 0,
      warnings: 0,
      errors: [],
      warning_items: [],
      total: 1,
      processed: 1,
      remaining: 0,
      paused: false,
      job_id: resolvedJobId,
      request_id: context.request_id,
    });
    res.end();
    return;
  }

  try {
    const written = writeChunkFile({ jobId: resolvedJobId, itemKey, chunkIndex, content: chunkContent });
    saveChunkRecord({
      jobId: resolvedJobId,
      itemKey,
      chunkIndex,
      totalChunks,
      bytes: written.bytes,
      digest: written.digest,
    });

    const assembled = assembleChunks(resolvedJobId, itemKey);
    const received = assembled.totalChunks - assembled.missing.length;

    send(res, {
      type: 'progress',
      stage: assembled.complete ? 'indexing' : 'chunk',
      current: received,
      total: assembled.totalChunks,
      currentFile: displayName,
    });

    // 未齐片：正常返回，客户端继续提交剩余分片。
    if (!assembled.complete) {
      logger.info('files.import.chunk_received', {
        name: displayName,
        job_id: resolvedJobId,
        chunk_index: chunkIndex,
        received,
        total_chunks: assembled.totalChunks,
        reused: written.reused,
      });
      send(res, {
        type: 'chunk',
        name: displayName,
        chunk_index: chunkIndex,
        received,
        total_chunks: assembled.totalChunks,
        missing: assembled.missing,
        reused: written.reused,
        complete: false,
        job_id: resolvedJobId,
      });
      send(res, {
        type: 'done',
        imported: 0,
        overwritten: 0,
        skipped: 0,
        failed: 0,
        warnings: 0,
        errors: [],
        warning_items: [],
        total: 1,
        processed: 1,
        remaining: 0,
        paused: false,
        complete: false,
        job_id: resolvedJobId,
        request_id: context.request_id,
      });
      res.end();
      return;
    }

    // 齐片：拼接完整内容后走与普通导入完全相同的单文件链路（幂等、事务、索引降级一致）。
    // 分片通道的内容不经过单次请求体，因此使用更宽的单文件上限。
    const assembledBytes = Buffer.byteLength(assembled.content, 'utf8');
    if (assembledBytes > MAX_CHUNKED_FILE_BYTES) {
      removeStagingItem(resolvedJobId, itemKey);
      throw Object.assign(
        new Error(`单个文件超过 ${Math.round(MAX_CHUNKED_FILE_BYTES / 1024 / 1024)}MB 上限，请先拆分后再导入`),
        { code: 'IMPORT_FILE_TOO_LARGE' }
      );
    }

    const result = await importSingleFile({
      parentPath,
      conflictPolicy,
      displayName,
      content: assembled.content,
      jobId: resolvedJobId,
      logger,
      maxBytes: MAX_CHUNKED_FILE_BYTES,
      onEvent: (event) => send(res, event),
    });

    removeStagingItem(resolvedJobId, itemKey);

    const warnings = result.warning ? 1 : 0;
    logger.info('files.import.chunk_completed', {
      name: displayName,
      job_id: resolvedJobId,
      total_chunks: assembled.totalChunks,
      status: result.status,
    });
    send(res, {
      type: 'done',
      imported: result.status === 'imported' ? 1 : 0,
      overwritten: result.status === 'overwritten' ? 1 : 0,
      skipped: result.status === 'skipped' ? 1 : 0,
      failed: 0,
      warnings,
      errors: [],
      warning_items: result.warning ? [{ path: result.path, error: result.warning, error_code: result.warningCode || 'INDEX_FAILED' }] : [],
      total: 1,
      processed: 1,
      remaining: 0,
      paused: false,
      complete: true,
      job_id: resolvedJobId,
      request_id: context.request_id,
    });
    res.end();
  } catch (error) {
    const message = error?.message || '分片处理失败';
    const code = error?.code || 'IMPORT_CHUNK_FAILED';
    logger.error('files.import.chunk_failed', { name: displayName, chunk_index: chunkIndex, error });
    send(res, {
      type: 'file',
      status: 'failed',
      name: displayName,
      error: message,
      error_code: code,
    });
    send(res, {
      type: 'done',
      imported: 0,
      overwritten: 0,
      skipped: 0,
      failed: 1,
      warnings: 0,
      errors: [{ name: displayName, error: message, code }],
      warning_items: [],
      total: 1,
      processed: 1,
      remaining: 0,
      paused: false,
      complete: false,
      job_id: resolvedJobId,
      request_id: context.request_id,
    });
    res.end();
  }
}
