const STORAGE_KEY = 'notus-agent-session-tokens';
const MAX_SESSION_TOKENS = 80;

function readStoredTokens() {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([sessionId, token]) => /^\d+$/.test(String(sessionId)) && typeof token === 'string' && token.length > 0 && token.length <= 256)
      .slice(-MAX_SESSION_TOKENS));
  } catch {
    return {};
  }
}

function writeStoredTokens(tokens) {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tokens)); } catch {}
}

export function rememberAgentSessionToken(sessionId, token) {
  const id = String(Number(sessionId) || '');
  const value = String(token || '').trim();
  if (!id || !value) return;
  const tokens = readStoredTokens();
  tokens[id] = value;
  const entries = Object.entries(tokens).slice(-MAX_SESSION_TOKENS);
  writeStoredTokens(Object.fromEntries(entries));
}

export function readAgentSessionToken(sessionId) {
  return readStoredTokens()[String(Number(sessionId) || '')] || '';
}

export function readAgentSessionTokenHeader() {
  const tokens = readStoredTokens();
  return Object.keys(tokens).length > 0 ? JSON.stringify(tokens) : '';
}
