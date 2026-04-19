const { ensureRuntime } = require('../../../lib/runtime');
const { hybridSearch } = require('../../../lib/retrieval');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { topic } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic is required', code: 'TOPIC_REQUIRED' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const chunks = await hybridSearch(topic, { topK: 3 });
    const blocks = [
      { id: 'b_1', type: 'heading', content: `# ${topic}` },
      { id: 'b_2', type: 'paragraph', content: chunks[0]?.preview || '先写出这个主题的背景和核心问题。' },
      { id: 'b_3', type: 'heading', content: '## 主要观点' },
      { id: 'b_4', type: 'paragraph', content: '结合已有笔记，展开几个主要观点。' },
    ];
    blocks.forEach((block) => send(res, { type: 'block', block }));
    send(res, { type: 'done', citations: chunks });
  } catch (error) {
    send(res, { type: 'error', error: error.message });
  }

  return res.end();
}
