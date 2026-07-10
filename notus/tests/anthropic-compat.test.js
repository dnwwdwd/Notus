const assert = require('assert');

const {
  buildAnthropicCompatibleAuthHeaders,
  isOfficialAnthropicBaseUrl,
  normalizeAnthropicApiBaseUrl,
} = require('../lib/anthropicCompat');
const { buildHeaders } = require('../lib/modelDiscovery');

assert.strictEqual(isOfficialAnthropicBaseUrl('https://api.anthropic.com/v1'), true);
assert.strictEqual(normalizeAnthropicApiBaseUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1');
assert.strictEqual(normalizeAnthropicApiBaseUrl('https://claude.hejiajun.com'), 'https://claude.hejiajun.com/v1');
assert.strictEqual(normalizeAnthropicApiBaseUrl('https://openrouter.ai/api/anthropic/v1'), 'https://openrouter.ai/api/anthropic/v1');
assert.strictEqual(isOfficialAnthropicBaseUrl('https://anthropic.example.com/v1'), false);
assert.strictEqual(isOfficialAnthropicBaseUrl('https://openrouter.ai/api/anthropic'), false);

assert.deepStrictEqual(
  buildAnthropicCompatibleAuthHeaders({
    apiKey: 'official-key',
    baseUrl: 'https://api.anthropic.com/v1',
  }),
  {
    'x-api-key': 'official-key',
    'anthropic-version': '2023-06-01',
  }
);

assert.deepStrictEqual(
  buildAnthropicCompatibleAuthHeaders({
    apiKey: 'proxy-key',
    baseUrl: 'https://openrouter.ai/api/anthropic/v1',
  }),
  {
    Authorization: 'Bearer proxy-key',
  }
);

assert.deepStrictEqual(
  buildHeaders('anthropic', 'proxy-key', 'https://openrouter.ai/api/anthropic/v1'),
  {
    Accept: 'application/json',
    Authorization: 'Bearer proxy-key',
  }
);

assert.deepStrictEqual(
  buildHeaders('anthropic', 'official-key', 'https://api.anthropic.com/v1'),
  {
    Accept: 'application/json',
    'x-api-key': 'official-key',
    'anthropic-version': '2023-06-01',
  }
);

console.log('anthropic-compat tests passed');
