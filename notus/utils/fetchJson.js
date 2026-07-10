function looksLikeHtml(text) {
  return /^<!doctype html|^<html\b|^</i.test(String(text || '').trim());
}

function summarizeText(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function buildFallbackMessage(response, fallbackMessage, rawText) {
  const trimmed = String(rawText || '').trim();
  if (looksLikeHtml(trimmed)) {
    return `${fallbackMessage}：服务端返回了 HTML 错误页`;
  }

  const preview = summarizeText(trimmed);
  if (preview) {
    return `${fallbackMessage}：${preview}`;
  }

  return `${fallbackMessage}（HTTP ${response.status}）`;
}

export async function readJsonResponse(response, options = {}) {
  const fallbackMessage = options.fallbackMessage || '请求失败';
  const invalidJsonMessage = options.invalidJsonMessage || `${fallbackMessage}：服务端返回了无效 JSON`;
  const nonJsonMessage = options.nonJsonMessage || `${fallbackMessage}：服务端未返回 JSON`;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const rawText = await response.text();
  const trimmed = String(rawText || '').trim();
  const canParseJson = Boolean(trimmed) && (
    contentType.includes('application/json')
    || trimmed.startsWith('{')
    || trimmed.startsWith('[')
  );

  let payload = {};
  if (canParseJson) {
    try {
      payload = JSON.parse(trimmed);
    } catch {
      throw new Error(invalidJsonMessage);
    }
  }

  if (!response.ok) {
    const message = typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : buildFallbackMessage(response, fallbackMessage, rawText);
    throw new Error(message);
  }

  if (trimmed && !canParseJson) {
    throw new Error(looksLikeHtml(trimmed) ? `${fallbackMessage}：服务端返回了 HTML 错误页` : nonJsonMessage);
  }

  return payload && typeof payload === 'object' ? payload : {};
}
