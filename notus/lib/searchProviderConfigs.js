const { getSetting, setSettings } = require('./db');

const SEARCH_PROVIDERS = [
  { id: 'firecrawl', name: 'Firecrawl', quota_url: 'https://www.firecrawl.dev/', max_limit: 20, requires_api_key: false },
  { id: 'tavily', name: 'Tavily', quota_url: 'https://app.tavily.com/home', max_limit: 20, requires_api_key: true },
  { id: 'exa', name: 'Exa', quota_url: 'https://dashboard.exa.ai/api-keys', max_limit: 100, requires_api_key: true },
  { id: 'zhipu', name: '智谱', quota_url: 'https://bigmodel.cn/usercenter/proj-mgmt/overview', max_limit: 50, requires_api_key: true },
];

const DEFAULT_MODES = {
  firecrawl: 'default',
  tavily: 'basic',
  exa: 'auto',
  zhipu: 'search-prime',
};

const DEFAULT_COUNTS = {
  firecrawl: 5,
  tavily: 5,
  exa: 10,
  zhipu: 5,
};

const SETTINGS_KEY = 'agent_search_provider_config';

function normalizeProviderId(value) {
  const id = String(value || '').trim().toLowerCase();
  return SEARCH_PROVIDERS.some((item) => item.id === id) ? id : 'firecrawl';
}

function clampCount(providerId, value) {
  const provider = SEARCH_PROVIDERS.find((item) => item.id === providerId) || SEARCH_PROVIDERS[0];
  const parsed = Number.parseInt(value, 10);
  const fallback = DEFAULT_COUNTS[providerId] || 5;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), provider.max_limit);
}

function normalizeMode(providerId, value) {
  const mode = String(value || '').trim();
  return mode || DEFAULT_MODES[providerId] || 'default';
}

function parseStoredConfig() {
  const raw = getSetting(SETTINGS_KEY, '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeConfig(input = {}) {
  const selectedProvider = normalizeProviderId(input.selected_provider || input.selectedProvider);
  const modes = {};
  const counts = {};
  const apiKeys = {};
  const storedModes = input.modes && typeof input.modes === 'object' ? input.modes : {};
  const storedCounts = input.counts && typeof input.counts === 'object' ? input.counts : {};
  const storedKeys = input.api_keys && typeof input.api_keys === 'object' ? input.api_keys : {};

  SEARCH_PROVIDERS.forEach((provider) => {
    modes[provider.id] = normalizeMode(provider.id, storedModes[provider.id]);
    counts[provider.id] = clampCount(provider.id, storedCounts[provider.id]);
    apiKeys[provider.id] = String(storedKeys[provider.id] || '').trim();
  });

  return {
    enabled: Boolean(input.enabled),
    selected_provider: selectedProvider,
    modes,
    counts,
    api_keys: apiKeys,
  };
}

function publicConfigFromStored(stored = {}) {
  const normalized = normalizeConfig(stored);
  const apiKeySet = {};
  SEARCH_PROVIDERS.forEach((provider) => {
    apiKeySet[provider.id] = Boolean(normalized.api_keys[provider.id]);
  });
  return {
    enabled: normalized.enabled,
    selected_provider: normalized.selected_provider,
    modes: normalized.modes,
    counts: normalized.counts,
    api_key_set: apiKeySet,
    providers: SEARCH_PROVIDERS,
  };
}

function getSearchProviderConfig() {
  return publicConfigFromStored(parseStoredConfig());
}

function getStoredSearchProviderConfig() {
  return normalizeConfig(parseStoredConfig());
}

function saveSearchProviderConfig(input = {}) {
  const previous = normalizeConfig(parseStoredConfig());
  const nextInput = {
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : previous.enabled,
    selected_provider: input.selected_provider || input.selectedProvider || previous.selected_provider,
    modes: {
      ...previous.modes,
      ...(input.modes && typeof input.modes === 'object' ? input.modes : {}),
    },
    counts: {
      ...previous.counts,
      ...(input.counts && typeof input.counts === 'object' ? input.counts : {}),
    },
    api_keys: { ...previous.api_keys },
  };

  if (input.api_keys && typeof input.api_keys === 'object') {
    Object.entries(input.api_keys).forEach(([providerId, value]) => {
      if (!SEARCH_PROVIDERS.some((provider) => provider.id === providerId)) return;
      const nextValue = String(value || '').trim();
      if (nextValue) nextInput.api_keys[providerId] = nextValue;
    });
  }

  const normalized = normalizeConfig(nextInput);
  setSettings({ [SETTINGS_KEY]: JSON.stringify(normalized) });
  return publicConfigFromStored(normalized);
}

function hasConfiguredSearchProvider(providerId) {
  const stored = normalizeConfig(parseStoredConfig());
  const id = normalizeProviderId(providerId || stored.selected_provider);
  const provider = SEARCH_PROVIDERS.find((item) => item.id === id);
  if (provider && provider.requires_api_key === false) return true;
  return Boolean(stored.api_keys[id]);
}

function resolveWebSearchConfig(providerId = '') {
  const stored = getStoredSearchProviderConfig();
  const provider = normalizeProviderId(providerId || stored.selected_provider);
  const providerMeta = SEARCH_PROVIDERS.find((item) => item.id === provider) || SEARCH_PROVIDERS[0];
  const apiKey = stored.api_keys[provider] || '';
  const missingApiKey = Boolean(providerMeta.requires_api_key && !apiKey);
  return {
    enabled: Boolean(stored.enabled),
    provider,
    provider_name: providerMeta.name,
    requires_api_key: Boolean(providerMeta.requires_api_key),
    api_key: apiKey,
    api_key_set: Boolean(apiKey),
    missing_api_key: missingApiKey,
    mode: stored.modes[provider] || DEFAULT_MODES[provider] || 'default',
    max_results: clampCount(provider, stored.counts[provider]),
    quota_url: providerMeta.quota_url || '',
  };
}

module.exports = {
  SEARCH_PROVIDERS,
  normalizeProviderId,
  getSearchProviderConfig,
  getStoredSearchProviderConfig,
  saveSearchProviderConfig,
  hasConfiguredSearchProvider,
  resolveWebSearchConfig,
};
