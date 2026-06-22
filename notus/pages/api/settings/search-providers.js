const { ensureRuntime } = require('../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../lib/logger');
const {
  getSearchProviderConfig,
  saveSearchProviderConfig,
} = require('../../../lib/searchProviderConfigs');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/search-providers');
  const logger = createLogger(context);

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('settings.search_providers.runtime_failed', { error: runtime.error });
    return res.status(500).json({
      error: runtime.error.message,
      code: 'RUNTIME_ERROR',
      request_id: context.request_id,
    });
  }

  if (req.method === 'GET') {
    return res.status(200).json(getSearchProviderConfig());
  }

  if (req.method === 'PUT') {
    try {
      const config = saveSearchProviderConfig(req.body || {});
      logger.info('settings.search_providers.saved', {
        enabled: config.enabled,
        selected_provider: config.selected_provider,
      });
      return res.status(200).json(config);
    } catch (error) {
      logger.warn('settings.search_providers.save_failed', { error: error.message });
      return res.status(400).json({
        error: error.message || '保存搜索配置失败',
        request_id: context.request_id,
      });
    }
  }

  return res.status(405).end();
}
