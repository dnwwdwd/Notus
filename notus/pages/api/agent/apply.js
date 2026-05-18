const { ensureRuntime } = require('../../../lib/runtime');
const { applyOperation, applyOperations } = require('../../../lib/diff');
const { createLogger, createRequestContext } = require('../../../lib/logger');
const {
  computeArticleHash,
  getOperationSetById,
  markOperationSetStatus,
} = require('../../../lib/canvasOperationSets');
const { getConversation } = require('../../../lib/conversations');
const { getFileById, sha256 } = require('../../../lib/files');
const {
  normalizeScope,
  resolveScopeFileIds,
} = require('../../../lib/workspaceScope');

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function getRequestFileHash(input = {}) {
  return String(input.file_hash || input.fileHash || input.article?.file_hash || input.article?.fileHash || '').trim();
}

function validateWriteScope(operationSet) {
  const fileId = normalizePositiveInt(operationSet?.file_id);
  if (!fileId) return { ok: true };
  const conversation = getConversation(operationSet.conversation_id);
  if (!conversation) {
    return {
      ok: false,
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
      error: '对话不存在，不能应用这次预览',
    };
  }
  const writeScope = conversation.write_scope || { type: 'current_file', file_id: fileId };
  const normalizedWriteScope = normalizeScope(writeScope, { type: 'current_file', file_id: fileId });
  if (normalizedWriteScope.type === 'all') return { ok: true, conversation };
  if (normalizedWriteScope.type === 'auto') {
    return {
      ok: false,
      status: 403,
      code: 'WRITE_SCOPE_FORBIDDEN',
      error: '当前写入范围需要明确指定，不能使用自动范围应用预览',
      conversation,
    };
  }
  const allowedFileIds = resolveScopeFileIds(normalizedWriteScope, { activeFileId: fileId });
  if (allowedFileIds.includes(fileId)) return { ok: true, conversation };
  return {
    ok: false,
    status: 403,
    code: 'WRITE_SCOPE_FORBIDDEN',
    error: '当前写入范围不允许应用这次预览',
    conversation,
  };
}

function validateOperationSetForApply({ operationSetId, article, requestFileHash }) {
  if (!operationSetId) return { ok: true, operationSet: null };
  const operationSet = getOperationSetById(operationSetId);
  if (!operationSet) {
    return {
      ok: false,
      status: 404,
      code: 'OPERATION_SET_NOT_FOUND',
      error: '预览记录不存在或已过期',
      operationSet: null,
    };
  }
  if (operationSet.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      code: 'OPERATION_SET_NOT_PENDING',
      error: '这次预览已经失效或已处理',
      operationSet,
    };
  }
  const currentArticleHash = computeArticleHash(article);
  if (operationSet.article_hash && currentArticleHash !== operationSet.article_hash) {
    markOperationSetStatus(operationSet.id, 'stale');
    return {
      ok: false,
      status: 409,
      code: 'ARTICLE_STALE',
      error: '文章内容已变化，需要重新生成预览',
      operationSet,
    };
  }
  const scopeValidation = validateWriteScope(operationSet);
  if (!scopeValidation.ok) return { ...scopeValidation, operationSet };

  if (requestFileHash && operationSet.file_id) {
    const file = getFileById(operationSet.file_id);
    const currentFileHash = file?.content ? sha256(file.content) : '';
    if (currentFileHash && currentFileHash !== requestFileHash) {
      markOperationSetStatus(operationSet.id, 'stale');
      return {
        ok: false,
        status: 409,
        code: 'FILE_STALE',
        error: 'Markdown 文件已变化，需要重新加载后再应用预览',
        operationSet,
      };
    }
  }

  return { ok: true, operationSet };
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/agent/apply');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('canvas.operation_set.applied', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const {
    article,
    operation,
    operations,
    operation_set_id: operationSetId,
    action = 'apply',
  } = req.body || {};

  if (action === 'cancel') {
    const operationSet = operationSetId ? markOperationSetStatus(operationSetId, 'cancelled') : null;
    logger.info('canvas.operation_set.cancelled', {
      conversation_id: operationSet?.conversation_id || null,
      file_id: operationSet?.file_id || null,
      canvas_mode: 'edit',
      scope_mode: operationSet?.mode || 'none',
      operation_kind: '',
      helper_used: false,
      operation_count: Array.isArray(operationSet?.operations) ? operationSet.operations.length : 0,
      fallback_reason: null,
      operation_set_status: operationSet?.status || 'cancelled',
    });
    return res.status(200).json({
      success: true,
      operation_set_status: operationSet?.status || 'cancelled',
      applied_count: 0,
      failed_at: null,
      request_id: context.request_id,
    });
  }

  const queue = Array.isArray(operations) && operations.length > 0
    ? operations
    : operation
      ? [operation]
      : [];

  if (!article?.blocks || queue.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'article and operation or operations are required',
      code: 'INVALID_APPLY_REQUEST',
      request_id: context.request_id,
    });
  }

  const validation = validateOperationSetForApply({
    operationSetId,
    article,
    requestFileHash: getRequestFileHash(req.body || {}),
  });
  if (!validation.ok) {
    logger.warn('canvas.operation_set.apply_rejected', {
      operation_set_id: operationSetId || null,
      code: validation.code,
      status: validation.status,
    });
    return res.status(validation.status || 409).json({
      success: false,
      error: validation.error,
      code: validation.code,
      operation_set_status: validation.operationSet?.status || null,
      request_id: context.request_id,
    });
  }

  const result = queue.length === 1
    ? (() => {
      const single = applyOperation(article, queue[0]);
      return single.success
        ? { ...single, applied_count: 1, failed_at: null }
        : { ...single, applied_count: 0, failed_at: 0 };
    })()
    : applyOperations(article, queue);

  if (!result.success) {
    const staleSet = operationSetId ? markOperationSetStatus(operationSetId, 'stale') : null;
    logger.warn('canvas.operation_set.stale', {
      conversation_id: staleSet?.conversation_id || null,
      file_id: staleSet?.file_id || null,
      canvas_mode: 'edit',
      scope_mode: staleSet?.mode || 'none',
      operation_kind: '',
      helper_used: false,
      operation_count: Array.isArray(staleSet?.operations) ? staleSet.operations.length : queue.length,
      fallback_reason: result.error || 'apply_failed',
      operation_set_status: staleSet?.status || 'stale',
    });
    return res.status(409).json({
      ...result,
      operation_set_status: staleSet?.status || null,
      request_id: context.request_id,
    });
  }

  const operationSet = operationSetId ? markOperationSetStatus(operationSetId, 'applied') : null;
  logger.info('canvas.operation_set.applied', {
    conversation_id: operationSet?.conversation_id || null,
    file_id: operationSet?.file_id || null,
    canvas_mode: 'edit',
    scope_mode: operationSet?.mode || 'none',
    operation_kind: '',
    helper_used: false,
    operation_count: Array.isArray(operationSet?.operations) ? operationSet.operations.length : queue.length,
    fallback_reason: null,
    operation_set_status: operationSet?.status || null,
  });

  return res.status(200).json({
    ...result,
    operation_set_status: operationSet?.status || null,
    request_id: context.request_id,
  });
}
