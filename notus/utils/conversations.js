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
      return {
        id: message.id || `${message.role}-${Math.random().toString(16).slice(2)}`,
        role: message.role,
        content: String(message.content || ''),
        citations,
        noContext: kind === 'knowledge' && message.role === 'assistant' && citations.length === 0,
      };
    });
}
