const { buildLoopSystemPrompt } = require('../../agentLoopPrompt');

function buildPolicyModule(session) {
  return {
    id: 'policy.core',
    priority: 100,
    applies: true,
    maxTokens: 32_000,
    evalCases: ['policy-no-delete', 'policy-untrusted-material'],
    content: buildLoopSystemPrompt(session, {}),
  };
}

module.exports = { buildPolicyModule };
