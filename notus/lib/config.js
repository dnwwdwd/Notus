const path = require('path');

const DEFAULTS = {
  notesDir: './notes',
  assetsDir: './notes/.assets',
  dbPath: './notus.db',
  logLevel: 'info',
  embeddingBatchSize: 20,
  embeddingProvider: 'qwen',
  embeddingModel: 'text-embedding-v3',
  embeddingDim: 1024,
  embeddingMultimodalEnabled: false,
  embeddingApiKey: '',
  embeddingBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  llmProvider: 'qwen',
  llmModel: 'qwen-max',
  llmApiKey: '',
  llmBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  vecScoreThreshold: 0.5,
  topK: 5,
};

const PROVIDER_BASE_URLS = {
  embedding: {
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    aliyun: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    openai: 'https://api.openai.com/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    custom: '',
  },
  llm: {
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    custom: '',
  },
};

function numberFromEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatFromEnv(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function absolutePath(value, fallback) {
  const resolved = value || fallback;
  return path.resolve(resolved);
}

function readEnvConfig() {
  const notesDir = absolutePath(process.env.NOTES_DIR, DEFAULTS.notesDir);
  const assetsDir = absolutePath(process.env.ASSETS_DIR, DEFAULTS.assetsDir);
  const dbPath = absolutePath(process.env.DB_PATH, DEFAULTS.dbPath);
  const embeddingProvider = process.env.EMBEDDING_PROVIDER || DEFAULTS.embeddingProvider;
  const llmProvider = process.env.LLM_PROVIDER || DEFAULTS.llmProvider;

  return {
    notesDir,
    assetsDir,
    dbPath,
    logDir: absolutePath(process.env.LOG_DIR, path.join(path.dirname(dbPath), 'logs')),
    logLevel: String(process.env.LOG_LEVEL || DEFAULTS.logLevel).trim().toLowerCase(),
    embeddingBatchSize: numberFromEnv(process.env.EMBEDDING_BATCH_SIZE, DEFAULTS.embeddingBatchSize),

    embeddingProvider,
    embeddingModel: process.env.EMBEDDING_MODEL || DEFAULTS.embeddingModel,
    embeddingDim: numberFromEnv(process.env.EMBEDDING_DIM, DEFAULTS.embeddingDim),
    embeddingMultimodalEnabled: booleanFromEnv(
      process.env.EMBEDDING_MULTIMODAL_ENABLED,
      DEFAULTS.embeddingMultimodalEnabled
    ),
    embeddingApiKey: process.env.EMBEDDING_API_KEY || '',
    embeddingBaseUrl: cleanBaseUrl(
      process.env.EMBEDDING_BASE_URL ||
      PROVIDER_BASE_URLS.embedding[embeddingProvider] ||
      DEFAULTS.embeddingBaseUrl
    ),

    llmProvider,
    llmModel: process.env.LLM_MODEL || process.env.LLM_DEFAULT_MODEL || DEFAULTS.llmModel,
    llmApiKey: process.env.LLM_API_KEY || '',
    llmBaseUrl: cleanBaseUrl(
      process.env.LLM_BASE_URL ||
      PROVIDER_BASE_URLS.llm[llmProvider] ||
      DEFAULTS.llmBaseUrl
    ),

    vecScoreThreshold: floatFromEnv(process.env.VEC_SCORE_THRESHOLD, DEFAULTS.vecScoreThreshold),
    topK: numberFromEnv(process.env.TOP_K, DEFAULTS.topK),
  };
}

function applySettings(baseConfig, settings = {}) {
  const next = { ...baseConfig };
  const map = settings || {};

  if (map.notes_dir) next.notesDir = absolutePath(map.notes_dir, next.notesDir);
  if (map.assets_dir) next.assetsDir = absolutePath(map.assets_dir, next.assetsDir);

  if (map.embedding_provider) next.embeddingProvider = map.embedding_provider;
  if (map.embedding_model) next.embeddingModel = map.embedding_model;
  if (map.embedding_dim) next.embeddingDim = numberFromEnv(map.embedding_dim, next.embeddingDim);
  if (map.embedding_multimodal_enabled !== undefined) {
    next.embeddingMultimodalEnabled = booleanFromEnv(map.embedding_multimodal_enabled, next.embeddingMultimodalEnabled);
  }
  if (map.embedding_api_key) next.embeddingApiKey = map.embedding_api_key;
  if (map.embedding_base_url !== undefined) {
    next.embeddingBaseUrl = cleanBaseUrl(map.embedding_base_url);
  } else if (!next.embeddingBaseUrl) {
    next.embeddingBaseUrl = cleanBaseUrl(PROVIDER_BASE_URLS.embedding[next.embeddingProvider] || '');
  }

  if (map.llm_provider) next.llmProvider = map.llm_provider;
  if (map.llm_model) next.llmModel = map.llm_model;
  if (map.llm_api_key) next.llmApiKey = map.llm_api_key;
  if (map.llm_base_url !== undefined) {
    next.llmBaseUrl = cleanBaseUrl(map.llm_base_url);
  } else if (!next.llmBaseUrl) {
    next.llmBaseUrl = cleanBaseUrl(PROVIDER_BASE_URLS.llm[next.llmProvider] || '');
  }

  return next;
}

function getEffectiveConfig() {
  try {
    const { getSettingsMap } = require('./db');
    return applySettings(readEnvConfig(), getSettingsMap());
  } catch {
    return readEnvConfig();
  }
}

module.exports = {
  DEFAULTS,
  PROVIDER_BASE_URLS,
  booleanFromEnv,
  readEnvConfig,
  applySettings,
  getEffectiveConfig,
};
