const { getEffectiveConfig } = require('../../lib/config');
const { ensureError } = require('../../lib/errors');
const { createLogger, createRequestContext } = require('../../lib/logger');
const { getDiscoveredModels } = require('../../lib/modelDiscovery');

function getInput(req) {
  return req.method === 'POST' ? (req.body || {}) : (req.query || {});
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/models');
  const logger = createLogger(context);

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({
      error: 'Method not allowed',
      code: 'METHOD_NOT_ALLOWED',
      request_id: context.request_id,
    });
  }

  try {
    const input = getInput(req);
    const kind = input.kind === 'llm' ? 'llm' : 'embedding';
    const config = getEffectiveConfig();
    const provider = input.provider || (kind === 'embedding' ? config.embeddingProvider : config.llmProvider);
    const baseUrl = input.base_url || (kind === 'embedding' ? config.embeddingBaseUrl : config.llmBaseUrl);
    const apiKey = input.api_key || (kind === 'embedding' ? config.embeddingApiKey : config.llmApiKey);

    const result = await getDiscoveredModels({
      kind,
      provider,
      baseUrl,
      apiKey,
      context,
    });

    logger.info('models.query', {
      kind,
      provider,
      source: result.source,
      count: result.models.length,
      base_url: String(baseUrl || '').replace(/\/+$/, ''),
    });

    return res.status(200).json({
      kind,
      provider,
      source: result.source,
      fallback: result.fallback,
      models: result.models,
      request_id: context.request_id,
    });
  } catch (error) {
    const normalized = ensureError(error, 'MODEL_QUERY_FAILED', '读取模型列表失败');
    logger.error('models.query.failed', { error: normalized });
    return res.status(500).json({
      error: normalized.message,
      code: normalized.code || 'MODEL_QUERY_FAILED',
      request_id: context.request_id,
    });
  }
}
