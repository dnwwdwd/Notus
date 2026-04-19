let jieba = null;
let jiebaLoaded = false;
let jiebaError = null;

function loadJieba() {
  if (jiebaLoaded || jiebaError) return jieba;
  try {
    jieba = require('jieba-wasm');
    jiebaLoaded = true;
  } catch (error) {
    jiebaError = error;
  }
  return jieba;
}

function fallbackTokens(text) {
  const source = String(text || '').toLowerCase();
  const latin = source.match(/[a-z0-9_][a-z0-9_.-]{1,}/g) || [];
  const chinese = source.match(/[\u4e00-\u9fff]/g) || [];
  const bigrams = [];
  for (let i = 0; i < chinese.length - 1; i += 1) {
    bigrams.push(`${chinese[i]}${chinese[i + 1]}`);
  }
  return [...latin, ...chinese, ...bigrams];
}

function uniqueTokens(tokens) {
  return [...new Set(
    tokens
      .map((token) => String(token || '').trim().toLowerCase())
      .filter((token) => token.length > 0 && token.length <= 40)
  )];
}

function segmentText(text, limit = 200) {
  const source = String(text || '');
  const loaded = loadJieba();

  if (loaded?.cut_for_search) {
    try {
      return uniqueTokens(loaded.cut_for_search(source)).slice(0, limit);
    } catch (error) {
      jiebaError = error;
    }
  }

  return uniqueTokens(fallbackTokens(source)).slice(0, limit);
}

function buildSearchText(text) {
  const tokens = segmentText(text, 500);
  return tokens.length > 0 ? tokens.join(' ') : String(text || '');
}

function escapeFtsToken(token) {
  return String(token || '').replace(/"/g, '""');
}

function buildFtsQuery(query) {
  const tokens = segmentText(query, 20);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${escapeFtsToken(token)}"`).join(' OR ');
}

function getTokenizerStatus() {
  return {
    jiebaLoaded,
    error: jiebaError ? jiebaError.message : null,
  };
}

module.exports = {
  segmentText,
  buildSearchText,
  buildFtsQuery,
  getTokenizerStatus,
};
