const { ensureRuntime } = require('../../../lib/runtime');
const { rebuildIndex } = require('../../../lib/indexer');
const { listMarkdownFiles } = require('../../../lib/files');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const files = listMarkdownFiles();
    if (files.length === 0) {
      send(res, { type: 'done', total: 0, indexed: 0, skipped: 0, failed: 0 });
      return res.end();
    }

    const result = await rebuildIndex((progress) => {
      send(res, { type: 'progress', ...progress });
    });
    send(res, { type: 'done', total: files.length, ...result });
  } catch (error) {
    send(res, { type: 'error', error: error.message });
  }

  return res.end();
}
