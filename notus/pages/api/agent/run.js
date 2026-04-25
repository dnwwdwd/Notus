const { ensureRuntime } = require('../../../lib/runtime');
const { getDb } = require('../../../lib/db');
const { runAgent } = require('../../../lib/agent');
const { computeDiff } = require('../../../lib/diff');
const { resolveLlmRuntimeConfig } = require('../../../lib/llmConfigs');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeCitations(citations = []) {
  return citations.map((item) => ({
    citation_kind: item.citation_kind || 'knowledge',
    file: item.file_title || item.file || '',
    file_title: item.file_title || item.file || '',
    file_id: item.file_id ? Number(item.file_id) : null,
    path: item.heading_path || item.path || '',
    heading_path: item.heading_path || item.path || '',
    quote: item.preview || item.content || item.quote || '',
    preview: item.preview || item.quote || '',
    lines: item.line_start && item.line_end ? `L${item.line_start}–${item.line_end}` : item.lines || '',
    line_start: item.line_start || null,
    line_end: item.line_end || null,
    image_id: item.image_id || null,
    image_url: item.image_url || null,
    image_proxy_url: item.image_proxy_url || null,
    image_alt_text: item.image_alt_text || '',
    image_caption: item.image_caption || '',
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const {
    conversation_id: conversationId,
    user_input: userInput,
    article,
    llm_config_id: llmConfigId,
    style_source: styleSource = 'auto',
  } = req.body || {};

  if (!userInput || !article?.blocks) {
    return res.status(400).json({ error: 'user_input and article.blocks are required', code: 'INVALID_AGENT_REQUEST' });
  }
  if (
    (styleSource === 'manual' || styleSource?.mode === 'manual') &&
    (!Array.isArray(styleSource?.file_ids) || styleSource.file_ids.length === 0)
  ) {
    return res.status(400).json({ error: '手动风格来源至少选择 1 篇文章', code: 'STYLE_SOURCE_REQUIRED' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const db = getDb();
  const convId = conversationId
    ? Number(conversationId)
    : db.prepare(`
      INSERT INTO conversations (kind, title, created_at, updated_at)
      VALUES ('canvas', ?, datetime('now'), datetime('now'))
    `).run(String(userInput).slice(0, 40)).lastInsertRowid;

  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(convId, 'user', userInput);

  try {
    const llmConfig = llmConfigId ? resolveLlmRuntimeConfig({ llmConfigId }) : null;
    if (llmConfigId && !llmConfig) {
      throw new Error('所选 LLM 配置不存在');
    }
    const result = await runAgent({
      userInput,
      article,
      styleSource,
      llmConfig,
    }, (event) => send(res, event));

    const operations = result.operations || [];
    operations.forEach((operation) => {
      const block = article.blocks.find((item) => item.id === operation.block_id);
      send(res, {
        type: 'operation',
        operation,
        diff: computeDiff(block?.content || '', operation.new || ''),
      });
    });

    const citations = normalizeCitations(result.citations || []);
    const assistantMessage = result.text || (operations.length > 0 ? '已生成可应用的修改。' : '没有生成可应用的修改。');
    const messageResult = db.prepare(`
      INSERT INTO messages (conversation_id, role, content, citations)
      VALUES (?, 'assistant', ?, ?)
    `).run(convId, assistantMessage, JSON.stringify(citations));

    send(res, {
      type: 'done',
      conversation_id: convId,
      message_id: messageResult.lastInsertRowid,
      citations,
    });
  } catch (error) {
    send(res, { type: 'error', error: error.message });
  }

  return res.end();
}
