const { sha256 } = require('../../files');
const { redactSecrets } = require('../../agentToolPolicy');

const SOURCE_LIMITS = {
  skill: 128 * 1024,
  knowledge: 96 * 1024,
  mcp: 64 * 1024,
  web: 64 * 1024,
  attachment: 96 * 1024,
  memory: 64 * 1024,
  workspace: 64 * 1024,
};

function truncateUtf8(value, maxBytes) {
  const input = Buffer.from(String(value || ''), 'utf8');
  if (input.length <= maxBytes) return { content: input.toString('utf8'), truncated: false };
  return {
    content: input.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/g, ''),
    truncated: true,
  };
}

function createEnvelope({ sourceType, sourceId, trust = 'untrusted', content = '', maxBytes = null } = {}) {
  const type = String(sourceType || 'unknown');
  const redacted = redactSecrets(String(content || ''));
  const originalDigest = sha256(redacted);
  const clipped = truncateUtf8(redacted, maxBytes || SOURCE_LIMITS[type] || 64 * 1024);
  return {
    source_type: type,
    source_id: String(sourceId || originalDigest.slice(0, 16)),
    trust: trust === 'user_managed' ? 'user_managed' : 'untrusted',
    content: clipped.content,
    truncated: clipped.truncated,
    digest: originalDigest,
  };
}

function renderEnvelope(envelope) {
  return `<notus-material-envelope>${JSON.stringify(envelope)}</notus-material-envelope>`;
}

module.exports = { SOURCE_LIMITS, createEnvelope, renderEnvelope };
