const { ensureRuntime } = require('../../../lib/runtime');
const { getEffectiveConfig } = require('../../../lib/config');
const { getEmbedding } = require('../../../lib/embeddings');
const { completeChat } = require('../../../lib/llm');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { kind, config = {} } = req.body || {};
  if (!kind || !['embedding', 'llm'].includes(kind)) {
    return res.status(400).json({ success: false, error: 'kind must be embedding or llm' });
  }

  const started = Date.now();

  try {
    const base = getEffectiveConfig();
    if (kind === 'embedding') {
      await getEmbedding('Notus 连接测试', {
        ...base,
        embeddingProvider: config.provider || base.embeddingProvider,
        embeddingModel: config.model || base.embeddingModel,
        embeddingApiKey: config.api_key || base.embeddingApiKey,
        embeddingBaseUrl: config.base_url || base.embeddingBaseUrl,
        embeddingDim: Number(config.dim || base.embeddingDim),
      });
    } else {
      await completeChat([
        { role: 'system', content: '只回复 ok。' },
        { role: 'user', content: '测试连接' },
      ], {
        config: {
          ...base,
          llmProvider: config.provider || base.llmProvider,
          llmModel: config.model || base.llmModel,
          llmApiKey: config.api_key || base.llmApiKey,
          llmBaseUrl: config.base_url || base.llmBaseUrl,
        },
      });
    }

    return res.status(200).json({ success: true, latency_ms: Date.now() - started });
  } catch (error) {
    return res.status(200).json({ success: false, error: error.message, latency_ms: Date.now() - started });
  }
}
