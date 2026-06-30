const { getDb } = require('./db');

const MAX_RESULT_CONTENT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 36000;
const MAX_CONTEXT_ITEMS = 8;

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function truncate(text = '', maxChars = MAX_RESULT_CONTENT_CHARS) {
  const source = String(text || '');
  if (source.length <= maxChars) return source;
  return `${source.slice(0, maxChars)}\n\n[...内容已截断，原文共 ${source.length} 字符]`;
}

function normalizeResults(results = []) {
  return (Array.isArray(results) ? results : []).map((item) => ({
    title: String(item?.title || '').trim(),
    url: String(item?.url || '').trim(),
    content: truncate(item?.content || item?.snippet || ''),
    snippet: item?.snippet ? String(item.snippet).slice(0, 500) : '',
    publishedAt: item?.publishedAt || null,
  })).filter((item) => item.url || item.content);
}

function saveWebSearchContext(conversationId, payload = {}) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  if (!normalizedConversationId) return null;
  const results = normalizeResults(payload.results || []);
  if (results.length === 0) return null;
  const content = JSON.stringify({
    query: String(payload.query || '').trim(),
    provider: String(payload.provider || '').trim(),
    durationMs: Number(payload.durationMs || 0),
    results,
  });
  const meta = {
    source: 'web_search',
    query: String(payload.query || '').trim(),
    provider: String(payload.provider || '').trim(),
    session_id: normalizePositiveInt(payload.sessionId || payload.session_id),
    loop_index: Number(payload.loopIndex || payload.loop_index || 0),
    tool_use_id: String(payload.toolUseId || payload.tool_use_id || ''),
    result_count: results.length,
    duration_ms: Number(payload.durationMs || 0),
    searched_at: new Date().toISOString(),
  };
  const result = getDb().prepare(`
    INSERT INTO messages (conversation_id, role, type, content, meta, created_at)
    VALUES (?, 'system', 'web_search_context', ?, ?, datetime('now'))
  `).run(normalizedConversationId, content, JSON.stringify(meta));
  return Number(result.lastInsertRowid);
}

function loadWebSearchContexts(conversationId, { limit = MAX_CONTEXT_ITEMS } = {}) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  if (!normalizedConversationId) return [];
  const rows = getDb().prepare(`
    SELECT id, content, meta, created_at
    FROM messages
    WHERE conversation_id = ?
      AND type = 'web_search_context'
    ORDER BY id DESC
    LIMIT ?
  `).all(normalizedConversationId, Math.min(Math.max(Number(limit) || MAX_CONTEXT_ITEMS, 1), 20));
  return rows.reverse().map((row) => {
    const content = safeJsonParse(row.content, {});
    const meta = safeJsonParse(row.meta, {});
    return {
      id: Number(row.id),
      query: content.query || meta.query || '',
      provider: content.provider || meta.provider || '',
      durationMs: Number(content.durationMs || meta.duration_ms || 0),
      results: normalizeResults(content.results || []),
      createdAt: row.created_at || meta.searched_at || '',
      meta,
    };
  }).filter((item) => item.query && item.results.length > 0);
}

function formatWebSearchContextsForPrompt(conversationId, options = {}) {
  const contexts = loadWebSearchContexts(conversationId, options);
  if (contexts.length === 0) return '';
  let used = 0;
  const blocks = [];
  contexts.forEach((context, index) => {
    const resultLines = context.results.map((result, resultIndex) => [
      `### 结果 ${resultIndex + 1}: ${result.title || result.url || '未命名网页'}`,
      result.url ? `URL: ${result.url}` : '',
      result.publishedAt ? `发布时间: ${result.publishedAt}` : '',
      result.snippet ? `摘要: ${result.snippet}` : '',
      result.content ? `内容:\n${result.content}` : '',
    ].filter(Boolean).join('\n'));
    const block = [
      `## 联网搜索 ${index + 1}`,
      `查询: ${context.query}`,
      `服务商: ${context.provider}`,
      ...resultLines,
    ].join('\n');
    if (used + block.length > MAX_CONTEXT_CHARS) return;
    used += block.length;
    blocks.push(block);
  });
  if (blocks.length === 0) return '';
  return [
    '## 历史联网搜索上下文',
    '以下内容来自本会话此前的 web_search 工具调用，仅在用户本次打开联网搜索时使用。引用其中事实时优先给出 URL。',
    blocks.join('\n\n'),
  ].join('\n\n');
}

module.exports = {
  MAX_RESULT_CONTENT_CHARS,
  MAX_CONTEXT_CHARS,
  normalizeResults,
  saveWebSearchContext,
  loadWebSearchContexts,
  formatWebSearchContextsForPrompt,
};
