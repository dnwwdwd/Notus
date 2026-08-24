const { getEffectiveConfig } = require('./config');

function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

function isExactLoopbackHost(value) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(value || '').trim().toLowerCase());
}

function requestHostIsLoopback(req = {}) {
  const rawHost = String(req.headers?.host || '').trim();
  if (!rawHost || rawHost.includes(',')) return false;
  try {
    const parsed = new URL(`http://${rawHost}`);
    return !parsed.username && !parsed.password && isExactLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

function hasForwardingHeaders(req = {}) {
  const headers = req.headers || {};
  return ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']
    .some((name) => String(headers[name] || '').trim());
}

function isDirectLoopbackRequest(req = {}) {
  return isLoopbackAddress(req.socket?.remoteAddress)
    && requestHostIsLoopback(req)
    && !hasForwardingHeaders(req);
}

function allowsLocalHttpMcp(req = {}) {
  if (!isDirectLoopbackRequest(req)) return false;
  const config = getEffectiveConfig();
  return config.runtimeTarget === 'electron'
    || process.env.NODE_ENV !== 'production'
    || config.allowLoopbackHttpMcp === true;
}

module.exports = {
  allowsLocalHttpMcp,
  hasForwardingHeaders,
  isDirectLoopbackRequest,
  isExactLoopbackHost,
  isLoopbackAddress,
  requestHostIsLoopback,
};
