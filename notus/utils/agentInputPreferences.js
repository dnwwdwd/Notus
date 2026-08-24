const STORAGE_KEY = 'notus-agent-input-preferences';
const DEFAULT_AGENT_INPUT_PREFERENCE = {
  webSearchEnabled: false,
  searchProvider: '',
};

function normalizePreference(input = {}) {
  return {
    webSearchEnabled: Boolean(input.webSearchEnabled),
    searchProvider: String(input.searchProvider || '').trim(),
  };
}

function readStoredPreference() {
  if (typeof window === 'undefined') return DEFAULT_AGENT_INPUT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AGENT_INPUT_PREFERENCE;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_AGENT_INPUT_PREFERENCE;

    if ('webSearchEnabled' in parsed || 'searchProvider' in parsed) {
      return normalizePreference(parsed);
    }

    return normalizePreference(
      parsed.shared
      || parsed.canvas
      || parsed.knowledge
      || DEFAULT_AGENT_INPUT_PREFERENCE
    );
  } catch {
    return DEFAULT_AGENT_INPUT_PREFERENCE;
  }
}

export function readAgentInputPreference() {
  return readStoredPreference();
}

export function writeAgentInputPreference(_scope, preference) {
  if (typeof window === 'undefined') return;
  const nextPreference = normalizePreference(preference);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPreference));
  } catch {}
}
