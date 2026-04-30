const crypto = require('crypto');
const { createAppError } = require('./errors');
const { createLogger } = require('./logger');

const logger = createLogger({ subsystem: 'model-discovery' });
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

const FALLBACK_MODELS = {
  embedding: {
    openai: [
      { value: 'text-embedding-3-large', label: 'text-embedding-3-large (3072d)', dimension: '3072', multimodal: false },
      { value: 'text-embedding-3-small', label: 'text-embedding-3-small (1536d)', dimension: '1536', multimodal: false },
      { value: 'text-embedding-ada-002', label: 'text-embedding-ada-002 (1536d)', dimension: '1536', multimodal: false },
    ],
    qwen: [
      { value: 'text-embedding-v3', label: 'text-embedding-v3 (1024d)', dimension: '1024', multimodal: false },
      { value: 'text-embedding-v2', label: 'text-embedding-v2 (1536d)', dimension: '1536', multimodal: false },
      { value: 'qwen3-vl-embedding', label: 'qwen3-vl-embedding（多模态，1024d）', dimension: '1024', multimodal: true },
      { value: 'qwen2.5-vl-embedding', label: 'qwen2.5-vl-embedding（多模态，1024d）', dimension: '1024', multimodal: true },
      { value: 'tongyi-embedding-vision-plus', label: 'tongyi-embedding-vision-plus（多模态，1152d）', dimension: '1152', multimodal: true },
    ],
    aliyun: [
      { value: 'text-embedding-v3', label: 'text-embedding-v3 (1024d)', dimension: '1024', multimodal: false },
      { value: 'text-embedding-v2', label: 'text-embedding-v2 (1536d)', dimension: '1536', multimodal: false },
      { value: 'qwen3-vl-embedding', label: 'qwen3-vl-embedding（多模态，1024d）', dimension: '1024', multimodal: true },
      { value: 'qwen2.5-vl-embedding', label: 'qwen2.5-vl-embedding（多模态，1024d）', dimension: '1024', multimodal: true },
      { value: 'tongyi-embedding-vision-plus', label: 'tongyi-embedding-vision-plus（多模态，1152d）', dimension: '1152', multimodal: true },
    ],
    doubao: [
      { value: 'doubao-embedding-large', label: 'doubao-embedding-large (2048d)', dimension: '2048', multimodal: false },
      { value: 'doubao-embedding', label: 'doubao-embedding (1024d)', dimension: '1024', multimodal: false },
      { value: 'doubao-embedding-vision', label: 'doubao-embedding-vision（多模态，2048d）', dimension: '2048', multimodal: true },
    ],
    zhipu: [
      { value: 'embedding-3', label: 'embedding-3 (2048d)', dimension: '2048', multimodal: false },
      { value: 'embedding-2', label: 'embedding-2 (1024d)', dimension: '1024', multimodal: false },
    ],
    custom: [],
  },
  llm: {
    anthropic: [
      { value: 'claude-opus-4-1', label: 'claude-opus-4-1' },
      { value: 'claude-sonnet-4', label: 'claude-sonnet-4' },
      { value: 'claude-3-5-haiku-latest', label: 'claude-3-5-haiku-latest' },
    ],
    openai: [
      { value: 'gpt-4o', label: 'gpt-4o' },
      { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
      { value: 'o3', label: 'o3' },
    ],
    google: [
      { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
      { value: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
    ],
    deepseek: [
      { value: 'deepseek-chat', label: 'deepseek-chat' },
      { value: 'deepseek-reasoner', label: 'deepseek-reasoner' },
    ],
    qwen: [
      { value: 'qwen3-max', label: 'qwen3-max' },
      { value: 'qwen-max', label: 'qwen-max' },
      { value: 'qwen-plus', label: 'qwen-plus' },
      { value: 'qwq-32b', label: 'qwq-32b' },
    ],
    custom: [],
  },
};

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getFallbackModels(kind, provider) {
  return (FALLBACK_MODELS[kind]?.[provider] || []).map((item) => ({ ...item, source: 'fallback' }));
}

function mergeModels(primary = [], fallback = []) {
  const map = new Map();
  [...primary, ...fallback].forEach((item) => {
    if (!item?.value) return;
    const key = String(item.value).trim();
    if (!key) return;
    const previous = map.get(key);
    if (!previous || (!previous.dimension && item.dimension) || (!previous.multimodal && item.multimodal)) {
      map.set(key, {
        value: key,
        label: item.label || key,
        dimension: item.dimension,
        multimodal: Boolean(item.multimodal),
        source: item.source || previous?.source || 'remote',
      });
    }
  });
  return [...map.values()];
}

function toCacheKey(kind, provider, baseUrl, apiKey) {
  const signature = apiKey
    ? crypto.createHash('sha1').update(String(apiKey)).digest('hex').slice(0, 8)
    : 'no-key';
  return [kind, provider || 'unknown', normalizeBaseUrl(baseUrl), signature].join('|');
}

function buildHeaders(provider, apiKey) {
  const headers = { Accept: 'application/json' };
  if (!apiKey) return headers;

  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return headers;
  }

  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function extractModelId(item) {
  return item?.id || item?.name || item?.model || item?.value || null;
}

function parseRemoteModels(payload) {
  const candidates = [
    payload?.data,
    payload?.models,
    payload?.result?.data,
  ].find(Array.isArray);

  if (!candidates) return [];

  return candidates
    .map((item) => extractModelId(item))
    .filter(Boolean)
    .map((value) => ({
      value,
      label: value,
      source: 'remote',
    }));
}

async function readFailure(response) {
  const text = await response.text();
  return text || `HTTP ${response.status}`;
}

async function fetchRemoteModels({ kind, provider, baseUrl, apiKey }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw createAppError('MODEL_BASE_URL_REQUIRED', '模型列表地址未配置');
  }

  const response = await fetch(`${normalizedBaseUrl}/models`, {
    method: 'GET',
    headers: buildHeaders(provider, apiKey),
  });

  if (!response.ok) {
    throw createAppError(
      'MODEL_FETCH_FAILED',
      `模型列表获取失败：${response.status} ${await readFailure(response)}`,
      { status: response.status, provider, kind }
    );
  }

  const payload = await response.json();
  const models = parseRemoteModels(payload);
  if (models.length === 0) {
    throw createAppError('MODEL_LIST_EMPTY', '模型列表为空');
  }
  return models;
}

async function getDiscoveredModels({ kind, provider, baseUrl, apiKey, context = {} }) {
  const fallback = getFallbackModels(kind, provider);
  const cacheKey = toCacheKey(kind, provider, baseUrl, apiKey);
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.createdAt < CACHE_TTL_MS)) {
    return cached.value;
  }

  try {
    const remote = await fetchRemoteModels({ kind, provider, baseUrl, apiKey });
    const value = {
      source: 'remote',
      fallback: false,
      models: mergeModels(remote, fallback),
    };
    cache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  } catch (error) {
    logger.warn('models.fetch.failed', {
      ...context,
      kind,
      provider,
      base_url: normalizeBaseUrl(baseUrl),
      error,
    });

    const value = {
      source: 'fallback',
      fallback: true,
      models: fallback,
    };
    cache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  }
}

module.exports = {
  getDiscoveredModels,
  getFallbackModels,
  mergeModels,
};
