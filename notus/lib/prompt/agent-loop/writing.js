const { createEnvelope, renderEnvelope } = require('./envelope');

function buildWritingModule(options = {}) {
  const parts = [];
  if (options.globalAgentContext?.style) parts.push(String(options.globalAgentContext.style));
  if (options.styleContext) parts.push(JSON.stringify(options.styleContext));
  const envelope = parts.length ? createEnvelope({ sourceType: 'workspace', sourceId: 'writing-style', trust: 'user_managed', content: parts.join('\n\n') }) : null;
  return {
    id: 'writing.style-context', priority: 60, applies: Boolean(envelope), dynamic: true,
    maxTokens: 8_000, evalCases: ['writing-style-data-only'], envelopes: envelope ? [envelope] : [],
    content: envelope ? `## 写作风格材料\n${renderEnvelope(envelope)}` : '',
  };
}

module.exports = { buildWritingModule };
