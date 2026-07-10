function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeAnthropicApiBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return '';

  try {
    const target = normalized.includes('://') ? normalized : `https://${normalized}`;
    const url = new URL(target);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1';
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return normalized;
  }
}

function isOfficialAnthropicBaseUrl(value) {
  const normalized = normalizeAnthropicApiBaseUrl(value).toLowerCase();
  if (!normalized) return false;

  try {
    const target = normalized.includes('://') ? normalized : `https://${normalized}`;
    const hostname = new URL(target).hostname.toLowerCase();
    return hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com');
  } catch {
    return normalized.includes('anthropic.com');
  }
}

function buildAnthropicCompatibleAuthHeaders({ apiKey, baseUrl }) {
  if (!apiKey) return {};
  if (isOfficialAnthropicBaseUrl(baseUrl)) {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

module.exports = {
  normalizeBaseUrl,
  normalizeAnthropicApiBaseUrl,
  isOfficialAnthropicBaseUrl,
  buildAnthropicCompatibleAuthHeaders,
};
