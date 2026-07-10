const { ensureRuntime } = require('../../../lib/runtime');
const {
  applyFileSystemPatch,
  normalizeFileSystemPatch,
  rollbackFileSystemPatch,
} = require('../../../lib/fileSystemPatches');
const { createLogger, createRequestContext } = require('../../../lib/logger');

function nowIso() {
  return new Date().toISOString();
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/files/operations');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('files.operations.runtime.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const { action = 'preview', patch = null, patches = [], force = false } = req.body || {};

  try {
    if (action === 'preview') {
      const list = Array.isArray(patches) && patches.length > 0 ? patches : [patch].filter(Boolean);
      const normalized = list.map((item) => normalizeFileSystemPatch(item, { captureDeleteSnapshot: true }));
      return res.status(200).json({
        success: true,
        patches: normalized.map((item, index) => ({
          patch_id: item.patch_id || `sidebar-fs-${Date.now()}-${index}`,
          status: 'pending',
          ...item,
        })),
        request_id: context.request_id,
      });
    }

    if (action === 'apply') {
      const result = await applyFileSystemPatch(patch, { force });
      if (!result.success) {
        return res.status(result.conflict ? 409 : 400).json({ ...result, request_id: context.request_id });
      }
      return res.status(200).json({
        success: true,
        patch: {
          ...(patch || {}),
          ...(result.patch || {}),
          status: 'applied',
          handled_at: nowIso(),
          error: '',
        },
        changed_files: result.changed_files || [],
        request_id: context.request_id,
      });
    }

    if (action === 'rollback') {
      const result = await rollbackFileSystemPatch(patch, { force });
      if (!result.success) {
        return res.status(result.conflict ? 409 : 400).json({ ...result, request_id: context.request_id });
      }
      return res.status(200).json({
        success: true,
        patch: {
          ...(patch || {}),
          ...(result.patch || {}),
          status: 'rolled_back',
          handled_at: nowIso(),
          error: '',
        },
        changed_files: result.changed_files || [],
        request_id: context.request_id,
      });
    }

    return res.status(400).json({ error: `unsupported action: ${action}`, code: 'UNSUPPORTED_ACTION', request_id: context.request_id });
  } catch (error) {
    logger.error('files.operations.failed', { error, body: req.body || null });
    return res.status(400).json({ error: error.message, code: 'FILE_OPERATION_FAILED', request_id: context.request_id });
  }
}
