const { getDb } = require('./db');

const MAX_CHARS_PER_SOURCE = 12000;
const MAX_PROMPT_CHARS = 48000;

const TYPE_LABELS = {
  pdf: 'PDF 文档',
  docx: 'Word 文档',
  markdown: 'Markdown 文件',
  plaintext: '文本文件',
  webpage: '网页',
};

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

function normalizeSource(value) {
  return String(value || '').trim();
}

function hasAttachment(conversationId, source) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  const normalizedSource = normalizeSource(source);
  if (!normalizedConversationId || !normalizedSource) return false;
  const row = getDb().prepare(`
    SELECT id
    FROM messages
    WHERE conversation_id = ?
      AND type = 'parsed_attachment'
      AND json_extract(meta, '$.source') = ?
    LIMIT 1
  `).get(normalizedConversationId, normalizedSource);
  return Boolean(row);
}

function saveAttachment(conversationId, parsedContent) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  const source = normalizeSource(parsedContent?.source);
  const text = String(parsedContent?.text || '');
  if (!normalizedConversationId) throw new Error('conversation_id is required');
  if (!source) throw new Error('attachment source is required');
  if (!text.trim()) return null;
  if (hasAttachment(normalizedConversationId, source)) return null;

  const meta = {
    source,
    contentType: parsedContent.type || 'plaintext',
    pageCount: parsedContent.pageCount ?? null,
    status: parsedContent.status || 'success',
    warning: parsedContent.warning || null,
    errorCode: parsedContent.errorCode || null,
    metadata: parsedContent.metadata || null,
    parsedAt: parsedContent.parsedAt || new Date().toISOString(),
  };

  const result = getDb().prepare(`
    INSERT INTO messages (conversation_id, role, type, content, meta, created_at)
    VALUES (?, 'system', 'parsed_attachment', ?, ?, datetime('now'))
  `).run(normalizedConversationId, text, JSON.stringify(meta));

  return Number(result.lastInsertRowid);
}

function loadAttachments(conversationId) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  if (!normalizedConversationId) return [];
  const rows = getDb().prepare(`
    SELECT id, content, meta, created_at
    FROM messages
    WHERE conversation_id = ?
      AND type = 'parsed_attachment'
    ORDER BY id ASC
  `).all(normalizedConversationId);

  return rows.map((row) => {
    const meta = safeJsonParse(row.meta, {});
    return {
      id: Number(row.id),
      source: normalizeSource(meta.source),
      contentType: meta.contentType || meta.type || 'plaintext',
      pageCount: meta.pageCount ?? null,
      status: meta.status || 'success',
      warning: meta.warning || null,
      errorCode: meta.errorCode || null,
      metadata: meta.metadata || null,
      parsedAt: meta.parsedAt || row.created_at || '',
      text: String(row.content || ''),
    };
  }).filter((item) => item.source && item.text.trim());
}

function truncateSourceText(text, maxChars = MAX_CHARS_PER_SOURCE) {
  const source = String(text || '');
  if (source.length <= maxChars) return source;
  return `${source.slice(0, maxChars)}\n\n[...内容已截断，原文共 ${source.length} 字符]`;
}

function formatAttachmentBlock(item, maxCharsPerSource) {
  const label = TYPE_LABELS[item.contentType] || '文件';
  const warning = item.warning ? `\n> ${item.warning}` : '';
  const title = item.metadata?.title ? `\n标题：${item.metadata.title}` : '';
  return [
    `## 已导入${label}：${item.source}`,
    title,
    warning,
    '',
    truncateSourceText(item.text, maxCharsPerSource),
  ].join('\n');
}

function formatAttachmentsForPrompt(
  attachments = [],
  {
    maxCharsPerSource = MAX_CHARS_PER_SOURCE,
    maxTotalChars = MAX_PROMPT_CHARS,
  } = {}
) {
  const list = (Array.isArray(attachments) ? attachments : []).filter((item) => item?.text);
  if (list.length === 0) return '';

  let used = 0;
  const selected = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    const block = formatAttachmentBlock(item, maxCharsPerSource);
    const nextUsed = used + block.length;
    if (selected.length > 0 && nextUsed > maxTotalChars) break;
    selected.push(block);
    used = nextUsed;
    if (used >= maxTotalChars) break;
  }

  selected.reverse();
  return [
    '---',
    '# 本次对话已导入的文档/网页内容',
    '以下内容由用户主动导入，在本次对话中持续有效。回答和创作时可以直接引用这些内容，但不要声称它们来自知识库索引。',
    '',
    ...selected,
    '---',
  ].join('\n');
}

module.exports = {
  MAX_CHARS_PER_SOURCE,
  MAX_PROMPT_CHARS,
  formatAttachmentsForPrompt,
  hasAttachment,
  loadAttachments,
  saveAttachment,
};
