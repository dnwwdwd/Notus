function buildIntentModule(_session, options = {}) {
  const content = String(options.intentContract || '').trim();
  return {
    id: 'intent.contract',
    priority: 120,
    applies: Boolean(content),
    dynamic: true,
    maxTokens: 1_400,
    content,
  };
}

module.exports = { buildIntentModule };
