const { ensureRuntime } = require('../../../lib/runtime');
const { getEffectiveConfig, applySettings, readEnvConfig } = require('../../../lib/config');
const { getSettingsMap, setSettings } = require('../../../lib/db');
const {
  buildEmbeddingConfig,
  sanitizeEmbeddingConfig,
  sameEmbeddingSignature,
  sameEmbeddingConfig,
  getActiveGeneration,
  getLatestRebuildGeneration,
  sanitizeGenerationForApi,
  buildEmbeddingApplyState,
  updateGenerationConfigSnapshot,
} = require('../../../lib/indexGenerations');
const { getIndexCoordinator } = require('../../../lib/indexCoordinator');
const { createLogger, createRequestContext } = require('../../../lib/logger');

function publicSettings() {
  const stored = getSettingsMap();
  const config = getEffectiveConfig();
  const desiredEmbedding = buildEmbeddingConfig(config);
  const activeGeneration = getActiveGeneration();
  const activeEmbedding = activeGeneration?.config_snapshot_object || desiredEmbedding;
  const rebuildGeneration = getLatestRebuildGeneration();

  return {
    notes_dir: config.notesDir,
    assets_dir: config.assetsDir,
    setup_completed: stored.setup_completed === 'true',
    embedding: sanitizeEmbeddingConfig(desiredEmbedding),
    active_embedding: sanitizeEmbeddingConfig(activeEmbedding),
    desired_embedding: sanitizeEmbeddingConfig(desiredEmbedding),
    embedding_apply_state: buildEmbeddingApplyState(),
    llm: {
      provider: config.llmProvider,
      model: config.llmModel,
      base_url: config.llmBaseUrl,
      api_key_set: Boolean(config.llmApiKey),
    },
    rebuild_generation: rebuildGeneration ? sanitizeGenerationForApi(rebuildGeneration) : null,
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

    if (body.embedding) {
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
      if (body.llm.provider) nextValues.llm_provider = body.llm.provider;
      if (body.llm.model) nextValues.llm_model = body.llm.model;
      if (body.llm.base_url !== undefined) nextValues.llm_base_url = body.llm.base_url;
      if (body.llm.api_key) nextValues.llm_api_key = body.llm.api_key;
    }

    const candidate = applySettings(readEnvConfig(), { ...current, ...nextValues });
    if (!candidate.embeddingModel || !candidate.llmModel) {
      return res.status(400).json({ error: '模型配置不完整', code: 'INVALID_SETTINGS', request_id: context.request_id });
    }

    setSettings(nextValues);
    const activeGeneration = getActiveGeneration();
    const previousDesiredEmbedding = buildEmbeddingConfig(previousConfig);
    const nextDesiredEmbedding = buildEmbeddingConfig(candidate);
    const activeEmbedding = activeGeneration?.config_snapshot_object || previousDesiredEmbedding;

    const signatureChanged = !sameEmbeddingSignature(previousDesiredEmbedding, nextDesiredEmbedding);
    const desiredDiffersFromActive = !sameEmbeddingConfig(activeEmbedding, nextDesiredEmbedding);

    if (!signatureChanged && activeGeneration && activeEmbedding && activeEmbedding.embeddingApiKey !== nextDesiredEmbedding.embeddingApiKey) {
      updateGenerationConfigSnapshot(activeGeneration.id, {
        ...activeEmbedding,
        embeddingApiKey: nextDesiredEmbedding.embeddingApiKey,
      });
    }

    let rebuildGeneration = getLatestRebuildGeneration();
    if (signatureChanged && desiredDiffersFromActive) {
      rebuildGeneration = getIndexCoordinator().startRebuild({
        kind: 'embedding_change',
        configSnapshot: nextDesiredEmbedding,
      });
      logger.warn('settings.embedding_changed.rebuild_started', {
        previous_model: previousConfig.embeddingModel,
        next_model: candidate.embeddingModel,
        previous_dim: previousConfig.embeddingDim,
        next_dim: candidate.embeddingDim,
        generation_id: rebuildGeneration.id,
      });
    }

    logger.info('settings.updated', {
      embedding_provider: nextValues.embedding_provider || null,
      llm_provider: nextValues.llm_provider || null,
      notes_dir: nextValues.notes_dir || null,
    });
    return res.status(200).json({
      ...publicSettings(),
      rebuild_generation: rebuildGeneration ? sanitizeGenerationForApi(rebuildGeneration) : null,
      request_id: context.request_id,
    });
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
}
