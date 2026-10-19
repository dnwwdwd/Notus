const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-llm-window-'));
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web',
  NOTUS_DATA_ROOT: tempRoot,
  NOTES_DIR: path.join(tempRoot, 'notes'),
  ASSETS_DIR: path.join(tempRoot, 'assets'),
  DB_PATH: path.join(tempRoot, 'notus.db'),
});

const { createLlmConfig, updateLlmConfig, getLlmConfigById } = require('../lib/llmConfigs');
const { deriveLlmConfigBudgetFields, DEFAULT_CONTEXT_WINDOW_TOKENS, resolveLlmBudget } = require('../lib/llmBudget');

async function main() {
  // 未设置时：所有模型统一默认 200k，不再按模型名特判。
  assert.strictEqual(DEFAULT_CONTEXT_WINDOW_TOKENS, 200000);
  assert.strictEqual(deriveLlmConfigBudgetFields({ model: 'qwen3-max' }).context_window_tokens, 200000);
  assert.strictEqual(deriveLlmConfigBudgetFields({ model: 'unknown-model-1m' }).context_window_tokens, 200000);
  assert.strictEqual(resolveLlmBudget({}, 'agent_loop').contextWindowTokens, 200000);

  const base = { name: '测试', provider: 'openai', api_protocol: 'openai', model: 'test-model', base_url: 'https://example.invalid/v1', api_key: 'sk-test' };

  // 创建时不填窗口 → 落库 200000。
  const created = createLlmConfig({ ...base });
  assert.strictEqual(created.context_window_tokens, 200000);

  // 创建时显式填写 → 落库显式值。
  const explicit = createLlmConfig({ ...base, model: 'big-model', context_window_tokens: 1000000 });
  assert.strictEqual(explicit.context_window_tokens, 1000000);

  // 更新时保留键缺省 → 不改动；显式 null → 回到默认推断。
  const untouched = updateLlmConfig(created.id, { name: '测试-改名' });
  assert.strictEqual(untouched.context_window_tokens, 200000);
  const explicitEdited = updateLlmConfig(explicit.id, { context_window_tokens: 524288 });
  assert.strictEqual(explicitEdited.context_window_tokens, 524288);
  const cleared = updateLlmConfig(explicit.id, { context_window_tokens: null });
  assert.strictEqual(cleared.context_window_tokens, 200000);

  // 显式窗口进入运行时预算：输出预留与安全余量照常生效。
  const runtime = resolveLlmBudget({ llmContextWindowTokens: 1000000, llmMaxOutputTokens: 32768 }, 'agent_loop');
  assert.strictEqual(runtime.contextWindowTokens, 1000000);
  assert.strictEqual(runtime.hardInputBudgetTokens, 1000000 - 32768 - 100000);

  // 越界输入按默认处理，不崩溃。
  assert.strictEqual(deriveLlmConfigBudgetFields({ model: 'x', context_window_tokens: 0 }).context_window_tokens, 200000);
  assert.strictEqual(getLlmConfigById(created.id).context_window_tokens, 200000);
  console.log('llm config context window tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
