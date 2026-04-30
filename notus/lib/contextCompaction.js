const {
  estimateTextTokens,
  trimTextToTokenBudget,
} = require('./llmBudget');

function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({
      role: message.role,
      content: String(message.content || '').trim(),
    }))
    .filter((message) => message.content);
}

function splitCompletedTurns(history = []) {
  const messages = normalizeHistory(history);
  const turns = [];
  let pendingUser = null;

  messages.forEach((message) => {
    if (message.role === 'user') {
      if (pendingUser) {
        turns.push({ user: pendingUser, assistant: null });
      }
      pendingUser = message.content;
      return;
    }

    if (pendingUser) {
      turns.push({ user: pendingUser, assistant: message.content });
      pendingUser = null;
    }
  });

  return {
    turns,
    danglingUser: pendingUser,
  };
}

function buildHistorySummary(history = [], options = {}) {
  const {
    keepRecentMessages = 6,
    maxOlderTurns = 4,
    userTokenBudget = 70,
    assistantTokenBudget = 110,
  } = options;
  const normalized = normalizeHistory(history);
  const recentHistory = normalized.slice(-Math.max(0, keepRecentMessages));
  const olderHistory = normalized.slice(0, Math.max(0, normalized.length - recentHistory.length));
  const { turns } = splitCompletedTurns(olderHistory);
  const selectedTurns = turns.slice(-Math.max(0, maxOlderTurns));

  if (selectedTurns.length === 0) {
    return {
      recentHistory,
      memorySummary: '',
    };
  }

  const lines = [
    '用户持续上下文：',
  ];
  selectedTurns.forEach((turn, index) => {
    lines.push(`${index + 1}. 用户：${trimTextToTokenBudget(turn.user || '', userTokenBudget, ' …')}`);
    if (turn.assistant) {
      lines.push(`   助手：${trimTextToTokenBudget(turn.assistant, assistantTokenBudget, ' …')}`);
    }
  });

  return {
    recentHistory,
    memorySummary: lines.join('\n'),
  };
}

function sanitizeKnowledgeSections(sections = [], options = {}) {
  const {
    sectionLimit = 4,
    quoteLimit = 3,
    quoteTokenBudget = 140,
    headingTokenBudget = 80,
  } = options;

  return (Array.isArray(sections) ? sections : [])
    .slice(0, Math.max(0, sectionLimit))
    .map((section) => ({
      ...section,
      heading_path: trimTextToTokenBudget(section.heading_path || '', headingTokenBudget, ' …'),
      quotes: (Array.isArray(section.quotes) ? section.quotes : [])
        .slice(0, Math.max(0, quoteLimit))
        .map((quote) => ({
          ...quote,
          content: trimTextToTokenBudget(quote.content || quote.preview || '', quoteTokenBudget),
          preview: trimTextToTokenBudget(quote.preview || quote.content || '', quoteTokenBudget),
        })),
    }))
    .filter((section) => (section.quotes || []).length > 0);
}

function sanitizeKnowledgeChunks(chunks = [], options = {}) {
  const {
    chunkLimit = 3,
    chunkTokenBudget = 220,
    headingTokenBudget = 80,
  } = options;

  return (Array.isArray(chunks) ? chunks : [])
    .slice(0, Math.max(0, chunkLimit))
    .map((chunk) => ({
      ...chunk,
      heading_path: trimTextToTokenBudget(chunk.heading_path || '', headingTokenBudget, ' …'),
      content: trimTextToTokenBudget(chunk.content || '', chunkTokenBudget),
      preview: trimTextToTokenBudget(chunk.preview || chunk.content || '', chunkTokenBudget),
    }));
}

function sanitizeStyleSamples(samples = [], options = {}) {
  const {
    limit = 4,
    contentTokenBudget = 180,
    headingTokenBudget = 70,
  } = options;

  return (Array.isArray(samples) ? samples : [])
    .slice(0, Math.max(0, limit))
    .map((sample) => ({
      ...sample,
      heading_path: trimTextToTokenBudget(sample.heading_path || '', headingTokenBudget, ' …'),
      content: trimTextToTokenBudget(sample.content || sample.preview || '', contentTokenBudget),
      preview: trimTextToTokenBudget(sample.preview || sample.content || '', contentTokenBudget),
    }));
}

function sortByTokenWeight(items = [], getText) {
  return [...items].sort((a, b) => estimateTextTokens(getText(a)) - estimateTextTokens(getText(b)));
}

module.exports = {
  normalizeHistory,
  splitCompletedTurns,
  buildHistorySummary,
  sanitizeKnowledgeSections,
  sanitizeKnowledgeChunks,
  sanitizeStyleSamples,
  sortByTokenWeight,
};
