const { ensureRuntime } = require('../../../lib/runtime');
const { getEffectiveConfig } = require('../../../lib/config');
const { getEmbedding } = require('../../../lib/embeddings');
const { completeChat } = require('../../../lib/llm');
const { createLogger, createRequestContext } = require('../../../lib/logger');
const { getLlmConfigById } = require('../../../lib/llmConfigs');
const {
  buildEmbeddingFingerprint,
  buildLlmFingerprint,
  issueConnectivityVerificationToken,
} = require('../../../lib/connectivityVerification');

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function inferEmbeddingProvider({ provider, baseUrl, model }) {
  if (provider) return provider;

  const normalizedBaseUrl = cleanBaseUrl(baseUrl);
  const normalizedModel = String(model || '').trim().toLowerCase();

  if (normalizedBaseUrl.includes('aliyuncs.com') || normalizedBaseUrl.includes('dashscope')) return 'qwen';
  if (normalizedBaseUrl.includes('ark.cn-') || normalizedBaseUrl.includes('volces') || normalizedBaseUrl.includes('vikingdb')) return 'doubao';
  if (normalizedBaseUrl.includes('api.openai.com')) return 'openai';
  if (normalizedBaseUrl.includes('bigmodel.cn')) return 'zhipu';

  if (/^text-embedding-v[23]$/.test(normalizedModel) || normalizedModel.includes('qwen') || normalizedModel.includes('tongyi')) return 'qwen';
  if (normalizedModel.startsWith('doubao-embedding')) return 'doubao';
  if (normalizedModel.startsWith('text-embedding-')) return 'openai';
  if (normalizedModel.startsWith('embedding-')) return 'zhipu';

  return 'custom';
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/test');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('settings.test.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const { kind, config = {}, llm_config_id: llmConfigId } = req.body || {};
  if (!kind || !['embedding', 'llm'].includes(kind)) {
    return res.status(400).json({ success: false, error: 'kind must be embedding or llm', request_id: context.request_id });
  }

  const started = Date.now();

  try {
    const base = getEffectiveConfig();
    let embeddingResultPayload = null;
    let verificationToken = null;
    if (kind === 'embedding') {
      const resolvedProvider = inferEmbeddingProvider({
        provider: config.provider,
        baseUrl: config.base_url,
        model: config.model,
      });
      const vector = await getEmbedding('Notus 连接测试', {
        ...base,
        embeddingProvider: resolvedProvider || base.embeddingProvider,
        embeddingModel: config.model || base.embeddingModel,
        embeddingApiKey: config.api_key || base.embeddingApiKey,
        embeddingBaseUrl: config.base_url || base.embeddingBaseUrl,
        // 测试连接阶段只探测真实返回维度，不能拿旧配置或推断值先验校验。
        embeddingDim: null,
      });
      embeddingResultPayload = {
        provider: resolvedProvider,
        dimension: Array.isArray(vector) ? vector.length : null,
      };
      verificationToken = issueConnectivityVerificationToken({
        kind: 'embedding',
        fingerprint: buildEmbeddingFingerprint({
          provider: resolvedProvider || base.embeddingProvider,
          model: config.model || base.embeddingModel,
          base_url: config.base_url || base.embeddingBaseUrl,
          api_key: config.api_key || base.embeddingApiKey,
          multimodal_enabled: config.multimodal_enabled,
          dim: Array.isArray(vector) ? vector.length : null,
        }),
      });
    } else {
      const selectedLlmConfig = llmConfigId ? getLlmConfigById(llmConfigId, { includeSecret: true }) : null;
      const resolvedConfig = {
        provider: config.provider || selectedLlmConfig?.provider || base.llmProvider,
        model: config.model || selectedLlmConfig?.model || base.llmModel,
        api_key: config.api_key || selectedLlmConfig?.api_key || base.llmApiKey,
        base_url: config.base_url || selectedLlmConfig?.base_url || base.llmBaseUrl,
      };
      await completeChat([
        { role: 'system', content: '只回复 ok。' },
        { role: 'user', content: '测试连接' },
      ], {
        config: {
          ...base,
          llmProvider: resolvedConfig.provider,
          llmModel: resolvedConfig.model,
          llmApiKey: resolvedConfig.api_key,
          llmBaseUrl: resolvedConfig.base_url,
        },
        taskType: 'settings_test',
      });
      verificationToken = issueConnectivityVerificationToken({
        kind: 'llm',
        fingerprint: buildLlmFingerprint(resolvedConfig),
      });
    }

    logger.info('settings.test.success', {
      kind,
      latency_ms: Date.now() - started,
      provider: embeddingResultPayload?.provider || config.provider || null,
      model: config.model || null,
    });
    return res.status(200).json({
      success: true,
      latency_ms: Date.now() - started,
      verification_token: verificationToken,
      ...(embeddingResultPayload || {}),
      request_id: context.request_id,
    });
  } catch (error) {
    logger.warn('settings.test.failed', {
      kind,
      latency_ms: Date.now() - started,
      provider: config.provider || null,
      model: config.model || null,
      error,
    });
    return res.status(200).json({ success: false, error: error.message, latency_ms: Date.now() - started, request_id: context.request_id });
  }
}
