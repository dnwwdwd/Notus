const { ensureRuntime } = require('../../../../lib/runtime');
const { createLlmConfig, listLlmConfigs } = require('../../../../lib/llmConfigs');
const { createLogger, createRequestContext } = require('../../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/llm-configs');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('settings.llm_configs.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      items: listLlmConfigs(),
      request_id: context.request_id,
    });
  }

  if (req.method === 'POST') {
    try {
      const created = createLlmConfig(req.body || {});
      logger.info('settings.llm_configs.created', {
        llm_config_id: created.id,
        provider: created.provider,
        model: created.model,
        is_active: created.is_active,
      });
      return res.status(201).json({ item: created, request_id: context.request_id });
    } catch (error) {
      logger.warn('settings.llm_configs.create_failed', { error });
      return res.status(400).json({ error: error.message, code: 'LLM_CONFIG_CREATE_FAILED', request_id: context.request_id });
    }
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
}
