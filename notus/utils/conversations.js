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
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .map((message) => {
      const citations = Array.isArray(message.citations) ? message.citations : [];
      const meta = message?.meta && typeof message.meta === 'object' ? message.meta : null;
      const answerMode = kind === 'knowledge'
        ? (meta?.answer_mode || (message.role === 'assistant'
          ? (citations.length > 0 ? 'grounded' : 'no_evidence')
          : null))
        : null;
      return {
        id: message.id || `${message.role}-${Math.random().toString(16).slice(2)}`,
        role: message.role,
        content: String(message.content || ''),
        citations,
        meta,
        answerMode,
      };
    });
}
