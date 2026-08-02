const { createEnvelope, renderEnvelope } = require('./envelope');

function buildResearchModule(options = {}) {
  const content = options.resourceContext ? JSON.stringify(options.resourceContext) : '';
  const envelope = content ? createEnvelope({ sourceType: 'knowledge', sourceId: 'conversation-resources', content }) : null;
  return {
    id: 'research.conversation-resources', priority: 55, applies: Boolean(envelope), dynamic: true,
    maxTokens: 12_000, evalCases: ['knowledge-injection'], envelopes: envelope ? [envelope] : [],
    content: envelope ? `## 对话资料\n${renderEnvelope(envelope)}` : '',
  };
}

module.exports = { buildResearchModule };
