const { ensureRuntime } = require('../../../lib/runtime');
const { getEffectiveConfig, applySettings, readEnvConfig } = require('../../../lib/config');
const { getSettingsMap, resetVec, setSettings } = require('../../../lib/db');
const { createLogger, createRequestContext } = require('../../../lib/logger');
const { clearIndex } = require('../../../lib/indexer');
const { getActiveLlmConfig, listLlmConfigs } = require('../../../lib/llmConfigs');
const { deriveLlmConfigBudgetFields } = require('../../../lib/llmBudget');
const {
  buildEmbeddingFingerprint,
  buildLlmFingerprint,
  consumeConnectivityVerificationToken,
} = require('../../../lib/connectivityVerification');

const LAYOUT_SETTINGS = {
  knowledge_left_percent: {
    key: 'knowledge_layout_left_percent',
    min: 20,
    max: 75,
  },
  canvas_left_percent: {
    key: 'canvas_layout_left_percent',
    min: 30,
    max: 80,
  },
};

function normalizeLayoutPercent(value, { min, max }) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
}

function readLayoutSettings(stored = {}) {
  return Object.fromEntries(
    Object.entries(LAYOUT_SETTINGS).map(([field, definition]) => [
      field,
      normalizeLayoutPercent(stored[definition.key], definition),
    ])
  );
}

function publicSettings() {
  const stored = getSettingsMap();
  const config = getEffectiveConfig();
  const activeLlmConfig = getActiveLlmConfig();
  return {
    runtime_target: config.runtimeTarget,
    storage_mode: config.storageMode,
    data_root: config.dataRoot,
    capabilities: config.capabilities,
    can_auto_purge_on_uninstall: config.canAutoPurgeOnUninstall,
    notes_dir: config.notesDir,
    assets_dir: config.assetsDir,
    db_path: config.dbPath,
    log_dir: config.logDir,
    session_dir: config.sessionDir,
    setup_completed: stored.setup_completed === 'true',
    embedding: {
      provider: config.embeddingProvider,
      model: config.embeddingModel,
      dim: config.embeddingDim,
      multimodal_enabled: Boolean(config.embeddingMultimodalEnabled),
      base_url: config.embeddingBaseUrl,
      api_key_set: Boolean(config.embeddingApiKey),
    },
    llm: {
      provider: config.llmProvider,
      model: config.llmModel,
      base_url: config.llmBaseUrl,
      context_window_tokens: config.llmContextWindowTokens,
      max_output_tokens: config.llmMaxOutputTokens,
      api_key_set: Boolean(config.llmApiKey),
    },
    llm_configs: listLlmConfigs(),
    active_llm_config_id: activeLlmConfig?.id || null,
    knowledge: {
      enable_clarify: Boolean(config.knowledgeEnableClarify),
      enable_conditional_rerank: Boolean(config.knowledgeEnableConditionalRerank),
      enable_weak_evidence_supplement: Boolean(config.knowledgeEnableWeakEvidenceSupplement),
      enable_conflict_mode: Boolean(config.knowledgeEnableConflictMode),
    },
    canvas: {
      enable_style_extraction: Boolean(config.canvasEnableStyleExtraction),
      enable_article_analysis: Boolean(config.canvasEnableArticleAnalysis),
      global_edit_soft_max_blocks: Number(config.canvasGlobalEditSoftMaxBlocks || 12),
      global_edit_hard_max_blocks: Number(config.canvasGlobalEditHardMaxBlocks || 20),
      style_extraction_model: String(config.styleExtractionModel || ''),
    },
    layout: readLayoutSettings(stored),
  };
}

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('settings.runtime.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ ...publicSettings(), request_id: context.request_id });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const previousConfig = getEffectiveConfig();
    const current = getSettingsMap();
    const nextValues = {};

    if (body.notes_dir) nextValues.notes_dir = body.notes_dir;
    if (body.assets_dir) nextValues.assets_dir = body.assets_dir;
    if (body.setup_completed !== undefined) nextValues.setup_completed = body.setup_completed ? 'true' : 'false';
    if (body.knowledge) {
      if (body.knowledge.enable_clarify !== undefined) {
        nextValues.knowledge_enable_clarify = body.knowledge.enable_clarify ? 'true' : 'false';
      }
      if (body.knowledge.enable_conditional_rerank !== undefined) {
        nextValues.knowledge_enable_conditional_rerank = body.knowledge.enable_conditional_rerank ? 'true' : 'false';
      }
      if (body.knowledge.enable_weak_evidence_supplement !== undefined) {
        nextValues.knowledge_enable_weak_evidence_supplement = body.knowledge.enable_weak_evidence_supplement ? 'true' : 'false';
      }
      if (body.knowledge.enable_conflict_mode !== undefined) {
        nextValues.knowledge_enable_conflict_mode = body.knowledge.enable_conflict_mode ? 'true' : 'false';
      }
    }

    if (body.canvas) {
      if (body.canvas.enable_style_extraction !== undefined) {
        nextValues.canvas_enable_style_extraction = body.canvas.enable_style_extraction ? 'true' : 'false';
      }
      if (body.canvas.enable_article_analysis !== undefined) {
        nextValues.canvas_enable_article_analysis = body.canvas.enable_article_analysis ? 'true' : 'false';
      }
      if (body.canvas.global_edit_soft_max_blocks !== undefined) {
        nextValues.canvas_global_edit_soft_max_blocks = String(body.canvas.global_edit_soft_max_blocks);
      }
      if (body.canvas.global_edit_hard_max_blocks !== undefined) {
        nextValues.canvas_global_edit_hard_max_blocks = String(body.canvas.global_edit_hard_max_blocks);
      }
      if (body.canvas.style_extraction_model !== undefined) {
        nextValues.style_extraction_model = String(body.canvas.style_extraction_model || '').trim();
      }
    }

    if (body.layout) {
      for (const [field, definition] of Object.entries(LAYOUT_SETTINGS)) {
        if (body.layout[field] === undefined) continue;
        const normalized = normalizeLayoutPercent(body.layout[field], definition);
        if (normalized === null) {
          return res.status(400).json({
            error: `${field} 必须是有效数字`,
            code: 'INVALID_SETTINGS',
            request_id: context.request_id,
          });
        }
        nextValues[definition.key] = String(normalized);
      }
    }

    if (body.embedding) {
      const embeddingFingerprint = buildEmbeddingFingerprint({
        provider: body.embedding.provider || previousConfig.embeddingProvider,
        model: body.embedding.model || previousConfig.embeddingModel,
        base_url: body.embedding.base_url !== undefined ? body.embedding.base_url : previousConfig.embeddingBaseUrl,
        api_key: body.embedding.api_key || previousConfig.embeddingApiKey,
        multimodal_enabled: body.embedding.multimodal_enabled !== undefined
          ? body.embedding.multimodal_enabled
          : previousConfig.embeddingMultimodalEnabled,
        dim: body.embedding.dim || previousConfig.embeddingDim,
      });
      const embeddingVerified = consumeConnectivityVerificationToken({
        token: body.embedding.verification_token,
        kind: 'embedding',
        fingerprint: embeddingFingerprint,
      });
      if (!embeddingVerified) {
        return res.status(400).json({
          error: 'Embedding 配置必须先测试连通性并使用当前测试结果保存',
          code: 'CONNECTIVITY_TEST_REQUIRED',
          request_id: context.request_id,
        });
      }
      if (body.embedding.provider) nextValues.embedding_provider = body.embedding.provider;
      if (body.embedding.model) nextValues.embedding_model = body.embedding.model;
      if (body.embedding.dim) nextValues.embedding_dim = body.embedding.dim;
      if (body.embedding.multimodal_enabled !== undefined) {
        nextValues.embedding_multimodal_enabled = body.embedding.multimodal_enabled ? 'true' : 'false';
      }
      if (body.embedding.base_url !== undefined) nextValues.embedding_base_url = body.embedding.base_url;
      if (body.embedding.api_key) nextValues.embedding_api_key = body.embedding.api_key;
    }

    if (body.llm) {
      const nextLlmModel = body.llm.model || previousConfig.llmModel;
      const derivedBudget = deriveLlmConfigBudgetFields({
        model: nextLlmModel,
      });
      const llmFingerprint = buildLlmFingerprint({
        provider: body.llm.provider || previousConfig.llmProvider,
        model: nextLlmModel,
        base_url: body.llm.base_url !== undefined ? body.llm.base_url : previousConfig.llmBaseUrl,
        api_key: body.llm.api_key || previousConfig.llmApiKey,
      });
      const llmVerified = consumeConnectivityVerificationToken({
        token: body.llm.verification_token,
        kind: 'llm',
        fingerprint: llmFingerprint,
      });
      if (!llmVerified) {
        return res.status(400).json({
          error: 'LLM 配置必须先测试连通性并使用当前测试结果保存',
          code: 'CONNECTIVITY_TEST_REQUIRED',
          request_id: context.request_id,
        });
      }
      if (body.llm.provider) nextValues.llm_provider = body.llm.provider;
      if (body.llm.model) nextValues.llm_model = body.llm.model;
      if (body.llm.base_url !== undefined) nextValues.llm_base_url = body.llm.base_url;
      if (body.llm.api_key) nextValues.llm_api_key = body.llm.api_key;
      nextValues.llm_context_window_tokens = String(derivedBudget.context_window_tokens);
      nextValues.llm_max_output_tokens = String(derivedBudget.max_output_tokens);
    }

    const candidate = applySettings(readEnvConfig(), { ...current, ...nextValues });
    if (!candidate.embeddingModel || !candidate.llmModel) {
      return res.status(400).json({ error: '模型配置不完整', code: 'INVALID_SETTINGS', request_id: context.request_id });
    }

    setSettings(nextValues);
    const embeddingChanged =
      candidate.embeddingProvider !== previousConfig.embeddingProvider ||
      candidate.embeddingModel !== previousConfig.embeddingModel ||
      Number(candidate.embeddingDim) !== Number(previousConfig.embeddingDim) ||
      Boolean(candidate.embeddingMultimodalEnabled) !== Boolean(previousConfig.embeddingMultimodalEnabled);

    if (embeddingChanged) {
      clearIndex();
      if (Number(candidate.embeddingDim) !== Number(previousConfig.embeddingDim)) {
        resetVec(Number(candidate.embeddingDim));
      }
      logger.warn('settings.embedding_changed.reindex_required', {
        previous_model: previousConfig.embeddingModel,
        next_model: candidate.embeddingModel,
        previous_dim: previousConfig.embeddingDim,
        next_dim: candidate.embeddingDim,
      });
    }

    logger.info('settings.updated', {
      embedding_provider: nextValues.embedding_provider || null,
      llm_provider: nextValues.llm_provider || null,
      notes_dir: nextValues.notes_dir || null,
      canvas_style_extraction: nextValues.canvas_enable_style_extraction || null,
      canvas_article_analysis: nextValues.canvas_enable_article_analysis || null,
      knowledge_layout_left_percent: nextValues[LAYOUT_SETTINGS.knowledge_left_percent.key] || null,
      canvas_layout_left_percent: nextValues[LAYOUT_SETTINGS.canvas_left_percent.key] || null,
    });
    return res.status(200).json({ ...publicSettings(), request_id: context.request_id });
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
}
