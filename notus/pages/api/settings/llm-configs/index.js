const { ensureRuntime } = require('../../../../lib/runtime');
const { createLlmConfigGroup, listLlmConfigs, getLlmConfigById } = require('../../../../lib/llmConfigs');
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
      const payload = req.body || {};
      const modelEntries = Array.isArray(payload.models) ? payload.models : null;
      if (!modelEntries || modelEntries.length === 0) {
        return res.status(400).json({
          error: '缺少 models 模型数据，至少需要一个模型',
          code: 'LLM_CONFIG_MODELS_REQUIRED',
          request_id: context.request_id,
        });
      }

      // 组内共享 API Key：请求自带，或从已有配置继承（明文 Key 不回传前端）。
      let sharedApiKey = String(payload.api_key || '').trim();
      if (!sharedApiKey && payload.inherit_api_key_from) {
        const parent = getLlmConfigById(payload.inherit_api_key_from, { includeSecret: true });
        if (!parent) {
          return res.status(400).json({ error: '要继承 API Key 的 LLM 配置不存在', code: 'LLM_CONFIG_CREATE_FAILED', request_id: context.request_id });
        }
        sharedApiKey = parent.api_key;
      }
      if (!sharedApiKey) {
        return res.status(400).json({ error: 'LLM API Key 不能为空', code: 'LLM_CONFIG_CREATE_FAILED', request_id: context.request_id });
      }

      const normalizedEntries = modelEntries.map((entry) => ({
        model: String(entry?.model || '').trim(),
        last_test_latency_ms: entry?.last_test_latency_ms === undefined || entry?.last_test_latency_ms === null
          ? null
          : Number(entry.last_test_latency_ms),
      }));
      if (normalizedEntries.some((entry) => !entry.model)) {
        return res.status(400).json({ error: '模型名称不能为空', code: 'LLM_CONFIG_CREATE_FAILED', request_id: context.request_id });
      }

      // 保存不再强制连通性校验：连通性测试为可选操作，last_test_latency_ms 仅作为测试结果元数据记录。
      const createdItems = createLlmConfigGroup(
        { ...payload, api_key: sharedApiKey },
        normalizedEntries
      );

      logger.info('settings.llm_configs.created', {
        count: createdItems.length,
        provider: createdItems[0]?.provider,
        api_protocol: createdItems[0]?.api_protocol,
        models: createdItems.map((item) => item.model),
      });
      return res.status(201).json({ items: createdItems, request_id: context.request_id });
    } catch (error) {
      logger.warn('settings.llm_configs.create_failed', { error });
      return res.status(400).json({ error: error.message, code: 'LLM_CONFIG_CREATE_FAILED', request_id: context.request_id });
    }
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
}
