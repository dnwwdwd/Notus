const { ensureRuntime } = require('../../../lib/runtime');
const { getEffectiveConfig } = require('../../../lib/config');
const { getSetting } = require('../../../lib/db');
const { getAllFiles } = require('../../../lib/files');

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const config = getEffectiveConfig();
  const files = getAllFiles();
  return res.status(200).json({
    configured: getSetting('setup_completed') === 'true',
    completed: getSetting('setup_completed') === 'true',
    indexed_files: files.filter((file) => file.indexed).length,
    total_files: files.length,
    notes_dir: config.notesDir,
    model_configured: Boolean(config.embeddingApiKey && config.llmApiKey),
    indexed: files.length > 0 && files.every((file) => file.indexed),
    embedding_provider: config.embeddingProvider,
    embedding_multimodal_enabled: Boolean(config.embeddingMultimodalEnabled),
    llm_provider: config.llmProvider,
  });
}
