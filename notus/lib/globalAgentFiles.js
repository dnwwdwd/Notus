const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getEffectiveConfig } = require('./config');
const { setSettings } = require('./db');
const { createLogger } = require('./logger');
const { estimateTextTokens, trimTextToTokenBudget } = require('./llmBudget');

const logger = createLogger({ subsystem: 'global_agent_files' });
const FILE_TYPES = ['soul', 'style', 'memory'];
const HISTORY_LIMIT = 50;
const FILE_LIMITS = {
  soul: { recommendedChars: 2000, maxBytes: 16 * 1024, promptTokens: 2400 },
  style: { recommendedChars: 4000, maxBytes: 32 * 1024, promptTokens: 3200 },
  memory: { recommendedChars: 12000, maxBytes: 128 * 1024, promptTokens: 4800 },
};
const TEMPLATE_VERSION = '1';
const DEFAULTS = {
  soul: `# Agent 性格\n\n你是 Notus 内置的知识与写作 Agent。\n\n保持直接、冷静和具体。发现方案存在明显问题时直接指出，不为了迎合用户省略风险。\n\n无法确认的信息要明确说明，不根据模糊上下文补造事实。\n\n尊重用户的原始判断和表达习惯。涉及删除、覆盖、发布等高风险操作时，确认用户意图。\n`,
  style: `# 写作风格\n\n保留事实、数字、产品名、模型名、日期和工程细节。\n\n作者亲自做过的事情使用第一人称和完成时，例如“我测了”“我保留了”“我删掉了”。\n\n减少讲义式结构、空洞总结和过度完整的段落。优先保留具体测试、成本和工程细节。\n\n不要添加原文没有的例子、数据和个人经历。\n`,
  memory: `# 全局记忆\n\n## 用户偏好\n\n## 常用技术栈\n\n## 长期项目\n\n## 已确认决策\n\n## 重要经验\n`,
};

const cache = new Map();
let watcher = null;
let chokidarPromise = null;

function error(message, code) {
  return Object.assign(new Error(message), { code });
}

function assertFileType(fileType) {
  const type = String(fileType || '').trim().toLowerCase();
  if (!FILE_TYPES.includes(type)) throw error('全局 Agent 文件类型无效', 'AGENT_FILE_INVALID_TYPE');
  return type;
}

function pathsFor(fileType) {
  const type = assertFileType(fileType);
  const config = getEffectiveConfig();
  const agentDir = path.resolve(config.agentDir);
  const historyRoot = path.resolve(agentDir, 'history');
  const filePath = path.resolve(agentDir, `${type}.md`);
  const historyDir = path.resolve(historyRoot, type);
  if (!filePath.startsWith(`${agentDir}${path.sep}`) || !historyDir.startsWith(`${historyRoot}${path.sep}`)) {
    throw error('全局 Agent 文件路径无效', 'AGENT_FILE_PATH_INVALID');
  }
  return { type, agentDir, historyRoot, filePath, historyDir };
}

function assertDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('全局 Agent 目录不可用', 'AGENT_FILE_UNSAFE_PATH');
  return fs.realpathSync(directory);
}

function ensureDirectories(fileType) {
  const locations = pathsFor(fileType);
  assertDirectory(locations.agentDir);
  assertDirectory(locations.historyRoot);
  assertDirectory(locations.historyDir);
  return locations;
}

function assertRegularFile(filePath, allowMissing = true) {
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return null;
    throw error('全局 Agent 文件不存在', 'AGENT_FILE_NOT_FOUND');
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw error('全局 Agent 文件路径不安全', 'AGENT_FILE_UNSAFE_PATH');
  return stat;
}

function decodeUtf8(buffer) {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (value.includes('\0')) throw error('文件包含二进制内容', 'AGENT_FILE_BINARY');
    return value;
  } catch (cause) {
    if (String(cause?.code || '').startsWith('AGENT_FILE_')) throw cause;
    throw error('文件不是有效的 UTF-8 文本', 'AGENT_FILE_ENCODING_INVALID');
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function validateContent(fileType, content, { allowEmpty = false } = {}) {
  const type = assertFileType(fileType);
  const value = String(content ?? '').replace(/\r\n/g, '\n');
  if (value.includes('\0')) throw error('内容不能包含二进制字符', 'AGENT_FILE_BINARY');
  if (!allowEmpty && !value.trim()) throw error('内容为空，请恢复基础标题或确认清空操作', 'AGENT_FILE_EMPTY');
  if (Buffer.byteLength(value, 'utf8') > FILE_LIMITS[type].maxBytes) throw error('文件超过大小上限', 'AGENT_FILE_TOO_LARGE');
  return value;
}

function atomicWrite(filePath, content) {
  assertRegularFile(filePath, true);
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temp, filePath);
  } catch (cause) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    throw cause;
  }
}

function snapshot(fileType, content, source, metadata = {}) {
  const { historyDir } = ensureDirectories(fileType);
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const hash = sha256(content);
  const markdownPath = path.join(historyDir, `${id}.md`);
  const metaPath = path.join(historyDir, `${id}.json`);
  atomicWrite(markdownPath, content);
  atomicWrite(metaPath, JSON.stringify({
    id,
    file_type: fileType,
    source,
    hash,
    created_at: new Date().toISOString(),
    ...metadata,
  }, null, 2));
  pruneHistory(historyDir);
  return { id, hash };
}

function pruneHistory(historyDir) {
  const entries = fs.readdirSync(historyDir)
    .filter((name) => /^[0-9]+-[0-9a-f-]+\.json$/i.test(name))
    .sort();
  entries.slice(0, Math.max(0, entries.length - HISTORY_LIMIT)).forEach((name) => {
    const base = name.replace(/\.json$/i, '');
    [path.join(historyDir, `${base}.json`), path.join(historyDir, `${base}.md`)].forEach((target) => {
      try { assertRegularFile(target, false); fs.unlinkSync(target); } catch {}
    });
  });
}

function readFresh(fileType, { recordExternal = true } = {}) {
  const locations = ensureDirectories(fileType);
  const stat = assertRegularFile(locations.filePath, false);
  const buffer = fs.readFileSync(locations.filePath);
  const content = decodeUtf8(buffer);
  validateContent(fileType, content, { allowEmpty: true });
  const record = {
    content,
    hash: sha256(content),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
  const key = locations.filePath;
  const previous = cache.get(key);
  if (recordExternal && previous && previous.hash !== record.hash) {
    snapshot(fileType, content, 'external_edit');
    logger.info('agent_files.external_change', { file_type: fileType, hash: record.hash });
  }
  cache.set(key, record);
  return record;
}

function readFile(fileType) {
  const type = assertFileType(fileType);
  let locations = ensureDirectories(type);
  if (!fs.existsSync(locations.filePath)) {
    return initializeFile(type);
  }
  assertRegularFile(locations.filePath, false);
  const cached = cache.get(locations.filePath);
  const stat = assertRegularFile(locations.filePath, false);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  return readFresh(type);
}

function statusFor(fileType) {
  const type = assertFileType(fileType);
  try {
    const record = readFile(type);
    return {
      file: type,
      filename: `${type}.md`,
      hash: record.hash,
      updated_at: record.updatedAt,
      char_count: record.content.length,
      byte_size: Buffer.byteLength(record.content, 'utf8'),
      recommended_chars: FILE_LIMITS[type].recommendedChars,
      max_bytes: FILE_LIMITS[type].maxBytes,
      over_recommended: record.content.length > FILE_LIMITS[type].recommendedChars,
      initialized: true,
      error: null,
    };
  } catch (cause) {
    return { file: type, filename: `${type}.md`, initialized: false, error: cause.code || 'AGENT_FILE_READ_FAILED' };
  }
}

function initializeFile(fileType) {
  const type = assertFileType(fileType);
  const locations = ensureDirectories(type);
  if (!fs.existsSync(locations.filePath)) {
    const content = DEFAULTS[type];
    atomicWrite(locations.filePath, content);
    snapshot(type, content, 'system_init', { template_version: TEMPLATE_VERSION });
    setSettings({ [`agent_file_template_${type}_version`]: TEMPLATE_VERSION });
    logger.info('agent_files.initialized', { file_type: type, hash: sha256(content) });
  }
  assertRegularFile(locations.filePath, false);
  return readFresh(type, { recordExternal: false });
}

function initializeGlobalAgentFiles() {
  return FILE_TYPES.map((fileType) => statusFor(fileType));
}

function withLock(fileType, action) {
  const { agentDir } = ensureDirectories(fileType);
  const lockPath = path.join(agentDir, '.global-agent-files.lock');
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch {
    throw error('文件正在被其他操作修改，请稍后重试', 'AGENT_FILE_WRITE_CONFLICT');
  }
  try { return action(); } finally {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function saveFile(fileType, content, { expectedHash, source = 'user_settings', allowEmpty = false, metadata = {} } = {}) {
  const type = assertFileType(fileType);
  const next = validateContent(type, content, { allowEmpty });
  return withLock(type, () => {
    const current = readFile(type);
    if (!expectedHash || expectedHash !== current.hash) {
      throw error('文件已被其他操作修改，请重新载入后再保存', 'AGENT_FILE_VERSION_CONFLICT');
    }
    const { filePath } = ensureDirectories(type);
    atomicWrite(filePath, next);
    const record = readFresh(type, { recordExternal: false });
    const version = snapshot(type, next, source, metadata);
    logger.info('agent_files.saved', { file_type: type, source, hash: record.hash });
    return { ...statusFor(type), version_id: version.id, content: record.content };
  });
}

function restoreDefault(fileType, options = {}) {
  const type = assertFileType(fileType);
  return saveFile(type, DEFAULTS[type], { ...options, source: 'restore_default' });
}

function listHistory(fileType) {
  const type = assertFileType(fileType);
  const { historyDir } = ensureDirectories(type);
  return fs.readdirSync(historyDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        const metaPath = path.join(historyDir, name);
        assertRegularFile(metaPath, false);
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch { return null; }
    })
    .filter((item) => item && item.file_type === type)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
}

function getHistoryVersion(fileType, versionId) {
  const type = assertFileType(fileType);
  const id = String(versionId || '').trim();
  if (!/^[0-9]+-[0-9a-f-]+$/i.test(id)) throw error('历史版本标识无效', 'AGENT_FILE_HISTORY_INVALID');
  const { historyDir } = ensureDirectories(type);
  const markdownPath = path.join(historyDir, `${id}.md`);
  const metaPath = path.join(historyDir, `${id}.json`);
  assertRegularFile(markdownPath, false);
  assertRegularFile(metaPath, false);
  const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (metadata.file_type !== type) throw error('历史版本不属于该文件', 'AGENT_FILE_HISTORY_INVALID');
  return { ...metadata, content: decodeUtf8(fs.readFileSync(markdownPath)) };
}

function rollbackHistory(fileType, versionId, options = {}) {
  const version = getHistoryVersion(fileType, versionId);
  return saveFile(fileType, version.content, { ...options, source: 'rollback', metadata: { restored_version_id: version.id } });
}

function splitSections(content = '') {
  const lines = String(content || '').split('\n');
  const sections = [];
  let current = { heading: '', content: [] };
  lines.forEach((line) => {
    if (/^##\s+/.test(line)) {
      if (current.heading || current.content.length) sections.push(current);
      current = { heading: line.replace(/^##\s+/, '').trim(), content: [line] };
    } else current.content.push(line);
  });
  if (current.heading || current.content.length) sections.push(current);
  return sections;
}

function selectMemory(content, query, budget) {
  if (estimateTextTokens(content) <= budget) return content;
  const queryTerms = String(query || '').toLowerCase().split(/[\s，。；、,.!?！？]+/).filter((item) => item.length >= 2);
  const scored = splitSections(content).map((section, index) => {
    const text = section.content.join('\n');
    const haystack = `${section.heading}\n${text}`.toLowerCase();
    const stable = /用户偏好|长期项目|已确认决策|重要经验|常用技术栈/.test(section.heading) ? 2 : 0;
    const matched = queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 3 : 0), 0);
    return { text, score: stable + matched, index };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = [];
  let used = 0;
  for (const section of scored) {
    const tokens = estimateTextTokens(section.text);
    if (used + tokens > budget && selected.length > 0) continue;
    selected.push(section.text);
    used += tokens;
    if (used >= budget) break;
  }
  return trimTextToTokenBudget(selected.join('\n\n') || content, budget, '\n[全局记忆已按上下文预算选择章节]');
}

function isWritingTask(goal = '') {
  return /(创作|写作|改写|润色|续写|翻译|调整语气|整理成(?:文章|文档|公开文本)|生成(?:文章|文档|邮件|稿件)|写(?:一篇|文章|文档|邮件|报告|稿))/i.test(String(goal || ''));
}

function readPromptFile(fileType, errors) {
  try {
    return readFile(fileType).content;
  } catch (cause) {
    const code = cause?.code || 'AGENT_FILE_READ_FAILED';
    errors.push({ file: fileType, code });
    logger.warn('agent_files.prompt_load_failed', { file_type: fileType, code, error: cause });
    return '';
  }
}

function buildGlobalAgentContext(goal = '', options = {}) {
  const errors = [];
  const soul = readPromptFile('soul', errors);
  const memory = readPromptFile('memory', errors);
  const writing = options.writing === undefined ? isWritingTask(goal) : Boolean(options.writing);
  const output = {
    soul: trimTextToTokenBudget(soul, FILE_LIMITS.soul.promptTokens),
    memory: selectMemory(memory, goal, FILE_LIMITS.memory.promptTokens),
    style: '',
    writing,
    errors,
  };
  if (writing) output.style = trimTextToTokenBudget(readPromptFile('style', errors), FILE_LIMITS.style.promptTokens);
  return output;
}

function agentUpdateAllowed(fileType, goal = '') {
  const text = String(goal || '').toLowerCase();
  if (fileType === 'memory') return /(记住|记下|写入记忆|加入记忆|保存到记忆)/.test(text);
  if (fileType === 'style') return /(以后|长期|今后).{0,16}(写法|写作|风格|语气|格式)|(?:写作风格|风格).{0,16}(修改|更新|调整|改成)/.test(text);
  return /(修改|更新|调整).{0,12}(人格|性格|soul)|(?:人格|性格).{0,12}(修改|更新|调整)/.test(text);
}

async function startGlobalAgentFileWatcher() {
  const config = getEffectiveConfig();
  if (config.runtimeTarget !== 'electron' || watcher) return watcher;
  initializeGlobalAgentFiles();
  if (!chokidarPromise) chokidarPromise = import('chokidar').then((module) => module.default || module);
  const chokidar = await chokidarPromise;
  watcher = chokidar.watch(FILE_TYPES.map((type) => path.join(config.agentDir, `${type}.md`)), {
    persistent: true,
    usePolling: true,
    interval: 3000,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 500 },
  });
  watcher.on('change', (filePath) => {
    const type = path.basename(filePath, '.md');
    if (!FILE_TYPES.includes(type)) return;
    try { readFresh(type); } catch (cause) { logger.warn('agent_files.external_reload_failed', { file_type: type, error: cause }); }
  }).on('error', (cause) => logger.warn('agent_files.watcher_failed', { error: cause }));
  return watcher;
}

module.exports = {
  FILE_TYPES,
  FILE_LIMITS,
  DEFAULTS,
  initializeGlobalAgentFiles,
  readFile,
  statusFor,
  saveFile,
  restoreDefault,
  listHistory,
  getHistoryVersion,
  rollbackHistory,
  buildGlobalAgentContext,
  isWritingTask,
  agentUpdateAllowed,
  startGlobalAgentFileWatcher,
};
