const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-global-agent-files-'));
process.env.NOTUS_RUNTIME_TARGET = 'web';
process.env.NOTUS_DATA_ROOT = dataRoot;
process.env.NOTES_DIR = path.join(dataRoot, 'notes');
process.env.ASSETS_DIR = path.join(dataRoot, 'assets');
process.env.DB_PATH = path.join(dataRoot, 'notus.db');
process.env.LOG_DIR = path.join(dataRoot, 'logs');
process.env.SESSION_DIR = path.join(dataRoot, 'session');

const { initDb } = require('../lib/db');
const { createSession } = require('../lib/agentSession');
const { buildToolDefinitions, executeUpdateGlobalAgentFile } = require('../lib/agentTools');
const { buildLoopSystemPrompt } = require('../lib/agentLoopPrompt');
const { resolvePlatformPaths } = require('../lib/platform/paths');
const {
  DEFAULTS,
  FILE_TYPES,
  initializeGlobalAgentFiles,
  readFile,
  saveFile,
  listHistory,
  rollbackHistory,
  buildGlobalAgentContext,
  agentUpdateAllowed,
} = require('../lib/globalAgentFiles');

function readPath(type) {
  return path.join(dataRoot, 'agent', `${type}.md`);
}

function run() {
  initDb();

  const paths = resolvePlatformPaths({ NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: dataRoot }, { runtimeTarget: 'web' });
  assert.strictEqual(paths.agentDir, path.join(dataRoot, 'agent'));
  const originalDataRoot = process.env.NOTUS_DATA_ROOT;
  delete process.env.NOTUS_DATA_ROOT;
  assert.strictEqual(resolvePlatformPaths({}, { runtimeTarget: 'electron', cwd: dataRoot }).agentDir, path.join(dataRoot, '.notus-desktop-data', 'agent'));
  process.env.NOTUS_DATA_ROOT = originalDataRoot;
  assert.strictEqual(resolvePlatformPaths({}, { runtimeTarget: 'lazycat', cwd: dataRoot }).agentDir, '/lzcapp/var/notus/agent');

  initializeGlobalAgentFiles();
  FILE_TYPES.forEach((type) => assert.strictEqual(fs.readFileSync(readPath(type), 'utf8'), DEFAULTS[type]));
  assert.strictEqual(listHistory('soul').length, 1, '首次初始化应保留可回滚快照');

  const initialSoul = readFile('soul');
  const savedSoul = saveFile('soul', '# 自定义人格\n', { expectedHash: initialSoul.hash });
  assert.strictEqual(savedSoul.content, '# 自定义人格\n');
  fs.rmSync(readPath('style'));
  initializeGlobalAgentFiles();
  assert.strictEqual(fs.readFileSync(readPath('soul'), 'utf8'), '# 自定义人格\n', '补建单个文件不能覆盖已有内容');
  assert.strictEqual(fs.readFileSync(readPath('style'), 'utf8'), DEFAULTS.style);

  assert.throws(
    () => saveFile('soul', '# 冲突\n', { expectedHash: initialSoul.hash }),
    (cause) => cause.code === 'AGENT_FILE_VERSION_CONFLICT'
  );
  assert.throws(
    () => saveFile('../soul', '# 非法\n', { expectedHash: savedSoul.hash }),
    (cause) => cause.code === 'AGENT_FILE_INVALID_TYPE'
  );
  assert.throws(
    () => saveFile('soul', '\0', { expectedHash: savedSoul.hash }),
    (cause) => cause.code === 'AGENT_FILE_BINARY'
  );
  assert.throws(
    () => saveFile('soul', 'a'.repeat(16 * 1024 + 1), { expectedHash: savedSoul.hash }),
    (cause) => cause.code === 'AGENT_FILE_TOO_LARGE'
  );

  const beforeExternal = listHistory('soul').length;
  fs.writeFileSync(readPath('soul'), '# 外部编辑\n', 'utf8');
  assert.strictEqual(readFile('soul').content, '# 外部编辑\n');
  const externalHistory = listHistory('soul').find((version) => version.source === 'external_edit');
  assert.ok(externalHistory, '磁盘外部编辑应使缓存失效并留下历史快照');
  assert.ok(listHistory('soul').length > beforeExternal);

  const external = readFile('soul');
  saveFile('soul', '# 第二版\n', { expectedHash: external.hash });
  const firstVersion = listHistory('soul').find((version) => version.hash === initialSoul.hash);
  assert.ok(firstVersion, '初始化内容应保留在历史中');
  rollbackHistory('soul', firstVersion.id, { expectedHash: readFile('soul').hash });
  assert.strictEqual(readFile('soul').content, DEFAULTS.soul);
  assert.strictEqual(fs.readdirSync(path.join(dataRoot, 'agent')).some((name) => name.includes('.tmp')), false, '原子保存不应留下临时文件');

  fs.writeFileSync(readPath('memory'), Buffer.from([0xff, 0xfe]));
  assert.throws(() => readFile('memory'), (cause) => cause.code === 'AGENT_FILE_ENCODING_INVALID');
  const degradedContext = buildGlobalAgentContext('解释当前 MCP 配置');
  assert.strictEqual(degradedContext.memory, '');
  assert.deepStrictEqual(degradedContext.errors, [{ file: 'memory', code: 'AGENT_FILE_ENCODING_INVALID' }]);
  fs.writeFileSync(readPath('memory'), DEFAULTS.memory, 'utf8');
  readFile('memory');

  const writing = buildGlobalAgentContext('请润色这篇文章');
  const ordinary = buildGlobalAgentContext('解释当前 MCP 配置');
  assert.ok(writing.style.includes('# 写作风格'));
  assert.strictEqual(ordinary.style, '');
  assert.ok(ordinary.soul.includes('# Agent 性格'));
  const prompt = buildLoopSystemPrompt({}, {
    globalAgentContext: writing,
    taskMaterialContext: '任务材料占位',
    skillCatalog: [{ id: 'test-skill', name: '测试 Skill', description: '测试', sourceLabel: 'test' }],
    mcpInstructions: [{ server: '测试 MCP', text: '测试' }],
  });
  assert.ok(prompt.indexOf('### soul.md') < prompt.indexOf('### memory.md'));
  assert.ok(prompt.indexOf('### memory.md') < prompt.indexOf('任务材料占位'));
  assert.ok(prompt.indexOf('任务材料占位') < prompt.indexOf('### style.md'));
  assert.ok(prompt.indexOf('### style.md') < prompt.indexOf('## 可用 Skill'));
  assert.ok(prompt.indexOf('## 可用 Skill') < prompt.indexOf('## MCP 工具说明'));
  assert.strictEqual(agentUpdateAllowed('memory', '请记住我偏好短句'), true);
  assert.strictEqual(agentUpdateAllowed('memory', '这次使用短句'), false);
  assert.strictEqual(agentUpdateAllowed('style', '以后写作都用短句'), true);
  assert.strictEqual(agentUpdateAllowed('soul', '这次回答更活泼'), false);

  const rememberSession = createSession({ goal: '请记住我偏好短句', authorizedPaths: [''] });
  const memoryBeforeUpdate = readFile('memory');
  const memoryUpdate = executeUpdateGlobalAgentFile({
    file: 'memory',
    content: `${memoryBeforeUpdate.content}\n- 用户偏好短句。\n`,
    expected_hash: memoryBeforeUpdate.hash,
  }, rememberSession.sessionId);
  assert.ok(!memoryUpdate.error, '明确记住时 Agent 应能更新全局记忆');
  assert.ok(buildToolDefinitions({}).some((tool) => tool.name === 'read_global_agent_file'));
  const temporarySession = createSession({ goal: '这次使用短句', authorizedPaths: [''] });
  const rejectedUpdate = executeUpdateGlobalAgentFile({
    file: 'memory', content: readFile('memory').content, expected_hash: readFile('memory').hash,
  }, temporarySession.sessionId);
  assert.strictEqual(rejectedUpdate.error, 'GLOBAL_AGENT_FILE_UPDATE_REQUIRES_EXPLICIT_USER_INTENT');

  const outsidePath = path.join(dataRoot, 'outside-memory.md');
  fs.writeFileSync(outsidePath, '# 不应读取\n', 'utf8');
  fs.rmSync(readPath('memory'));
  fs.symlinkSync(outsidePath, readPath('memory'));
  assert.throws(() => readFile('memory'), (cause) => cause.code === 'AGENT_FILE_UNSAFE_PATH');

  console.log('global agent file tests passed');
}

try {
  run();
} finally {
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
