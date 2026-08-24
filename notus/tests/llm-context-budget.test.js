const assert = require('assert');
const { resolveLlmBudget } = require('../lib/llmBudget');

async function run() {
  const budget = resolveLlmBudget({
    llmModel: 'test-model',
    llmContextWindowTokens: 10_000,
    llmMaxOutputTokens: 1_000,
  }, 'agent_loop', { maxOutputTokens: 1_000 });
  assert.strictEqual(budget.safetyMarginTokens, 1_000);
  assert.strictEqual(budget.hardInputBudgetTokens, 8_000);
  assert.strictEqual(budget.compactTriggerTokens, 6_800);

  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = 'https://example.invalid/v1';
  process.env.LLM_MODEL = 'test-model';
  const originalFetch = global.fetch;
  const requests = [];
  let call = 0;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    call += 1;
    if (call === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: 'ok', tool_calls: [] } }],
        usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 },
      }),
    };
  };

  try {
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/llm')];
    const { completeToolChat } = require('../lib/llm');
    const modes = [];
    const result = await completeToolChat({
      system: 'system policy',
      messages: [{ role: 'user', content: '普通长消息 '.repeat(200) }],
      tools: [{ name: 'read_file', description: 'schema '.repeat(200), input_schema: { type: 'object' } }],
      llmConfig: {
        llmApiKey: 'test-key',
        llmBaseUrl: 'https://example.invalid/v1',
        llmModel: 'test-model',
        llmApiProtocol: 'openai',
        llmContextWindowTokens: 10_000,
        llmMaxOutputTokens: 1_000,
      },
      compact: ({ messages, mode }) => {
        modes.push(mode);
        return { messages: [{ ...messages[messages.length - 1], content: mode === 'hard' ? 'hard compact' : 'soft compact' }] };
      },
      maxRetries: 1,
    });
    assert.strictEqual(requests.length, 2, 'overflow 只能重试一次');
    assert.ok(modes.includes('hard'), 'provider overflow 后必须执行 hard compact');
    assert.strictEqual(result.usage.total_tokens, 52);
  } finally {
    global.fetch = originalFetch;
  }

  console.log('llm context budget tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
