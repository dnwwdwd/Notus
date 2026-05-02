const { ensureRuntime } = require('../../../lib/runtime');
const { applyOperation, applyOperations } = require('../../../lib/diff');
const { createLogger, createRequestContext } = require('../../../lib/logger');
const {
  markOperationSetStatus,
} = require('../../../lib/canvasOperationSets');

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
