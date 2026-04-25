const crypto = require('crypto');

const TOKEN_TTL_MS = 10 * 60 * 1000;
const verificationStore = new Map();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function cleanupExpiredTokens(now = Date.now()) {
  for (const [token, record] of verificationStore.entries()) {
    if (!record || record.expires_at <= now) {
      verificationStore.delete(token);
    }
  }
}

function buildEmbeddingFingerprint(config = {}) {
  return sha256(JSON.stringify({
    kind: 'embedding',
    provider: String(config.provider || '').trim(),
    model: String(config.model || '').trim(),
    base_url: normalizeBaseUrl(config.base_url),
    api_key: String(config.api_key || '').trim(),
    multimodal_enabled: Boolean(config.multimodal_enabled),
    dim: Number(config.dim || 0) || 0,
  }));
}

function buildLlmFingerprint(config = {}) {
  return sha256(JSON.stringify({
    kind: 'llm',
    provider: String(config.provider || '').trim(),
    model: String(config.model || '').trim(),
    base_url: normalizeBaseUrl(config.base_url),
    api_key: String(config.api_key || '').trim(),
  }));
}

function issueConnectivityVerificationToken({ kind, fingerprint }) {
  cleanupExpiredTokens();
  const token = crypto.randomUUID();
  verificationStore.set(token, {
    kind,
    fingerprint,
    expires_at: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

function consumeConnectivityVerificationToken({ token, kind, fingerprint }) {
  cleanupExpiredTokens();
  if (!token) return false;
  const record = verificationStore.get(String(token));
  if (!record) return false;
  verificationStore.delete(String(token));
  return record.kind === kind && record.fingerprint === fingerprint && record.expires_at > Date.now();
}

module.exports = {
  buildEmbeddingFingerprint,
  buildLlmFingerprint,
  issueConnectivityVerificationToken,
  consumeConnectivityVerificationToken,
};
