const { ensureRuntime } = require('../../../lib/runtime');
const { getLlmConfigById } = require('../../../lib/llmConfigs');
const { createLogger, createRequestContext } = require('../../../lib/logger');

const REQUEST_TIMEOUT_MS = 15000;

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function extractModelIds(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const ids = rows
    .map((row) => (typeof row === 'string' ? row : row?.id || row?.name))
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/llm-models');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('settings.llm_models.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const body = req.body || {};
  const apiProtocol = String(body.api_protocol || '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
  const referenceConfig = body.llm_config_id ? getLlmConfigById(body.llm_config_id, { includeSecret: true }) : null;
  const baseUrl = normalizeBaseUrl(body.base_url) || normalizeBaseUrl(referenceConfig?.base_url);
  const apiKey = String(body.api_key || '').trim() || referenceConfig?.api_key || '';

  const started = Date.now();
  if (!baseUrl || !apiKey) {
    return res.status(200).json({
      success: false,
      error: !baseUrl ? '请先填写 Base URL 再获取模型列表' : '请先填写 API Key 再获取模型列表',
      request_id: context.request_id,
    });
  }

  let listUrl;
  try {
    listUrl = new URL(`${baseUrl}/models`);
  } catch {
    return res.status(200).json({ success: false, error: 'Base URL 无效，无法获取模型列表', request_id: context.request_id });
  }

  const headers = apiProtocol === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey}` };

  try {
    const response = await fetch(listUrl, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const rawText = await response.text();
    if (!response.ok) {
      const detail = rawText.trim().slice(0, 200);
      logger.warn('settings.llm_models.upstream_failed', {
        api_protocol: apiProtocol,
        status: response.status,
        latency_ms: Date.now() - started,
      });
      return res.status(200).json({
        success: false,
        error: `获取模型列表失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
        request_id: context.request_id,
      });
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return res.status(200).json({ success: false, error: '模型列表返回了非 JSON 内容', request_id: context.request_id });
    }

    const models = extractModelIds(payload);
    if (models.length === 0) {
      return res.status(200).json({ success: false, error: '服务商未返回可用模型', request_id: context.request_id });
    }

    logger.info('settings.llm_models.success', {
      api_protocol: apiProtocol,
      count: models.length,
      latency_ms: Date.now() - started,
    });
    return res.status(200).json({ success: true, models, request_id: context.request_id });
  } catch (error) {
    logger.warn('settings.llm_models.failed', {
      api_protocol: apiProtocol,
      latency_ms: Date.now() - started,
      error,
    });
    const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? '获取模型列表超时，请检查 Base URL 或网络'
      : `获取模型列表失败：${error.message || '网络错误'}`;
    return res.status(200).json({ success: false, error: message, request_id: context.request_id });
  }
}
