const path = require('path');
const { getEffectiveConfig } = require('./config');
const { parseDocument, parseUrl, extractWebUrls, SUPPORTED_EXTENSIONS } = require('./attachmentParsing');
const { hasAttachment, saveAttachment } = require('./parsedAttachmentStore');

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function sanitizeFileName(value) {
  return path.basename(String(value || '未命名附件')).replace(/[<>:"|?*\x00-\x1F]/g, '_').slice(0, 180) || '未命名附件';
}

function resolveUploadedAttachmentPath(storedName) {
  const config = getEffectiveConfig();
  const attachmentsDir = path.resolve(config.sessionDir, 'attachments');
  const safeStoredName = path.basename(String(storedName || ''));
  if (!safeStoredName) return null;
  const absolutePath = path.resolve(attachmentsDir, safeStoredName);
  if (!absolutePath.startsWith(`${attachmentsDir}${path.sep}`)) return null;
  return absolutePath;
}

function summarizeParseResult(result = {}, extra = {}) {
  return {
    source: result.source || extra.source || '',
    type: result.type || extra.type || 'plaintext',
    status: result.status || 'error',
    warning: result.warning || null,
    errorCode: result.errorCode || null,
    pageCount: result.pageCount ?? null,
    textLength: String(result.text || '').length,
    duplicate: Boolean(extra.duplicate),
  };
}

async function parseUploadedAttachment(conversationId, attachment = {}) {
  const displayName = sanitizeFileName(attachment.name || attachment.file_name || attachment.filename);
  const ext = path.extname(displayName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      source: displayName,
      type: 'plaintext',
      status: 'error',
      text: '',
      errorCode: 'UNSUPPORTED_FORMAT',
      warning: `不支持的文件格式：${ext || '未知'}。当前支持 PDF、DOCX、MD、TXT。`,
      parsedAt: new Date().toISOString(),
    };
  }
  if (hasAttachment(conversationId, displayName)) {
    return {
      source: displayName,
      type: 'plaintext',
      status: 'success',
      text: '',
      warning: '该文件已在本次对话中导入，无需重复解析。',
      parsedAt: new Date().toISOString(),
      duplicate: true,
    };
  }
  const filePath = resolveUploadedAttachmentPath(attachment.stored_name || attachment.storedName);
  if (!filePath) {
    return {
      source: displayName,
      type: 'plaintext',
      status: 'error',
      text: '',
      errorCode: 'PARSE_FAILED',
      warning: '附件临时文件引用无效。',
      parsedAt: new Date().toISOString(),
    };
  }
  const result = await parseDocument(filePath, displayName);
  if (result.status !== 'error') saveAttachment(conversationId, result);
  return result;
}

async function parseWebUrlForConversation(conversationId, url) {
  if (hasAttachment(conversationId, url)) {
    return {
      source: url,
      type: 'webpage',
      status: 'success',
      text: '',
      warning: '该链接已在本次对话中导入，无需重复抓取。',
      parsedAt: new Date().toISOString(),
      duplicate: true,
    };
  }
  const result = await parseUrl(url);
  if (result.status !== 'error') saveAttachment(conversationId, result);
  return result;
}

async function parseAgentInputSources({ conversationId, attachments = [], userInputText, text = '', onEvent } = {}) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  if (!normalizedConversationId) return [];
  const results = [];
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const sourceText = userInputText === undefined ? text : userInputText;

  const uploadedAttachments = Array.isArray(attachments) ? attachments : [];
  for (const attachment of uploadedAttachments) {
    const source = sanitizeFileName(attachment?.name || attachment?.file_name || attachment?.filename);
    emit({ type: 'attachment_parse_start', source, source_kind: attachment?.source_kind || 'file' });
    const result = await parseUploadedAttachment(normalizedConversationId, attachment);
    const summary = summarizeParseResult(result, { source });
    results.push(summary);
    emit({ ...summary, type: 'attachment_parse_done', source_kind: attachment?.source_kind || 'file' });
  }

  const urls = extractWebUrls(sourceText);
  for (const url of urls) {
    emit({ type: 'attachment_parse_start', source: url, source_kind: 'url' });
    const result = await parseWebUrlForConversation(normalizedConversationId, url);
    const summary = summarizeParseResult(result, { source: url, type: 'webpage' });
    results.push(summary);
    emit({ ...summary, type: 'attachment_parse_done', source_kind: 'url' });
  }

  return results;
}

module.exports = {
  parseAgentInputSources,
  parseUploadedAttachment,
  parseWebUrlForConversation,
  resolveUploadedAttachmentPath,
  sanitizeFileName,
  summarizeParseResult,
};
