function normalizeTextMessage(text = '', fallbackMessage = '请求失败') {
  const normalized = String(text || '').trim();
  if (!normalized) return fallbackMessage;
  if (normalized.startsWith('<')) return fallbackMessage;
  if (/^Internal Server Error$/i.test(normalized)) return fallbackMessage;
  return normalized.split('\n').map((line) => line.trim()).find(Boolean) || fallbackMessage;
}

export async function readApiResponse(response, fallbackMessage = '请求失败') {
  const text = await response.text().catch(() => '');
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      payload?.error ||
      payload?.message ||
      normalizeTextMessage(text, fallbackMessage)
    );
  }

  if (payload !== null) {
    return payload;
  }

  if (!text) {
    return {};
  }

  throw new Error(normalizeTextMessage(text, fallbackMessage));
}
