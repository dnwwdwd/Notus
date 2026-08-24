const ACTIVE_CONVERSATION_STORAGE_KEY = 'notus-files-active-conversation';

function normalizeConversationId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getBrowserStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readActiveConversationId(storage = getBrowserStorage()) {
  if (!storage) return null;
  try {
    return normalizeConversationId(storage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveActiveConversationId(value, storage = getBrowserStorage()) {
  if (!storage) return;
  try {
    const id = normalizeConversationId(value);
    if (id) storage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, String(id));
    else storage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch {}
}

module.exports = {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  normalizeConversationId,
  readActiveConversationId,
  saveActiveConversationId,
};
