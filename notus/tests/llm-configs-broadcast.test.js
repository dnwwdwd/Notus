const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

// 用 vm 执行 useLlmConfigs 源码（替换 ESM import 为注入依赖），
// 用最小 React 语义模拟两个独立组件实例（设置页 / 文件工作区），
// 验证任一实例增删改配置后其他实例立即同步。
const source = fs.readFileSync(path.join(root, 'hooks/useLlmConfigs.js'), 'utf8');
// 剥掉 ESM import，hook 调用统一走 __react 分发器（每个实例各自的槽位）
const body = source
  .replace(/^import .*$/gm, '')
  .replace('export function useLlmConfigs', 'function useLlmConfigs')
  .replace(/\buseState\(/g, '__react.useState(')
  .replace(/\buseEffect\(/g, '__react.useEffect(')
  .replace(/\buseCallback\(/g, '__react.useCallback(');

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
  };
}

function createJsonErrorResponse(message) {
  return {
    ok: false,
    status: 500,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: message }),
  };
}

// 最小 hook 运行器：useState 同步槽位、useEffect 手动执行、useCallback 透传。
function createHookRunner(useLlmConfigs, moduleContext) {
  const slots = [];
  let slotIndex = 0;
  let effectQueue = [];
  const reactApi = {
    useState(init) {
      const index = slotIndex++;
      if (!(index in slots)) slots[index] = typeof init === 'function' ? init() : init;
      const setState = (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      };
      return [slots[index], setState];
    },
    useEffect(fn) {
      effectQueue.push(fn);
    },
    useCallback(fn) {
      return fn;
    },
  };

  function render() {
    slotIndex = 0;
    effectQueue = [];
    const previous = moduleContext.__react;
    moduleContext.__react = reactApi;
    try {
      return useLlmConfigs();
    } finally {
      moduleContext.__react = previous;
    }
  }

  function mount() {
    const result = render();
    const effects = effectQueue;
    effectQueue = [];
    const cleanups = effects.map((fn) => fn()).filter(Boolean);
    return { result, unmount: () => cleanups.forEach((fn) => fn()) };
  }

  return { render, mount };
}

function createStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function runTests() {
  // —— 初始服务端数据：一个已有配置 ——
  let serverConfigs = [{
    id: 11,
    name: 'DeepSeek',
    provider: 'deepseek',
    api_protocol: 'openai',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com/v1',
    api_key_set: true,
    is_active: true,
    context_window_tokens: 200000,
  }];
  let nextId = 12;
  const requests = [];

  const fetchMock = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    if (url === '/api/settings') {
      return createJsonResponse({
        llm_configs: serverConfigs,
        active_llm_config_id: serverConfigs.find((item) => item.is_active)?.id ?? null,
      });
    }
    if (url === '/api/settings/llm-configs' && options.method === 'POST') {
      const input = JSON.parse(options.body);
      const entries = Array.isArray(input.models) ? input.models : [{ model: input.model }];
      const items = entries.map((entry) => {
        const item = { id: nextId++, is_active: false, api_key_set: Boolean(input.api_key) || Boolean(input.inherit_api_key_from), model: entry.model, ...input };
        delete item.api_key;
        delete item.models;
        delete item.inherit_api_key_from;
        return item;
      });
      serverConfigs = [...serverConfigs, ...items];
      return createJsonResponse({ items });
    }
    const match = url.match(/^\/api\/settings\/llm-configs\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      if (options.method === 'PUT') {
        const input = JSON.parse(options.body);
        serverConfigs = serverConfigs.map((item) => {
          if (item.id !== id) return item;
          if (input.set_default) return { ...item, is_active: true };
          const next = { ...item, ...input };
          delete next.api_key;
          return next;
        });
        if (input.set_default) {
          serverConfigs = serverConfigs.map((item) => ({ ...item, is_active: item.id === id }));
        }
        return createJsonResponse({ item: serverConfigs.find((item) => item.id === id) });
      }
      if (options.method === 'DELETE') {
        serverConfigs = serverConfigs.filter((item) => item.id !== id);
        return createJsonResponse({ ok: true });
      }
    }
    return createJsonErrorResponse('unexpected request');
  };

  const storage = createStorage();
  const fetchJsonApi = {
    // 与 utils/fetchJson.js 等价的简化实现：JSON 回包直接解析，失败抛错
    readJsonResponse: async (response) => {
      const payload = JSON.parse(await response.text());
      if (!response.ok) throw new Error(payload?.error || '请求失败');
      return payload;
    },
  };

  // 所有实例共享同一个模块上下文，等价于浏览器同一页面内的模块级状态；
  // __react 分发器在每次 render 时按实例切换。
  const moduleContext = vm.createContext({
    window: { sessionStorage: storage },
    fetch: fetchMock,
    fetchJsonApi,
    console,
    setTimeout,
  });
  vm.runInContext(
    `const readJsonResponse = fetchJsonApi.readJsonResponse;\n${body}\nglobalThis.__useLlmConfigs = useLlmConfigs;`,
    moduleContext
  );
  const useLlmConfigs = moduleContext.__useLlmConfigs;

  const settingsRunner = createHookRunner(useLlmConfigs, moduleContext);
  const workspaceRunner = createHookRunner(useLlmConfigs, moduleContext);

  // —— 1. 两个实例先后挂载，各自读到相同初始列表 ——
  const settings = settingsRunner.mount();
  await flush();
  assert.equal(settingsRunner.render().configs.length, 1);
  assert.equal(settingsRunner.render().loading, false);

  const workspace = workspaceRunner.mount();
  await flush();
  assert.equal(workspaceRunner.render().configs.length, 1);
  assert.equal(workspaceRunner.render().loading, false, '已持有共享数据的实例挂载时不应回到加载态');

  const read = (runner) => runner.render();

  // —— 2. 设置页新增模型后，工作区立即看到，不需要重新挂载 ——
  const createdItems = await settings.result.createConfigs({
    name: 'OpenAI',
    provider: 'openai',
    api_protocol: 'openai',
    base_url: 'https://api.openai.com/v1',
    api_key: 'sk-test',
    models: [{ model: 'gpt-4o' }],
  });
  await flush();
  const created = createdItems[0];
  assert.equal(created.model, 'gpt-4o');

  const afterCreate = read(workspaceRunner);
  assert.equal(afterCreate.loading, false);
  assert.equal(afterCreate.configs.length, 2, '设置页新增后工作区模型列表必须立即包含新模型');
  assert.ok(afterCreate.configs.some((item) => item.model === 'gpt-4o'));

  // 缓存同步写入
  const cached = JSON.parse(storage.getItem('notus-llm-configs-cache'));
  assert.equal(cached.configs.length, 2);

  // —— 3. 工作区切换默认配置后，设置页同步 ——
  await workspace.result.setActiveConfig(created.id);
  await flush();
  const afterActivate = read(settingsRunner);
  assert.equal(afterActivate.activeConfigId, created.id);
  assert.equal(afterActivate.configs.find((item) => item.id === created.id).is_active, true);

  // —— 4. 设置页删除配置后，工作区同步移除 ——
  await settings.result.deleteConfig(11);
  await flush();
  const afterDelete = read(workspaceRunner);
  assert.equal(afterDelete.configs.length, 1);
  assert.ok(afterDelete.configs.every((item) => item.model !== 'deepseek-chat'));

  // —— 5. 卸载后监听器清理，不影响剩余实例 ——
  const extraRunner = createHookRunner(useLlmConfigs, moduleContext);
  const extra = extraRunner.mount();
  await flush();
  // 挂载一个临时实例再卸载，验证广播列表不残留
  const tempRunner = createHookRunner(useLlmConfigs, moduleContext);
  const temp = tempRunner.mount();
  await flush();
  temp.unmount();
  await settings.result.createConfigs({
    name: 'Qwen',
    provider: 'qwen',
    api_protocol: 'openai',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api_key: 'sk-qwen',
    models: [{ model: 'qwen-max' }],
  });
  await flush();
  assert.equal(read(extraRunner).configs.length, 2, '存活实例仍应继续接收同步');

  // —— 6. 读取失败路径：refresh 报错不广播旧数据，实例保留现有数据 ——
  const originalFetch = moduleContext.fetch;
  moduleContext.fetch = async () => createJsonErrorResponse('boom');
  let failed = false;
  try {
    await extra.result.refresh({ forceLoading: true });
  } catch {
    failed = true;
  }
  moduleContext.fetch = originalFetch;
  assert.equal(failed, true, 'refresh 失败应向上抛出由调用方提示');
  assert.equal(read(extraRunner).configs.length, 2, '失败后不应清空已展示的配置');

  console.log('llm-configs-broadcast: all assertions passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
