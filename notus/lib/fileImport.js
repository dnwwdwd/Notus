const fs = require('fs');
const { getEffectiveConfig } = require('./config');
const {
  ensureMarkdownPath,
  getFileByPath,
  normalizeRelativePath,
  resolveInside,
  saveFileByPath,
} = require('./files');
const { indexFileWithFallback } = require('./fileIndexing');
const {
  buildItemKey,
  getJobRecord,
  normalizeJobId,
  pruneImportJobs,
  saveJobRecord,
} = require('./importJobs');

// 单次请求的导入预算：客户端已按同样的量级分批，这里是防止超大单请求撑爆 body 与内存的兜底。
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
// 普通批上传的单文件上限：受单次请求体量约束，超过即改用分片通道。
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// 分片通道的单文件上限：内容在服务端拼接，不经过单次请求体，
// 因此可以显著放宽；这里仍设上限以避免拼接与索引时无界占用内存。
const MAX_CHUNKED_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 240;
// 作业记录里“已完成”的两种终态：重试或断线重连时直接回放，不再重复写盘与索引。
const COMPLETED_JOB_STATUSES = new Set(['imported', 'overwritten']);

function importError(message, code) {
  return Object.assign(new Error(message), { code });
}

function buildTargetPath(parentPath, name) {
  const rawName = String(name == null ? '' : name);
  if (rawName.includes('\0')) throw importError('文件名包含非法字符', 'IMPORT_FILE_NAME_INVALID');
  const trimmedName = rawName.trim();
  if (!trimmedName) throw importError('文件名不能为空', 'IMPORT_FILE_NAME_INVALID');
  if (trimmedName.length > MAX_FILE_NAME_LENGTH) {
    throw importError(`文件名过长（上限 ${MAX_FILE_NAME_LENGTH} 字符）`, 'IMPORT_FILE_NAME_TOO_LONG');
  }
  let normalizedName;
  try {
    normalizedName = normalizeRelativePath(trimmedName.replace(/\\/g, '/'));
  } catch {
    throw importError('文件名或相对路径无效', 'IMPORT_FILE_PATH_INVALID');
  }
  let normalizedParent = '';
  if (parentPath) {
    try {
      normalizedParent = normalizeRelativePath(parentPath);
    } catch {
      throw importError('导入目录无效', 'IMPORT_PARENT_PATH_INVALID');
    }
  }
  return ensureMarkdownPath([normalizedParent, normalizedName].filter(Boolean).join('/'));
}

function normalizeBudget(value, fallback, minimum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

function resolveBudgets(options = {}) {
  return {
    maxFiles: normalizeBudget(options.maxFiles, DEFAULT_MAX_FILES, 1),
    maxBytes: normalizeBudget(options.maxBytes, DEFAULT_MAX_BYTES, 1024),
  };
}

// 事务性边界是“单个文件”：写盘 + 落库 + 作业记录要么一起成功，要么回滚到可重试状态，
// 绝不因为某个文件失败而回滚或中断同批次其它文件。
function rollbackUntrackedWrite(targetPath, existedBefore) {
  if (existedBefore) return;
  try {
    const target = resolveInside(getEffectiveConfig().notesDir, targetPath);
    if (fs.existsSync(target.absolutePath)) fs.unlinkSync(target.absolutePath);
  } catch {
    // 回滚失败不改变本次文件的失败结论，作业记录仍是 failed，可再次重试。
  }
}

function resolvePreviousResult(jobId, parentPath, name) {
  if (!jobId) return null;
  try {
    return getJobRecord(jobId, buildItemKey(parentPath, name));
  } catch {
    return null;
  }
}

function rememberResult(jobId, entry) {
  if (!jobId) return;
  try {
    saveJobRecord({ jobId, ...entry });
  } catch {
    // 作业记录写入失败不能影响文件本身的导入结果，最坏情况只是重试时重复处理。
  }
}

// 单文件导入：分批接口与分片接口共用同一实现，保证幂等、事务与冲突策略只有一处定义。
// 返回 { status, path, id, warning, warningCode, replay }，抛出的错误由调用方按上下文收口。
// maxBytes 由调用方按通道给出：普通批上传受单次请求体量约束，分片通道的内容已在服务端拼接。
async function importSingleFile({
  parentPath = '',
  conflictPolicy = 'skip',
  displayName,
  content,
  jobId = '',
  logger = null,
  onEvent = null,
  maxBytes = MAX_FILE_BYTES,
}) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const resolvedJobId = normalizeJobId(jobId);
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (contentBytes > maxBytes) {
    throw importError(
      `单个文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，请先拆分后再导入`,
      'IMPORT_FILE_TOO_LARGE'
    );
  }

  const targetPath = buildTargetPath(parentPath, displayName);
  if (!/\.md$/i.test(targetPath)) {
    throw importError('仅支持导入 .md 文件', 'IMPORT_UNSUPPORTED_FILE_TYPE');
  }

  // 幂等回放：同一 job 内已经成功落盘的文件，重发这一批时直接返回既有结果，
  // 既不重复写盘，也不重复索引，更不会因冲突策略变化被改判为跳过。
  const previous = resolvePreviousResult(resolvedJobId, parentPath, displayName);
  if (previous && COMPLETED_JOB_STATUSES.has(String(previous.status || ''))) {
    const replayed = String(previous.status) === 'overwritten' ? 'overwritten' : 'imported';
    emit({
      type: 'file',
      status: replayed,
      name: displayName,
      path: previous.path || targetPath,
      replay: true,
      warning: previous.warning || undefined,
      warning_code: previous.warning_code || undefined,
    });
    return {
      status: replayed,
      path: previous.path || targetPath,
      replay: true,
      warning: previous.warning || '',
      warningCode: previous.warning_code || '',
    };
  }

  const existing = getFileByPath(targetPath);
  if (existing && conflictPolicy === 'skip') {
    if (!previous || String(previous.status || '') !== 'skipped') {
      rememberResult(resolvedJobId, {
        itemKey: buildItemKey(parentPath, displayName),
        parentPath,
        name: displayName,
        status: 'skipped',
        path: targetPath,
      });
    }
    emit({ type: 'file', status: 'skipped', name: displayName, path: targetPath });
    return { status: 'skipped', path: targetPath, replay: false };
  }

  let saved;
  try {
    saved = saveFileByPath(targetPath, content, { titleFromFileName: true });
  } catch (error) {
    rollbackUntrackedWrite(targetPath, Boolean(existing));
    throw error;
  }

  emit({ type: 'progress', stage: 'indexing', currentFile: saved.path });

  const indexResult = await indexFileWithFallback(saved.path, logger, {
    action: 'import',
    job_id: resolvedJobId || undefined,
  });

  rememberResult(resolvedJobId, {
    itemKey: buildItemKey(parentPath, displayName),
    parentPath,
    name: displayName,
    status: existing ? 'overwritten' : 'imported',
    path: saved.path,
    warning: indexResult.warning || '',
    warningCode: indexResult.warning_code || '',
  });

  const status = existing ? 'overwritten' : 'imported';
  emit({
    type: 'file',
    status,
    id: saved.id,
    name: displayName,
    path: saved.path,
    indexed: indexResult.indexed,
    warning: indexResult.warning,
    warning_code: indexResult.warning_code,
  });

  return {
    status,
    path: saved.path,
    id: saved.id,
    indexed: indexResult.indexed,
    warning: indexResult.warning || '',
    warningCode: indexResult.warning_code || '',
    replay: false,
  };
}

async function importFileBatch(options = {}) {
  const {
    parentPath = '',
    conflictPolicy = 'skip',
    files = [],
    jobId = '',
    logger = null,
    onEvent = null,
  } = options;
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const budgets = resolveBudgets(options);
  const resolvedJobId = normalizeJobId(jobId);
  const summary = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    failed: 0,
    warnings: 0,
    errors: [],
    warning_items: [],
  };

  let processed = 0;
  let workItems = 0;
  let bytesUsed = 0;
  let remaining = 0;

  for (let index = 0; index < files.length; index += 1) {
    // 预算只统计真正需要写盘与索引的文件：已完成的回放项与跳过项不占预算，
    // 否则续传批次会被已完成项反复占满，无法推进。
    if (workItems > 0 && (workItems >= budgets.maxFiles || bytesUsed >= budgets.maxBytes)) {
      remaining = files.length - index;
      break;
    }

    const current = files[index] || {};
    const displayName = String(current.name == null ? '' : current.name).trim() || `文件-${index + 1}.md`;
    const content = current.content == null ? '' : String(current.content);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    processed += 1;

    emit({
      type: 'progress',
      stage: 'saving',
      current: index + 1,
      total: files.length,
      currentFile: displayName,
    });

    try {
      const result = await importSingleFile({
        parentPath,
        conflictPolicy,
        displayName,
        content,
        jobId: resolvedJobId,
        logger,
        onEvent: (event) => {
          if (event.type === 'progress') {
            emit({
              ...event,
              stage: event.stage || 'saving',
              current: index + 1,
              total: files.length,
              currentFile: event.currentFile || displayName,
            });
            return;
          }
          emit(event);
        },
      });

      // 回放与跳过项不占用预算，避免续传批次被已完成项反复占满。
      if (result.replay) {
        if (result.status === 'overwritten') summary.overwritten += 1;
        else summary.imported += 1;
      } else if (result.status === 'skipped') {
        summary.skipped += 1;
      } else {
        workItems += 1;
        bytesUsed += contentBytes;
        if (result.status === 'overwritten') summary.overwritten += 1;
        else summary.imported += 1;
      }

      if (result.warning) {
        summary.warnings += 1;
        summary.warning_items.push({
          path: result.path,
          error: result.warning,
          error_code: result.warningCode || 'INDEX_FAILED',
        });
      }
    } catch (error) {
      const message = error?.message || '导入失败';
      const code = error?.code || 'IMPORT_FILE_FAILED';
      summary.failed += 1;
      summary.errors.push({ name: displayName, error: message, code });
      logger?.error('files.import.file_failed', { file_name: displayName, error });
      rememberResult(resolvedJobId, {
        itemKey: buildItemKey(parentPath, displayName),
        parentPath,
        name: displayName,
        status: 'failed',
        warning: message,
        warningCode: code,
      });
      emit({
        type: 'file',
        status: 'failed',
        name: displayName,
        error: message,
        error_code: code,
      });
    }
  }

  const hasMore = remaining > 0;
  return { summary, remaining, hasMore, processed, budgets, jobId: resolvedJobId };
}

module.exports = {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_BYTES,
  MAX_FILE_BYTES,
  MAX_CHUNKED_FILE_BYTES,
  MAX_FILE_NAME_LENGTH,
  buildTargetPath,
  importFileBatch,
  importSingleFile,
  pruneImportJobs,
  resolveBudgets,
};
