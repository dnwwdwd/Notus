const { ensureRuntime } = require('../../../lib/runtime');
const { setSettings } = require('../../../lib/db');
const { getEffectiveConfig } = require('../../../lib/config');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/setup/complete');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('setup.complete.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const body = req.body || {};
  const values = { setup_completed: 'true' };

  if (body.notes_dir) values.notes_dir = body.notes_dir;
  if (body.embedding_provider) values.embedding_provider = body.embedding_provider;
  if (body.embedding_model) values.embedding_model = body.embedding_model;
  if (body.embedding_dim) values.embedding_dim = body.embedding_dim;
  if (body.embedding_multimodal_enabled !== undefined) {
    values.embedding_multimodal_enabled = body.embedding_multimodal_enabled ? 'true' : 'false';
  }
  if (body.embedding_api_key || body.api_key) values.embedding_api_key = body.embedding_api_key || body.api_key;
  if (body.llm_provider) values.llm_provider = body.llm_provider;
  if (body.llm_model) values.llm_model = body.llm_model;
  if (body.llm_api_key) values.llm_api_key = body.llm_api_key;

  setSettings(values);
  const config = getEffectiveConfig();
  logger.info('setup.completed', {
    embedding_provider: config.embeddingProvider,
    llm_provider: config.llmProvider,
    notes_dir: config.notesDir,
  });
  return res.status(200).json({
    ok: true,
    notes_dir: config.notesDir,
    embedding_provider: config.embeddingProvider,
    llm_provider: config.llmProvider,
    request_id: context.request_id,
  });
}
