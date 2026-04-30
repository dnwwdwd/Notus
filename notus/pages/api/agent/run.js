const { ensureRuntime } = require('../../../lib/runtime');
const { runAgent } = require('../../../lib/agent');
const { computeDiff } = require('../../../lib/diff');
const { resolveLlmRuntimeConfig } = require('../../../lib/llmConfigs');
const {
  appendConversationMessage,
  ensureConversation,
  getConversationHistory,
  touchConversation,
} = require('../../../lib/conversations');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeCitations(citations = []) {
  return citations.map((item) => ({
    file: item.file_title || item.file || '',
    file_title: item.file_title || item.file || '',
    file_id: item.file_id || null,
    path: item.heading_path || item.path || '',
    heading_path: item.heading_path || item.path || '',
    quote: item.preview || item.content || item.quote || '',
    preview: item.preview || item.quote || '',
    lines: item.line_start && item.line_end ? `L${item.line_start}–${item.line_end}` : item.lines || '',
    line_start: item.line_start || null,
    line_end: item.line_end || null,
  }));
}

function summarizeOperation(operation, article) {
  if (!operation) return '';
  const targetIndex = (article?.blocks || []).findIndex((block) => block.id === operation.block_id);
  const blockLabel = targetIndex >= 0 ? `第 ${targetIndex + 1} 块` : `块 ${operation.block_id || ''}`;

  if (operation.op === 'insert') {
    return `在 ${blockLabel} 后新增一段内容`;
  }
  if (operation.op === 'delete') {
    return `删除 ${blockLabel}`;
  }
  return `改写 ${blockLabel}`;
}

function buildAssistantSummary(result, article) {
  if (result?.text) return result.text;
  const operations = Array.isArray(result?.operations) ? result.operations : [];
  const citations = Array.isArray(result?.citations) ? result.citations : [];
  if (operations.length === 0) {
    return citations.length > 0
      ? `已完成本轮分析，参考了 ${citations.length} 条资料，但没有生成可直接应用的修改。`
      : '已完成本轮分析，但没有生成可直接应用的修改。';
  }

  const operationSummary = operations
    .slice(0, 3)
    .map((operation) => summarizeOperation(operation, article))
    .filter(Boolean)
    .join('；');

  const moreText = operations.length > 3 ? `等 ${operations.length} 项修改` : `${operations.length} 项修改`;
  const citationText = citations.length > 0 ? `参考了 ${citations.length} 条资料。` : '未额外引用知识库资料。';
  return `已生成 ${moreText}：${operationSummary}。${citationText}`;
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
    active_file_id: activeFileId,
    reference_mode: referenceMode = 'auto',
    fact_file_ids: factFileIds = [],
    style_mode: styleMode = 'auto',
    style_file_ids: styleFileIds = [],
  } = req.body || {};

  if (!userInput || !article?.blocks) {
    return res.status(400).json({ error: 'user_input and article.blocks are required', code: 'INVALID_AGENT_REQUEST' });
  }

  const articleFileId = Number(article?.file_id || article?.fileId) || null;
  if (!articleFileId) {
    return res.status(400).json({
      error: '请先保存当前创作，再继续 AI 改写',
      code: 'ARTICLE_FILE_REQUIRED',
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const conversation = ensureConversation({
    conversationId,
    kind: 'canvas',
    title: userInput,
    fileId: articleFileId,
    draftKey: article?.draft_key || article?.draftKey || null,
  });
  const conversationHistory = getConversationHistory(conversation.id, { limit: 12 });
  appendConversationMessage({
    conversationId: conversation.id,
    role: 'user',
    content: userInput,
  });
  touchConversation(conversation.id);

  try {
    const llmConfig = llmConfigId ? resolveLlmRuntimeConfig({ llmConfigId }) : null;
    if (llmConfigId && !llmConfig) {
      throw new Error('所选 LLM 配置不存在');
    }
    const result = await runAgent({
      userInput,
      article,
      conversationHistory,
      activeFileId,
      referenceMode,
      factFileIds,
      styleMode,
      styleFileIds,
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
    const assistantMessage = buildAssistantSummary(result, article);
    const messageId = appendConversationMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: assistantMessage,
      citations,
    });
    touchConversation(conversation.id);

    send(res, {
      type: 'done',
      conversation_id: conversation.id,
      message_id: messageId,
      citations,
      usage: result.usage || null,
      budget: result.budget || null,
      compacted: Boolean(result.compacted),
    });
  } catch (error) {
    send(res, {
      type: 'error',
      error: error.message,
      conversation_id: conversation.id,
    });
  }

  return res.end();
}
