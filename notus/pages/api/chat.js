const { ensureRuntime } = require('../../lib/runtime');
const { getDb } = require('../../lib/db');
const { hybridSearch } = require('../../lib/retrieval');
const { buildKnowledgeQAPrompt } = require('../../lib/prompt');
const { streamChat } = require('../../lib/llm');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function citationsFromChunks(chunks) {
  return chunks.map((chunk) => ({
    file: chunk.file_title,
    file_title: chunk.file_title,
    file_id: chunk.file_id,
    path: chunk.heading_path,
    heading_path: chunk.heading_path,
    quote: chunk.preview,
    preview: chunk.preview,
    lines: chunk.line_start && chunk.line_end ? `L${chunk.line_start}–${chunk.line_end}` : '',
    line_start: chunk.line_start,
    line_end: chunk.line_end,
    image_id: chunk.image_id || null,
    image_url: chunk.image_url || null,
    image_proxy_url: chunk.image_proxy_url || null,
    image_alt_text: chunk.image_alt_text || '',
    image_caption: chunk.image_caption || '',
  }));
}

function ensureConversation(conversationId, query) {
  const db = getDb();
  if (conversationId) {
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(Number(conversationId));
    if (existing) return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO conversations (kind, title, created_at, updated_at)
    VALUES ('knowledge', ?, datetime('now'), datetime('now'))
  `).run(String(query || '新对话').slice(0, 40));
  return result.lastInsertRowid;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const {
    conversation_id: conversationId,
    query,
    model,
    reference_mode: referenceMode,
    reference_file_ids: referenceFileIds = [],
  } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required', code: 'QUERY_REQUIRED' });
  if (referenceMode === 'manual' && (!Array.isArray(referenceFileIds) || referenceFileIds.length === 0)) {
    return res.status(400).json({ error: '手动参考来源至少选择 1 篇文章', code: 'REFERENCE_SOURCE_REQUIRED' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const db = getDb();
    const convId = ensureConversation(conversationId, query);
    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(convId, 'user', query);

    const retrieval = await hybridSearch(query, {
      topK: 5,
      fileIds: referenceMode === 'manual' ? referenceFileIds : [],
    });
    const chunks = retrieval.chunks || [];
    send(res, {
      type: 'chunks',
      chunks,
      retrieval_mode: retrieval.retrieval_mode || 'hybrid',
      active_generation_id: retrieval.active_generation_id || null,
    });

    const citations = citationsFromChunks(chunks);
    let answer = '';

    if (chunks.length === 0) {
      answer = '笔记中没有这方面的内容。';
      send(res, { type: 'token', text: answer });
    } else {
      const messages = buildKnowledgeQAPrompt(query, chunks);
      answer = await streamChat(messages, {
        model,
        onToken: (text) => send(res, { type: 'token', text }),
      });
    }

    send(res, { type: 'citations', citations });
    const messageResult = db.prepare(`
      INSERT INTO messages (conversation_id, role, content, citations)
      VALUES (?, 'assistant', ?, ?)
    `).run(convId, answer, JSON.stringify(citations));
    db.prepare('UPDATE conversations SET updated_at = datetime("now") WHERE id = ?').run(convId);
    send(res, { type: 'done', conversation_id: convId, message_id: messageResult.lastInsertRowid });
  } catch (error) {
    send(res, { type: 'error', error: error.message });
  }

  return res.end();
}
