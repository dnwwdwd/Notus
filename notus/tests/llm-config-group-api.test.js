const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-llm-group-'));
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web',
  NOTUS_DATA_ROOT: root,
  NOTES_DIR: path.join(root, 'notes'),
  ASSETS_DIR: path.join(root, 'assets'),
  DB_PATH: path.join(root, 'db.sqlite'),
  LOG_DIR: path.join(root, 'logs'),
});

function compileRoute(relativePath) {
  const endpoint = path.resolve(__dirname, relativePath);
  const compiled = new Module(endpoint, module);
  compiled.filename = endpoint;
  compiled.paths = Module._nodeModulePaths(path.dirname(endpoint));
  compiled._compile(
    fs.readFileSync(endpoint, 'utf8').replace(/export default (async )?function handler/, 'module.exports = $1function handler'),
    endpoint
  );
  return compiled.exports;
}

// 路由级测试不启动真实运行时（文件监听轮询会挂住进程），数据库走隔离 env 的 lib/db。
const runtimePath = require.resolve('../lib/runtime');
require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: { ensureRuntime: () => ({ ok: true }) } };

const { listLlmConfigs, getLlmConfigById, updateLlmConfig } = require('../lib/llmConfigs');

const configsRoute = compileRoute('../pages/api/settings/llm-configs/index.js');
const modelsRoute = compileRoute('../pages/api/settings/llm-models.js');

async function call(handler, { method = 'POST', body = {}, headers = {} } = {}) {
  const result = {};
  await handler({ method, body, headers }, {
    status(code) { result.status = code; return this; },
    json(payload) { result.body = payload; return this; },
    setHeader() {},
  });
  return result;
}

const SHARED = {
  name: 'DeepSeek',
  provider: 'deepseek',
  api_protocol: 'openai',
  base_url: 'https://api.test/v1/',
};

async function runTests() {
  // —— 1. 缺少 models：服务端仍要求模型数据 ——
  let response = await call(configsRoute, { body: { ...SHARED, api_key: 'sk-test', model: 'deepseek-chat' } });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'LLM_CONFIG_MODELS_REQUIRED');
  assert.equal(listLlmConfigs().length, 0, '缺少模型数据不得写入任何配置行');

  // —— 2. 保存不再强制连通性校验：未测试的模型可直接创建，latency 为空 ——
  response = await call(configsRoute, {
    body: {
      ...SHARED,
      api_key: 'sk-test',
      models: [{ model: 'deepseek-chat' }, { model: 'deepseek-reasoner', last_test_latency_ms: 200 }],
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.items.length, 2);
  assert.deepEqual(response.body.items.map((item) => item.model), ['deepseek-chat', 'deepseek-reasoner']);
  assert.ok(response.body.items[0].is_active, '组内首个模型应成为默认配置');
  assert.ok(!response.body.items[1].is_active);

  const stored = listLlmConfigs();
  assert.equal(stored.length, 2);
  assert.ok(stored.every((item) => item.base_url === 'https://api.test/v1'), 'base_url 应统一去掉尾斜杠');
  assert.ok(stored.every((item) => item.api_key_set));
  assert.equal(stored[0].last_test_latency_ms, null, '未测试模型 latency 应为 null');
  assert.equal(stored[1].last_test_latency_ms, 200);

  // —— 3. 无效 verification_token 不再拦截创建（连通性凭据仅为可选元数据） ——
  response = await call(configsRoute, {
    body: {
      ...SHARED,
      api_key: 'sk-test',
      models: [{ model: 'deepseek-chat', verification_token: 'invalid-token', last_test_latency_ms: 120 }],
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.items[0].model, 'deepseek-chat');

  // —— 4. 编辑场景：inherit_api_key_from 复用组内已存 Key，明文 Key 不需要回传 ——
  const firstRow = getLlmConfigById(response.body.items ? stored[0].id : stored[0].id);
  response = await call(configsRoute, {
    body: {
      ...SHARED,
      context_window_tokens: null,
      inherit_api_key_from: firstRow.id,
      models: [{ model: 'deepseek-v3' }],
    },
  });
  assert.equal(response.status, 201, '应能继承组内 API Key 创建新行');
  assert.equal(response.body.items[0].model, 'deepseek-v3');
  assert.equal(getLlmConfigById(response.body.items[0].id, { includeSecret: true }).api_key, 'sk-test');

  // —— 5. 缺 Key 且无继承来源：拒绝 ——
  response = await call(configsRoute, {
    body: { ...SHARED, models: [{ model: 'no-key-model' }] },
  });
  assert.equal(response.status, 400);

  // —— 5.5 仅切换默认模型不改变列表顺序（输入框选择模型不应"选了谁排最前"）——
  const beforeSwitch = listLlmConfigs().map((item) => item.id);
  const notActiveRow = listLlmConfigs().find((item) => !item.is_active);
  updateLlmConfig(notActiveRow.id, { set_default: true });
  const afterSwitch = listLlmConfigs();
  assert.deepEqual(afterSwitch.map((item) => item.id), beforeSwitch, '切换默认模型不得改变列表排序');
  assert.ok(afterSwitch.find((item) => item.id === notActiveRow.id).is_active, '目标行应成为默认配置');

  // 编辑内容后排序应更新（Provider 更新时间降序）；updated_at 为秒级精度，跨过秒边界再断言
  await new Promise((resolve) => setTimeout(resolve, 1100));
  updateLlmConfig(notActiveRow.id, { name: 'DeepSeek 更新' });
  assert.equal(listLlmConfigs()[0].id, notActiveRow.id, '编辑过的配置应按更新时间排到最前');

  // —— 6. 模型列表拉取：OpenAI 兼容协议 ——
  const upstreamRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    upstreamRequests.push({ url: String(url), headers: options.headers || {} });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ object: 'list', data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }),
    };
  };
  try {
    response = await call(modelsRoute, { body: { api_protocol: 'openai', base_url: 'https://api.test/v1', api_key: 'sk-test' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.models, ['model-a', 'model-b'], '模型列表应去重排序');
    assert.equal(upstreamRequests[0].url, 'https://api.test/v1/models');
    assert.equal(upstreamRequests[0].headers.Authorization, 'Bearer sk-test');

    // Anthropic 协议使用 x-api-key 与版本头
    response = await call(modelsRoute, { body: { api_protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_key: 'sk-ant' } });
    assert.equal(response.body.success, true);
    assert.equal(upstreamRequests[1].headers['x-api-key'], 'sk-ant');
    assert.equal(upstreamRequests[1].headers['anthropic-version'], '2023-06-01');

    // 已保存配置可按 llm_config_id 补齐 Key，不需要前端明文
    response = await call(modelsRoute, { body: { api_protocol: 'openai', base_url: 'https://api.test/v1', llm_config_id: firstRow.id } });
    assert.equal(response.body.success, true);
    assert.equal(upstreamRequests[2].headers.Authorization, 'Bearer sk-test');

    // 缺 Base URL：友好失败
    response = await call(modelsRoute, { body: { api_protocol: 'openai', base_url: '', api_key: 'sk-test' } });
    assert.equal(response.body.success, false);
    assert.match(response.body.error, /Base URL/);

    // 上游失败：透传为 success:false，不抛 500
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'upstream down' });
    response = await call(modelsRoute, { body: { api_protocol: 'openai', base_url: 'https://api.test/v1', api_key: 'sk-test' } });
    assert.equal(response.body.success, false);
    assert.match(response.body.error, /503/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('llm-config-group-api: all assertions passed');
  process.exit(0);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
