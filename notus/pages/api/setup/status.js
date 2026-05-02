const { ensureRuntime } = require('../../../lib/runtime');
const { getEffectiveConfig } = require('../../../lib/config');
const { getSetting } = require('../../../lib/db');
const { getAllFiles } = require('../../../lib/files');
const { listLlmConfigs } = require('../../../lib/llmConfigs');

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const config = getEffectiveConfig();
  const files = getAllFiles();
  const llmConfigured = Boolean(config.llmApiKey && config.llmModel) || listLlmConfigs().length > 0;
  const embeddingConfigured = Boolean(
    config.embeddingApiKey &&
    config.embeddingProvider &&
    config.embeddingModel &&
    Number(config.embeddingDim) > 0
  );
  return res.status(200).json({
    configured: getSetting('setup_completed') === 'true',
    completed: getSetting('setup_completed') === 'true',
    runtime_target: config.runtimeTarget,
    storage_mode: config.storageMode,
    data_root: config.dataRoot,
    capabilities: config.capabilities,
    can_auto_purge_on_uninstall: config.canAutoPurgeOnUninstall,
    indexed_files: files.filter((file) => file.indexed).length,
    total_files: files.length,
    notes_dir: config.notesDir,
    assets_dir: config.assetsDir,
    db_path: config.dbPath,
    log_dir: config.logDir,
    model_configured: Boolean(embeddingConfigured && llmConfigured),
    embedding_configured: embeddingConfigured,
    llm_configured: llmConfigured,
    indexed: files.length > 0 && files.every((file) => file.indexed),
    embedding_provider: config.embeddingProvider,
    embedding_multimodal_enabled: Boolean(config.embeddingMultimodalEnabled),
    llm_provider: config.llmProvider,
  });
}
