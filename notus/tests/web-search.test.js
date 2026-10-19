const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function buildTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notus-web-search-'));
}

async function runTests() {
  const tempDir = buildTempWorkspace();
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempDir;
  process.env.NOTUS_DATA_DIR = tempDir;

  [
    '../lib/db',
    '../lib/config',
    '../lib/conversations',
    '../lib/searchProviderConfigs',
    '../lib/webSearch',
    '../lib/webSearchContextStore',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const sdkCalls = [];
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === 'firecrawl') {
      return {
        default: class FakeFirecrawl {
          constructor(config) {
            sdkCalls.push({ provider: 'firecrawl', method: 'constructor', config });
          }

          async search(query, params) {
            sdkCalls.push({ provider: 'firecrawl', method: 'search', query, params });
            return {
              success: true,
              data: [{
                title: 'Firecrawl Result',
                url: 'https://example.com/firecrawl',
                markdown: 'firecrawl markdown',
                description: 'firecrawl snippet',
              }],
            };
          }
        },
      };
    }
    if (request === '@tavily/core') {
      return {
        tavily(config) {
          sdkCalls.push({ provider: 'tavily', method: 'constructor', config });
          return {
            async search(query, options) {
              sdkCalls.push({ provider: 'tavily', method: 'search', query, options });
              return {
                results: [{
                  title: 'Tavily Result',
                  url: 'https://example.com/tavily',
                  content: 'tavily content',
                  publishedDate: '2026-06-25',
                }],
              };
            },
          };
        },
      };
    }
    if (request === 'exa-js') {
      return {
        default: class FakeExa {
          constructor(apiKey) {
            sdkCalls.push({ provider: 'exa', method: 'constructor', apiKey });
          }

          async search(query, options) {
            sdkCalls.push({ provider: 'exa', method: 'search', query, options });
            return {
              results: [{
                title: 'Exa Result',
                url: 'https://example.com/exa',
                text: 'exa text',
                highlights: ['exa highlight'],
              }],
            };
          }
        },
      };
    }
    if (request === 'openai') {
      return class FakeOpenAI {
        constructor(config) {
          sdkCalls.push({ provider: 'zhipu', method: 'constructor', config });
          this.chat = {
            completions: {
              create: async (payload) => {
                sdkCalls.push({ provider: 'zhipu', method: 'chat.completions.create', payload });
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        results: [{
                          title: 'Zhipu Result',
                          url: 'https://example.com/zhipu',
                          content: 'zhipu content',
                        }],
                      }),
                    },
                  }],
                };
              },
            },
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { createConversation } = require('../lib/conversations');
    const {
      getSearchProviderConfig,
      hasConfiguredSearchProvider,
      resolveWebSearchConfig,
      saveSearchProviderConfig,
    } = require('../lib/searchProviderConfigs');
    const { webSearch } = require('../lib/webSearch');
    const {
      formatWebSearchContextsForPrompt,
      loadWebSearchContexts,
      saveWebSearchContext,
    } = require('../lib/webSearchContextStore');

    assert.strictEqual(hasConfiguredSearchProvider('firecrawl'), true);
    assert.strictEqual(hasConfiguredSearchProvider('tavily'), false);
    saveSearchProviderConfig({
      enabled: true,
      selected_provider: 'tavily',
      api_keys: { tavily: 'tvly-test' },
      counts: { tavily: 3 },
      modes: { tavily: 'advanced' },
    });
    assert.strictEqual(hasConfiguredSearchProvider('tavily'), true);
    assert.strictEqual(getSearchProviderConfig().api_key_set.tavily, true);
    const tavilyConfig = resolveWebSearchConfig('tavily');
    assert.strictEqual(tavilyConfig.provider, 'tavily');
    assert.strictEqual(tavilyConfig.api_key, 'tvly-test');
    assert.strictEqual(tavilyConfig.max_results, 3);
    assert.strictEqual(tavilyConfig.mode, 'advanced');

    const tavily = await webSearch('notus search', {
      provider: 'tavily',
      apiKey: 'tvly-test',
      mode: 'advanced',
      maxResults: 3,
    });
    assert.strictEqual(tavily.results.length, 1);
    assert.strictEqual(tavily.results[0].url, 'https://example.com/tavily');
    const tavilyCall = sdkCalls.find((call) => call.provider === 'tavily' && call.method === 'search');
    assert.strictEqual(tavilyCall.options.searchDepth, 'advanced');
    assert.strictEqual(tavilyCall.options.maxResults, 3);
    assert.strictEqual(tavilyCall.options.includeRawContent, 'markdown');

    const firecrawl = await webSearch('notus firecrawl', {
      provider: 'firecrawl',
      mode: 'default',
      maxResults: 5,
    });
    assert.strictEqual(firecrawl.results.length, 1);
    assert.strictEqual(firecrawl.results[0].content, 'firecrawl markdown');
    const firecrawlCtor = sdkCalls.find((call) => call.provider === 'firecrawl' && call.method === 'constructor');
    assert.strictEqual(firecrawlCtor.config.apiKey, null);

    const exa = await webSearch('notus exa', {
      provider: 'exa',
      apiKey: 'exa-test',
      mode: 'deep',
      maxResults: 4,
    });
    assert.strictEqual(exa.results[0].content, 'exa text');
    const exaCall = sdkCalls.find((call) => call.provider === 'exa' && call.method === 'search');
    assert.strictEqual(exaCall.options.numResults, 4);
    assert.strictEqual(exaCall.options.type, 'neural');
    assert.strictEqual(exaCall.options.contents.text.maxCharacters, 10000);

    const zhipu = await webSearch('notus zhipu', {
      provider: 'zhipu',
      apiKey: 'sk-test',
      mode: 'search-prime',
      maxResults: 6,
    });
    assert.strictEqual(zhipu.results[0].url, 'https://example.com/zhipu');
    const zhipuCtor = sdkCalls.find((call) => call.provider === 'zhipu' && call.method === 'constructor');
    assert.strictEqual(zhipuCtor.config.baseURL, 'https://open.bigmodel.cn/api/paas/v4/');
    const zhipuCall = sdkCalls.find((call) => call.provider === 'zhipu' && call.method === 'chat.completions.create');
    assert.strictEqual(zhipuCall.payload.tools[0].web_search.search_engine, 'search_pro');
    assert.strictEqual(zhipuCall.payload.tools[0].web_search.count, '6');

    assert.strictEqual(hasConfiguredSearchProvider('deepseek'), false);
    saveSearchProviderConfig({
      selected_provider: 'deepseek',
      api_keys: { deepseek: 'sk-deepseek-test' },
      counts: { deepseek: 3 },
      modes: { deepseek: 'normal' },
    });
    assert.strictEqual(hasConfiguredSearchProvider('deepseek'), true);
    const deepseekConfig = resolveWebSearchConfig('deepseek');
    assert.strictEqual(deepseekConfig.provider, 'deepseek');
    assert.strictEqual(deepseekConfig.api_key, 'sk-deepseek-test');
    assert.strictEqual(deepseekConfig.max_results, 3);
    assert.strictEqual(deepseekConfig.missing_api_key, false);

    const deepseekFetchCalls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      deepseekFetchCalls.push({ url, init: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            rerank_score: 2.4,
            title: 'DeepSeek Result',
            url: 'https://example.com/deepseek',
            snippet: 'deepseek snippet',
            summary: 'deepseek summary',
            content: 'deepseek content',
            date: '2026-06-01T00:00:00+00:00',
          }],
        }),
      };
    };
    try {
      const deepseek = await webSearch('notus deepseek', {
        provider: 'deepseek',
        apiKey: 'sk-deepseek-test',
        mode: 'normal',
        maxResults: 3,
      });
      assert.strictEqual(deepseek.provider, 'deepseek');
      assert.strictEqual(deepseek.results.length, 1);
      assert.strictEqual(deepseek.results[0].url, 'https://example.com/deepseek');
      assert.strictEqual(deepseek.results[0].content, 'deepseek content');
      assert.strictEqual(deepseek.results[0].publishedAt, '2026-06-01T00:00:00+00:00');
      assert.strictEqual(deepseekFetchCalls.length, 1);
      assert.strictEqual(deepseekFetchCalls[0].url, 'https://api.deepseek.com/v1/tools/search');
      assert.strictEqual(deepseekFetchCalls[0].init.count, 3);
      assert.strictEqual(deepseekFetchCalls[0].init.need_content, true);

      const deepseekFast = await webSearch('notus deepseek fast', {
        provider: 'deepseek',
        apiKey: 'sk-deepseek-test',
        mode: 'fast',
        maxResults: 60,
      });
      assert.strictEqual(deepseekFast.results[0].content, 'deepseek content');
      assert.strictEqual(deepseekFetchCalls[1].init.need_content, false);
      assert.strictEqual(deepseekFetchCalls[1].init.count, 50);
    } finally {
      global.fetch = originalFetch;
    }

    global.fetch = async () => ({
      ok: false,
      status: 402,
      json: async () => ({ error: { message: 'Insufficient Balance', type: 'invalid_request_error' } }),
    });
    try {
      await webSearch('notus deepseek error', {
        provider: 'deepseek',
        apiKey: 'sk-deepseek-test',
        mode: 'normal',
      });
      assert.fail('deepseek 非 200 响应应抛出错误');
    } catch (error) {
      assert.strictEqual(error.message, 'Insufficient Balance');
    } finally {
      global.fetch = originalFetch;
    }

    const conversation = createConversation({ kind: 'knowledge', title: '联网搜索上下文测试' });
    const messageId = saveWebSearchContext(conversation.id, {
      query: 'Notus',
      provider: 'firecrawl',
      durationMs: 12,
      sessionId: 1,
      results: [{
        title: 'Notus',
        url: 'https://example.com/notus',
        content: 'A'.repeat(4500),
        snippet: 'Notus snippet',
      }],
    });
    assert.ok(messageId > 0);
    const contexts = loadWebSearchContexts(conversation.id);
    assert.strictEqual(contexts.length, 1);
    assert.ok(contexts[0].results[0].content.includes('内容已截断'));
    const prompt = formatWebSearchContextsForPrompt(conversation.id);
    assert.ok(prompt.includes('历史联网搜索上下文'));
    assert.ok(prompt.includes('https://example.com/notus'));
  } finally {
    Module._load = originalLoad;
  }

  console.log('web search tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
