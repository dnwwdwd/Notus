const { ensureRuntime } = require('../../../../lib/runtime');
const { deleteLlmConfig, getLlmConfigById, updateLlmConfig } = require('../../../../lib/llmConfigs');
const { createLogger, createRequestContext } = require('../../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/llm-configs/[id]');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('settings.llm_configs.item.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const { id } = req.query;
  const existing = getLlmConfigById(id);
  if (!existing) {
    return res.status(404).json({ error: 'LLM 配置不存在', code: 'LLM_CONFIG_NOT_FOUND', request_id: context.request_id });
  }

  if (req.method === 'PUT') {
    try {
      const updated = updateLlmConfig(id, req.body || {});
      logger.info('settings.llm_configs.updated', {
        llm_config_id: updated.id,
        provider: updated.provider,
        model: updated.model,
        is_active: updated.is_active,
      });
      return res.status(200).json({ item: updated, request_id: context.request_id });
    } catch (error) {
      logger.warn('settings.llm_configs.update_failed', { llm_config_id: Number(id), error });
      return res.status(400).json({ error: error.message, code: 'LLM_CONFIG_UPDATE_FAILED', request_id: context.request_id });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const nextActive = deleteLlmConfig(id);
      logger.info('settings.llm_configs.deleted', {
        llm_config_id: Number(id),
        next_active_llm_config_id: nextActive?.id || null,
      });
      return res.status(200).json({
        success: true,
        next_active_llm_config_id: nextActive?.id || null,
        request_id: context.request_id,
      });
    } catch (error) {
      logger.warn('settings.llm_configs.delete_failed', { llm_config_id: Number(id), error });
      return res.status(400).json({ error: error.message, code: 'LLM_CONFIG_DELETE_FAILED', request_id: context.request_id });
    }
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
}
