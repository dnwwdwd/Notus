import { normalizeMentionSegments, normalizeMessageMentions, parseLegacyMentions, segmentsToContent, segmentsToMentions } from './messageMentions.js';

export function createDraftConversationKey(prefix = 'draft') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function getConversationTitle(item) {
  const title = String(item?.title || '').trim();
  if (title) return title;
  const preview = String(item?.preview || '').trim();
  return preview ? preview.slice(0, 40) : '新对话';
}

export function formatConversationOption(item) {
  const title = getConversationTitle(item);
  const preview = String(item?.preview || '').trim();
  if (!preview || preview === title) return title;
  return `${title} · ${preview}`.slice(0, 96);
}

export function mapConversationMessages(messages = [], kind = 'knowledge') {
  const rows = Array.isArray(messages) ? messages : [];
  const parsedAttachmentMap = rows.reduce((acc, message) => {
    const meta = message?.meta && typeof message.meta === 'object' ? message.meta : null;
    if (message?.type !== 'parsed_attachment' || !meta?.source) return acc;
    acc[String(meta.source || '').trim()] = {
      id: message.id,
      name: meta.source,
      source: meta.source,
      contentType: meta.contentType || meta.type || 'plaintext',
      pageCount: meta.pageCount ?? null,
      status: meta.status || 'success',
      warning: meta.warning || null,
      errorCode: meta.errorCode || null,
      metadata: meta.metadata || null,
      parsedAt: meta.parsedAt || message.created_at || '',
      text: String(message.content || ''),
    };
    return acc;
  }, {});

  return rows
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .map((message) => {
      const citations = Array.isArray(message.citations) ? message.citations : [];
      const meta = message?.meta && typeof message.meta === 'object' ? message.meta : null;
      const parsedAttachments = Array.isArray(meta?.attachments) ? meta.attachments.map((attachment, index) => {
        const key = String(attachment?.name || attachment?.source || '').trim();
        const parsed = key ? parsedAttachmentMap[key] : null;
        return {
          ...attachment,
          media_kind: 'attachment',
          upload_order: Number.isFinite(Number(attachment?.upload_order)) ? Number(attachment.upload_order) : index,
          ...(parsed ? { parsed } : {}),
        };
      }) : [];
      const images = Array.isArray(meta?.images) ? meta.images.map((image, index) => ({
        ...image,
        source_kind: 'image',
        media_kind: 'image',
        conversation_id: Number(message.conversation_id || 0) || null,
        upload_order: Number.isFinite(Number(image?.upload_order))
          ? Number(image.upload_order)
          : parsedAttachments.length + index,
      })) : [];
      const attachments = [...parsedAttachments, ...images].sort((left, right) => (
        Number(left.upload_order || 0) - Number(right.upload_order || 0)
      ));
      const answerMode = kind === 'knowledge'
        ? (meta?.answer_mode || (message.role === 'assistant'
          ? (citations.length > 0 ? 'grounded' : 'no_evidence')
          : null))
        : null;
      const structuredMentions = normalizeMessageMentions(meta?.mentions);
      const legacyMentions = structuredMentions.length > 0
        ? { mentions: structuredMentions, content: String(message.content || '') }
        : parseLegacyMentions(message.content);
      const mentionSegments = normalizeMentionSegments(meta?.mention_segments, legacyMentions.mentions, legacyMentions.content);
      return {
        id: message.id || `${message.role}-${Math.random().toString(16).slice(2)}`,
        role: message.role,
        content: segmentsToContent(mentionSegments),
        createdAt: message.created_at || message.updated_at || '',
        conversationId: Number(message.conversation_id || 0) || null,
        attachments,
        citations,
        sourceCount: Number(meta?.source_count || citations.length || 0),
        meta,
        mentions: segmentsToMentions(mentionSegments),
        mentionSegments,
        answerMode,
      };
    });
}
