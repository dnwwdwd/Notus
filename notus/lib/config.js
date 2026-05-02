const { getPlatformProfile } = require('./platform/profile');

const DEFAULTS = {
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
  llmContextWindowTokens: 800000,
  llmMaxOutputTokens: 32768,
  vecScoreThreshold: 0.5,
  topK: 5,
  knowledgeEnableClarify: true,
  knowledgeEnableConditionalRerank: true,
  knowledgeEnableWeakEvidenceSupplement: true,
  knowledgeEnableConflictMode: true,
  canvasEnableStyleExtraction: true,
  canvasEnableArticleAnalysis: false,
  canvasGlobalEditSoftMaxBlocks: 12,
  canvasGlobalEditHardMaxBlocks: 20,
  styleExtractionModel: '',
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

function readEnvConfig() {
  const platform = getPlatformProfile();
  const notesDir = platform.paths.notesDir;
  const assetsDir = platform.paths.assetsDir;
  const dbPath = platform.paths.dbPath;
  const embeddingProvider = process.env.EMBEDDING_PROVIDER || DEFAULTS.embeddingProvider;
  const llmProvider = process.env.LLM_PROVIDER || DEFAULTS.llmProvider;

  return {
    runtimeTarget: platform.runtimeTarget,
    dataRoot: platform.dataRoot,
    storageMode: platform.storageMode,
    canAutoPurgeOnUninstall: platform.canAutoPurgeOnUninstall,
    capabilities: platform.capabilities,
    notesDir,
    assetsDir,
    dbPath,
    logDir: platform.paths.logDir,
    sessionDir: platform.paths.sessionDir,
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
    llmContextWindowTokens: numberFromEnv(
      process.env.LLM_CONTEXT_WINDOW_TOKENS,
      DEFAULTS.llmContextWindowTokens
    ),
    llmMaxOutputTokens: numberFromEnv(
      process.env.LLM_MAX_OUTPUT_TOKENS,
      DEFAULTS.llmMaxOutputTokens
    ),

    vecScoreThreshold: floatFromEnv(process.env.VEC_SCORE_THRESHOLD, DEFAULTS.vecScoreThreshold),
    topK: numberFromEnv(process.env.TOP_K, DEFAULTS.topK),
    knowledgeEnableClarify: booleanFromEnv(
      process.env.KNOWLEDGE_ENABLE_CLARIFY,
      DEFAULTS.knowledgeEnableClarify
    ),
    knowledgeEnableConditionalRerank: booleanFromEnv(
      process.env.KNOWLEDGE_ENABLE_CONDITIONAL_RERANK,
      DEFAULTS.knowledgeEnableConditionalRerank
    ),
    knowledgeEnableWeakEvidenceSupplement: booleanFromEnv(
      process.env.KNOWLEDGE_ENABLE_WEAK_EVIDENCE_SUPPLEMENT,
      DEFAULTS.knowledgeEnableWeakEvidenceSupplement
    ),
    knowledgeEnableConflictMode: booleanFromEnv(
      process.env.KNOWLEDGE_ENABLE_CONFLICT_MODE,
      DEFAULTS.knowledgeEnableConflictMode
    ),
    canvasEnableStyleExtraction: booleanFromEnv(
      process.env.CANVAS_ENABLE_STYLE_EXTRACTION,
      DEFAULTS.canvasEnableStyleExtraction
    ),
    canvasEnableArticleAnalysis: booleanFromEnv(
      process.env.CANVAS_ENABLE_ARTICLE_ANALYSIS,
      DEFAULTS.canvasEnableArticleAnalysis
    ),
    canvasGlobalEditSoftMaxBlocks: numberFromEnv(
      process.env.CANVAS_GLOBAL_EDIT_SOFT_MAX_BLOCKS,
      DEFAULTS.canvasGlobalEditSoftMaxBlocks
    ),
    canvasGlobalEditHardMaxBlocks: numberFromEnv(
      process.env.CANVAS_GLOBAL_EDIT_HARD_MAX_BLOCKS,
      DEFAULTS.canvasGlobalEditHardMaxBlocks
    ),
    styleExtractionModel: String(process.env.STYLE_EXTRACTION_MODEL || DEFAULTS.styleExtractionModel).trim(),
  };
}

function applySettings(baseConfig, settings = {}) {
  const next = { ...baseConfig };
  const map = settings || {};

  if (map.notes_dir) next.notesDir = map.notes_dir;
  if (map.assets_dir) next.assetsDir = map.assets_dir;

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
  if (map.llm_context_window_tokens) {
    next.llmContextWindowTokens = numberFromEnv(map.llm_context_window_tokens, next.llmContextWindowTokens);
  }
  if (map.llm_max_output_tokens) {
    next.llmMaxOutputTokens = numberFromEnv(map.llm_max_output_tokens, next.llmMaxOutputTokens);
  }

  if (map.knowledge_enable_clarify !== undefined) {
    next.knowledgeEnableClarify = booleanFromEnv(map.knowledge_enable_clarify, next.knowledgeEnableClarify);
  }
  if (map.knowledge_enable_conditional_rerank !== undefined) {
    next.knowledgeEnableConditionalRerank = booleanFromEnv(
      map.knowledge_enable_conditional_rerank,
      next.knowledgeEnableConditionalRerank
    );
  }
  if (map.knowledge_enable_weak_evidence_supplement !== undefined) {
    next.knowledgeEnableWeakEvidenceSupplement = booleanFromEnv(
      map.knowledge_enable_weak_evidence_supplement,
      next.knowledgeEnableWeakEvidenceSupplement
    );
  }
  if (map.knowledge_enable_conflict_mode !== undefined) {
    next.knowledgeEnableConflictMode = booleanFromEnv(
      map.knowledge_enable_conflict_mode,
      next.knowledgeEnableConflictMode
    );
  }

  if (map.canvas_enable_style_extraction !== undefined) {
    next.canvasEnableStyleExtraction = booleanFromEnv(
      map.canvas_enable_style_extraction,
      next.canvasEnableStyleExtraction
    );
  }
  if (map.canvas_enable_article_analysis !== undefined) {
    next.canvasEnableArticleAnalysis = booleanFromEnv(
      map.canvas_enable_article_analysis,
      next.canvasEnableArticleAnalysis
    );
  }
  if (map.canvas_global_edit_soft_max_blocks !== undefined) {
    next.canvasGlobalEditSoftMaxBlocks = numberFromEnv(
      map.canvas_global_edit_soft_max_blocks,
      next.canvasGlobalEditSoftMaxBlocks
    );
  }
  if (map.canvas_global_edit_hard_max_blocks !== undefined) {
    next.canvasGlobalEditHardMaxBlocks = numberFromEnv(
      map.canvas_global_edit_hard_max_blocks,
      next.canvasGlobalEditHardMaxBlocks
    );
  }
  if (map.style_extraction_model !== undefined) {
    next.styleExtractionModel = String(map.style_extraction_model || '').trim();
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
