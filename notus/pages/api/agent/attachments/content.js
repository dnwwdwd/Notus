const path = require('path');
const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const { parseDocument, SUPPORTED_EXTENSIONS } = require('../../../../lib/attachmentParsing');
const { loadAttachments } = require('../../../../lib/parsedAttachmentStore');
const { resolveUploadedAttachmentPath, sanitizeFileName } = require('../../../../lib/agentInputSources');

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function toContentPayload(result = {}, attachment = {}) {
  const contentType = result.contentType || result.type || attachment.contentType || attachment.extension?.replace(/^\./, '') || 'plaintext';
  return {
    source: result.source || attachment.name || attachment.source || '',
    contentType,
    status: result.status || 'success',
    warning: result.warning || null,
    errorCode: result.errorCode || null,
    pageCount: result.pageCount ?? null,
    parsedAt: result.parsedAt || '',
    text: String(result.text || ''),
    canCopy: contentType !== 'pdf',
  };
}

function findSavedAttachment(conversationId, source) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  const normalizedSource = sanitizeFileName(source);
  if (!normalizedConversationId || !normalizedSource) return null;
  return loadAttachments(normalizedConversationId).find((item) => item.source === normalizedSource) || null;
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/agent/attachments/content');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  try {
    const attachment = req.body?.attachment && typeof req.body.attachment === 'object' ? req.body.attachment : {};
    const displayName = sanitizeFileName(attachment.name || attachment.source || attachment.file_name || attachment.filename);
    const saved = findSavedAttachment(req.body?.conversation_id, displayName);
    if (saved) {
      return res.status(200).json({ ...toContentPayload(saved, attachment), request_id: context.request_id });
    }

    const extension = path.extname(displayName).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return res.status(400).json({
        error: `不支持的文件格式：${extension || '未知'}。当前支持 PDF、DOCX、MD、TXT。`,
        code: 'UNSUPPORTED_FORMAT',
        request_id: context.request_id,
      });
    }

    const storedPath = resolveUploadedAttachmentPath(attachment.stored_name || attachment.storedName);
    if (!storedPath) {
      return res.status(404).json({
        error: '附件内容不可用，可能是历史记录缺少临时文件引用。',
        code: 'ATTACHMENT_CONTENT_UNAVAILABLE',
        request_id: context.request_id,
      });
    }

    const parsed = await parseDocument(storedPath, displayName);
    if (parsed.status === 'error' && !String(parsed.text || '').trim()) {
      return res.status(422).json({ ...toContentPayload(parsed, attachment), error: parsed.warning || '附件解析失败', code: parsed.errorCode || 'PARSE_FAILED', request_id: context.request_id });
    }

    return res.status(200).json({ ...toContentPayload(parsed, attachment), request_id: context.request_id });
  } catch (error) {
    logger.error('agent.attachments.content.failed', { error });
    return res.status(500).json({
      error: error.message || '附件内容读取失败',
      code: error.code || 'ATTACHMENT_CONTENT_FAILED',
      request_id: context.request_id,
    });
  }
}
