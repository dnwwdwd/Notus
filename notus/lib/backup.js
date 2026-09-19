const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { getEffectiveConfig } = require('./config');
const { getDb } = require('./db');
const { getSkillMcpCapabilities } = require('./platform/capabilities');
const { inferRuntimeTarget } = require('./platform/target');
const { readSecret, saveSecret } = require('./secretStore');
const { listSkills, scanAllSkills } = require('./skills');
const {
  beginDataMaintenance,
  endDataMaintenance,
  stopRuntime,
  ensureRuntime,
} = require('./runtime');

const FORMAT = 'notus-backup';
const FORMAT_VERSION = 1;
const DATABASE_FORMAT_VERSION = 1;
const REQUIRED_COMPONENTS = [
  'database/index.db',
  'notes',
  'assets',
  'agent',
  'session',
  'skills/managed',
  'secrets/portable.json',
];
const ALLOWED_ROOTS = [
  'manifest.json',
  'database/',
  'notes/',
  'assets/',
  'agent/',
  'session/',
  'agent-tool-results/',
  'skills/managed/',
  'secrets/portable.json',
];
const MAX_ENTRIES = 200_000;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_SPACE_MARGIN_BYTES = 16 * 1024 * 1024;
const CONTROLLED_ERROR_CODES = new Set([
  'BACKUP_INVALID', 'BACKUP_VERSION_UNSUPPORTED', 'BACKUP_ACTIVE_TASKS', 'BACKUP_DISK_SPACE',
  'BACKUP_RESTORE_FAILED', 'BACKUP_SECRET_EXPORT_FAILED', 'BACKUP_SECRET_RESTORE_FAILED',
  'BACKUP_SOURCE_SYMLINK', 'BACKUP_SOURCE_SPECIAL_FILE', 'BACKUP_BUSY', 'DATA_MAINTENANCE_BUSY',
]);

const COMPONENT_ROOTS = new Set(ALLOWED_ROOTS.filter((item) => item.endsWith('/')).map((item) => item.slice(0, -1)));

function backupError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensureDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true });
}

async function walkFiles(root, relative = '') {
  const output = [];
  if (!fs.existsSync(root)) return output;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const absolute = path.join(root, entry.name);
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw backupError('备份源包含不支持的符号链接', 'BACKUP_SOURCE_SYMLINK');
    }
    if (stat.isDirectory()) {
      output.push(...await walkFiles(absolute, nextRelative));
    } else if (stat.isFile()) {
      output.push({ absolute, relative: nextRelative.replace(/\\/g, '/') });
    } else {
      throw backupError('备份源包含不支持的特殊文件', 'BACKUP_SOURCE_SPECIAL_FILE');
    }
  }
  return output;
}

async function copyTree(source, target) {
  await ensureDirectory(target);
  if (!fs.existsSync(source)) return;
  const files = await walkFiles(source);
  for (const file of files) {
    const relative = file.relative;
    const targetPath = path.join(target, relative);
    await ensureDirectory(path.dirname(targetPath));
    await fsp.copyFile(file.absolute, targetPath);
  }
}

function getManagedSkillRoot(config = getEffectiveConfig()) {
  const capabilities = getSkillMcpCapabilities(inferRuntimeTarget(), { dataRoot: config.dataRoot });
  return path.resolve(capabilities.skills.managedRoot);
}

function getBackupTargets(config = getEffectiveConfig()) {
  return {
    notes: path.resolve(config.notesDir),
    assets: path.resolve(config.assetsDir),
    agent: path.resolve(config.agentDir),
    session: path.resolve(config.sessionDir),
    toolResults: path.resolve(config.dataRoot, 'agent-tool-results'),
    database: path.resolve(config.dbPath),
    secrets: path.resolve(config.dataRoot, 'secrets'),
    managedSkills: getManagedSkillRoot(config),
  };
}

function getSecretIdsFromConfig(config = {}) {
  const ids = [];
  ['http', 'stdio'].forEach((transport) => {
    const values = Array.isArray(config?.[transport]?.headers)
      ? config[transport].headers
      : Array.isArray(config?.[transport]?.env) ? config[transport].env : [];
    values.forEach((item) => {
      const id = String(item?.secretId || '').trim();
      if (id) ids.push(id);
    });
  });
  return ids;
}

async function collectPortableSecrets() {
  const rows = getDb().prepare('SELECT config_json FROM mcp_servers').all();
  const ids = [...new Set(rows.flatMap((row) => {
    try { return getSecretIdsFromConfig(JSON.parse(row.config_json || '{}')); } catch { return []; }
  }))];
  const records = [];
  for (const id of ids) {
    let value;
    try {
      value = await readSecret(id);
    } catch (error) {
      throw backupError('MCP 密钥无法读取，备份导出已停止', 'BACKUP_SECRET_EXPORT_FAILED', 500);
    }
    records.push({ id, value: String(value || '') });
  }
  return records;
}

async function buildStage() {
  const config = getEffectiveConfig();
  const targets = getBackupTargets(config);
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'notus-backup-'));
  try {
    await Promise.all(REQUIRED_COMPONENTS.filter((item) => !item.endsWith('.json') && !item.endsWith('.db')).map((item) => ensureDirectory(path.join(stage, item))));
    await Promise.all([
      copyTree(targets.notes, path.join(stage, 'notes')),
      copyTree(targets.assets, path.join(stage, 'assets')),
      copyTree(targets.agent, path.join(stage, 'agent')),
      copyTree(targets.session, path.join(stage, 'session')),
      copyTree(targets.toolResults, path.join(stage, 'agent-tool-results')),
      copyTree(targets.managedSkills, path.join(stage, 'skills/managed')),
    ]);
    await ensureDirectory(path.join(stage, 'database'));
    await getDb().backup(path.join(stage, 'database/index.db'));
    await ensureDirectory(path.join(stage, 'secrets'));
    await fsp.writeFile(path.join(stage, 'secrets/portable.json'), JSON.stringify({ version: 1, records: await collectPortableSecrets() }, null, 2), 'utf8');
    return { stage, config, targets };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function buildManifest(stage) {
  const components = [];
  for (const component of [...REQUIRED_COMPONENTS, 'agent-tool-results']) {
    const root = component.endsWith('/') ? component.slice(0, -1) : component;
    const absolute = path.join(stage, root);
    if (component === 'secrets/portable.json' || component === 'database/index.db') {
      const stat = await fsp.stat(absolute);
      components.push({ path: root, bytes: stat.size, sha256: await sha256File(absolute) });
      continue;
    }
    const files = await walkFiles(absolute);
    for (const file of files) {
      const archivePath = path.posix.join(root, file.relative);
      const stat = await fsp.stat(file.absolute);
      components.push({ path: archivePath, bytes: stat.size, sha256: await sha256File(file.absolute) });
    }
  }
  return {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    created_at: new Date().toISOString(),
    app_version: require('../package.json').version,
    runtime_target: inferRuntimeTarget(),
    database_format_version: DATABASE_FORMAT_VERSION,
    components,
    excludes: ['logs', 'cache', 'browser_preferences', 'external_skill_roots'],
  };
}

function appendDirectory(archive, directory, archiveRoot) {
  if (fs.existsSync(directory)) archive.directory(directory, archiveRoot);
}

function appendComponentDirectory(archive, archiveRoot) {
  archive.append('', { name: `${archiveRoot}/` });
}

async function streamExport(res) {
  const { stage } = await buildStage();
  try {
    const manifest = await buildManifest(stage);
    await fsp.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="notus-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip"`);
    archive.pipe(res);
    archive.file(path.join(stage, 'manifest.json'), { name: 'manifest.json' });
    archive.file(path.join(stage, 'database/index.db'), { name: 'database/index.db' });
    ['notes', 'assets', 'agent', 'session', 'skills/managed', 'agent-tool-results'].forEach((root) => appendComponentDirectory(archive, root));
    appendDirectory(archive, path.join(stage, 'notes'), 'notes');
    appendDirectory(archive, path.join(stage, 'assets'), 'assets');
    appendDirectory(archive, path.join(stage, 'agent'), 'agent');
    appendDirectory(archive, path.join(stage, 'session'), 'session');
    appendDirectory(archive, path.join(stage, 'agent-tool-results'), 'agent-tool-results');
    appendDirectory(archive, path.join(stage, 'skills/managed'), 'skills/managed');
    archive.file(path.join(stage, 'secrets/portable.json'), { name: 'secrets/portable.json' });
    await new Promise((resolve, reject) => {
      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      archive.once('error', fail);
      res.once?.('error', fail);
      Promise.resolve(archive.finalize()).then(succeed, fail);
    });
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

function normalizedArchivePath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  const normalized = raw.replace(/\/+$/, '');
  if (!normalized || /[\0-\x1f]/.test(normalized) || normalized.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function allowedArchivePath(value) {
  if (value === 'database' || value === 'secrets') return false;
  if (value.startsWith('database/')) return value === 'database/index.db';
  if (value.startsWith('secrets/')) return value === 'secrets/portable.json';
  if (ALLOWED_ROOTS.includes(value)) return true;
  if (COMPONENT_ROOTS.has(value)) return true;
  return [...COMPONENT_ROOTS].some((root) => value.startsWith(`${root}/`));
}

function validateDatabaseFile(databasePath) {
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const quickCheck = database.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error('SQLite 完整性检查失败');
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    if (!tables.includes('schema_version') || !tables.includes('conversations') || !tables.includes('files')) {
      throw new Error('SQLite 数据库格式不受支持');
    }
    const userVersion = Number(database.pragma('user_version', { simple: true }) || 0);
    if (!Number.isSafeInteger(userVersion) || userVersion > DATABASE_FORMAT_VERSION) {
      throw backupError('SQLite 数据库版本不受支持', 'BACKUP_VERSION_UNSUPPORTED');
    }
  } catch (error) {
    if (error.code === 'BACKUP_VERSION_UNSUPPORTED') throw error;
    throw backupError('备份数据库格式无效', 'BACKUP_INVALID');
  } finally {
    try { database?.close(); } catch {}
  }
}

async function ensureListedFiles(stage, manifestPaths) {
  const actual = new Set(['database/index.db', 'secrets/portable.json'].filter((item) => fs.existsSync(path.join(stage, item))));
  for (const root of COMPONENT_ROOTS) {
    const files = await walkFiles(path.join(stage, root));
    files.forEach((file) => actual.add(path.posix.join(root, file.relative)));
  }
  for (const filePath of actual) {
    if (!manifestPaths.has(filePath)) throw backupError('备份包包含未列入清单的文件', 'BACKUP_INVALID');
  }
  for (const filePath of manifestPaths) {
    if (!actual.has(filePath)) throw backupError('备份包清单包含缺失文件', 'BACKUP_INVALID');
  }
}

async function readManifest(stage) {
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(path.join(stage, 'manifest.json'), 'utf8')); } catch { throw backupError('备份包缺少有效 manifest', 'BACKUP_INVALID'); }
  if (manifest?.format !== FORMAT || Number(manifest?.format_version) !== FORMAT_VERSION) throw backupError('备份包版本不受支持', 'BACKUP_VERSION_UNSUPPORTED');
  if (Number(manifest?.database_format_version || 0) !== DATABASE_FORMAT_VERSION) throw backupError('备份数据库版本不受支持', 'BACKUP_VERSION_UNSUPPORTED');
  if (!Array.isArray(manifest.components)) throw backupError('备份包清单无效', 'BACKUP_INVALID');
  const componentMap = new Map();
  for (const item of manifest.components) {
    const relative = normalizedArchivePath(item.path);
    if (!relative || componentMap.has(relative)) throw backupError('备份清单包含重复路径', 'BACKUP_INVALID');
    componentMap.set(relative, item);
  }
  if (!componentMap.has('database/index.db') || !componentMap.has('secrets/portable.json')) throw backupError('备份包缺少核心数据', 'BACKUP_INVALID');
  for (const [relative, component] of componentMap) {
    if (!relative || !allowedArchivePath(relative)) throw backupError('备份包包含越界路径', 'BACKUP_INVALID');
    const target = path.join(stage, relative);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw backupError('备份包组件缺失', 'BACKUP_INVALID');
    const stat = await fsp.stat(target);
    if (Number(component.bytes) !== stat.size || String(component.sha256) !== await sha256File(target)) throw backupError('备份包校验失败', 'BACKUP_INVALID');
  }
  await ensureListedFiles(stage, new Set(componentMap.keys()));
  validateDatabaseFile(path.join(stage, 'database/index.db'));
  return manifest;
}

function getFreeBytes(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function assertDiskSpace(requiredBytes, targets = []) {
  const checks = [os.tmpdir(), ...targets.map((item) => path.dirname(item))];
  const required = Math.max(0, Number(requiredBytes) || 0) + DISK_SPACE_MARGIN_BYTES;
  for (const directory of checks) {
    const available = getFreeBytes(directory);
    if (available !== null && available < required) throw backupError('磁盘空间不足，无法安全还原备份', 'BACKUP_DISK_SPACE', 507);
  }
}

async function validateZip(zipPath, stage) {
  let uploadStat;
  try { uploadStat = await fsp.stat(zipPath); } catch { throw backupError('备份上传文件不可用', 'BACKUP_INVALID'); }
  if (!uploadStat.isFile() || uploadStat.size > MAX_UPLOAD_BYTES) throw backupError('备份 ZIP 超过大小限制', 'BACKUP_INVALID');
  let directory;
  try { directory = await unzipper.Open.file(zipPath); } catch { throw backupError('无法读取备份 ZIP', 'BACKUP_INVALID'); }
  if (directory.files.length > MAX_ENTRIES) throw backupError('备份包文件数量超限', 'BACKUP_INVALID');
  let uncompressed = 0;
  const seen = new Set();
  for (const entry of directory.files) {
    const relative = normalizedArchivePath(entry.path);
    if (!relative || !allowedArchivePath(relative)) throw backupError('备份包包含越界路径', 'BACKUP_INVALID');
    if (seen.has(relative)) throw backupError('备份包包含重复路径', 'BACKUP_INVALID');
    seen.add(relative);
    if (entry.type && !['File', 'Directory'].includes(entry.type)) throw backupError('备份包包含不支持的链接或特殊文件', 'BACKUP_INVALID');
    const unixMode = (Number(entry.externalFileAttributes || 0) >>> 16) & 0xffff;
    const unixType = unixMode & 0xf000;
    if (unixType && ![0x4000, 0x8000].includes(unixType)) throw backupError('备份包包含不支持的链接或特殊文件', 'BACKUP_INVALID');
    const uncompressedSize = Number(entry.uncompressedSize ?? entry.vars?.uncompressedSize ?? 0);
    const compressedSize = Number(entry.compressedSize ?? entry.vars?.compressedSize ?? 0);
    if (!Number.isSafeInteger(uncompressedSize) || !Number.isSafeInteger(compressedSize)) throw backupError('备份包大小字段无效', 'BACKUP_INVALID');
    if (entry.type === 'File' && compressedSize > 0 && uncompressedSize / compressedSize > 10_000) throw backupError('备份包压缩比例异常', 'BACKUP_INVALID');
    uncompressed += uncompressedSize;
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw backupError('备份包解压体积超限', 'BACKUP_INVALID');
  }
  const config = getEffectiveConfig();
  assertDiskSpace(uncompressed, [config.notesDir, config.assetsDir, config.agentDir, config.sessionDir, config.dbPath, getManagedSkillRoot(config), path.join(config.dataRoot, 'secrets')]);
  await directory.extract({ path: stage });
  return readManifest(stage);
}

function findActiveTasks() {
  const db = getDb();
  const statuses = ['created', 'queued', 'running', 'queued_resume'];
  const placeholders = statuses.map(() => '?').join(',');
  const activeWhere = `(status IN (${placeholders}) OR status LIKE 'waiting_%')`;
  const sessions = db.prepare(`SELECT id, status FROM agent_sessions WHERE ${activeWhere}`).all(...statuses);
  const tasks = db.prepare(`SELECT id, status FROM agent_task_queue WHERE ${activeWhere}`).all(...statuses);
  return { sessions, tasks };
}

async function swapPath(source, target, rollbackRoot, journal) {
  await ensureDirectory(path.dirname(target));
  const backupPath = path.join(rollbackRoot, String(journal.length));
  const existed = fs.existsSync(target);
  if (existed) {
    await ensureDirectory(path.dirname(backupPath));
    await movePath(target, backupPath);
  }
  journal.push({ target, backupPath, existed });
  if (fs.existsSync(source)) {
    const stat = await fsp.lstat(source);
    if (stat.isDirectory()) await copyTree(source, target);
    else await fsp.copyFile(source, target);
  } else if (target.endsWith(path.sep) || !path.extname(target)) {
    await ensureDirectory(target);
  }
}

async function movePath(source, target) {
  try {
    await fsp.rename(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const stat = await fsp.lstat(source);
    if (stat.isDirectory()) await copyTree(source, target);
    else if (stat.isFile()) {
      await ensureDirectory(path.dirname(target));
      await fsp.copyFile(source, target);
    } else throw backupError('备份路径包含不支持的文件类型', 'BACKUP_INVALID');
    await fsp.rm(source, { recursive: true, force: true });
  }
}

async function swapDatabase(source, target, rollbackRoot, journal) {
  await swapPath(source, target, rollbackRoot, journal);
  // SQLite WAL/SHM/rollback journal 可能在关闭连接后仍留在目标目录。
  // 这些旁车文件属于旧数据库状态，必须一起移入回滚目录，否则新库打开时
  // 可能把旧 WAL 中的行重新合并回来，破坏“完全覆盖”语义。
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await swapPath('', `${target}${suffix}`, rollbackRoot, journal);
  }
}

async function rollbackSwaps(journal) {
  const errors = [];
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const item = journal[index];
    await fsp.rm(item.target, { recursive: true, force: true }).catch(() => {});
    if (item.existed && fs.existsSync(item.backupPath)) {
      try { await movePath(item.backupPath, item.target); } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw errors[0];
}

async function restorePortableSecrets(stage) {
  let payload;
  try { payload = JSON.parse(await fsp.readFile(path.join(stage, 'secrets/portable.json'), 'utf8')); } catch { throw backupError('MCP 密钥记录无效', 'BACKUP_INVALID'); }
  if (Number(payload?.version || 0) !== 1 || !Array.isArray(payload?.records)) throw backupError('MCP 密钥记录版本无效', 'BACKUP_VERSION_UNSUPPORTED');
  const records = new Map();
  payload.records.forEach((item) => {
    const id = String(item?.id || '').trim();
    if (!id || records.has(id) || typeof item?.value !== 'string') throw backupError('MCP 密钥记录无效', 'BACKUP_INVALID');
    records.set(id, item.value);
  });
  const mapping = new Map();
  const db = getDb();
  const rows = db.prepare('SELECT id, config_json FROM mcp_servers').all();
  for (const row of rows) {
    let config;
    try { config = JSON.parse(row.config_json || '{}'); } catch { continue; }
    let changed = false;
    for (const transport of ['http', 'stdio']) {
      const key = transport === 'http' ? 'headers' : 'env';
      if (!Array.isArray(config?.[transport]?.[key])) continue;
      for (const item of config[transport][key]) {
        const sourceId = String(item?.secretId || '');
        if (!sourceId) continue;
        let targetId = mapping.get(sourceId);
        if (!targetId) {
          const value = records.get(sourceId);
          if (!value) throw backupError('备份中缺少 MCP 密钥', 'BACKUP_SECRET_RESTORE_FAILED', 500);
          targetId = await saveSecret(value);
          mapping.set(sourceId, targetId);
        }
        item.secretId = targetId;
        item.value = '';
        item.secret = true;
        changed = true;
      }
    }
    if (changed) db.prepare('UPDATE mcp_servers SET config_json = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(config), row.id);
  }
}

function remapSkillPaths({ databasePath = '', config = getEffectiveConfig() } = {}) {
  const targets = getBackupTargets(config);
  const database = databasePath ? new Database(databasePath) : getDb();
  try {
    const roots = database.prepare('SELECT * FROM skill_roots').all();
    roots.forEach((root) => {
      let nextPath = root.path;
      if (root.managed_by_notus || root.scope === 'managed') nextPath = targets.managedSkills;
      else if (root.scope === 'workspace') {
        const name = String(root.path || '').includes('.claude') ? '.claude' : String(root.path || '').includes('.opencode') ? '.opencode' : '.agents';
        nextPath = path.join(targets.notes, name, 'skills');
      }
      const realPath = fs.existsSync(nextPath) ? fs.realpathSync(nextPath) : null;
      database.prepare('UPDATE skill_roots SET path = ?, real_path = ? WHERE id = ?').run(nextPath, realPath, root.id);
      database.prepare('UPDATE skills SET real_path = CASE WHEN ? IS NULL THEN NULL ELSE ? || directory_path END, skill_md_path = ? || directory_path || \'/SKILL.md\' WHERE root_id = ?').run(
        realPath,
        realPath ? `${realPath}${path.sep}` : null,
        `${nextPath}${path.sep}`,
        root.id,
      );
    });
  } finally {
    if (databasePath) database.close();
  }
}

function rewriteRestoredPathSettings(databasePath, config) {
  let database;
  try {
    database = new Database(databasePath);
    database.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('notes_dir', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(config.notesDir);
    database.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('assets_dir', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(config.assetsDir);
  } finally {
    try { database?.close(); } catch {}
  }
}

async function restoreFromZip(zipPath) {
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'notus-restore-'));
  const rollbackRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'notus-rollback-'));
  const journal = [];
  let maintenance = false;
  let runtimeStopped = false;
  let preserveRollback = false;
  try {
    await validateZip(zipPath, stage);
    beginDataMaintenance('restore');
    maintenance = true;
    const active = findActiveTasks();
    if (active.sessions.length || active.tasks.length) throw backupError('当前存在未结束的 Agent 任务，请等待任务完成后再还原', 'BACKUP_ACTIVE_TASKS', 409);
    const config = getEffectiveConfig();
    const targets = getBackupTargets(config);
    runtimeStopped = true;
    await stopRuntime();
    await swapPath(path.join(stage, 'notes'), targets.notes, rollbackRoot, journal);
    await swapPath(path.join(stage, 'assets'), targets.assets, rollbackRoot, journal);
    await swapPath(path.join(stage, 'agent'), targets.agent, rollbackRoot, journal);
    await swapPath(path.join(stage, 'session'), targets.session, rollbackRoot, journal);
    await swapPath(path.join(stage, 'agent-tool-results'), targets.toolResults, rollbackRoot, journal);
    await swapDatabase(path.join(stage, 'database/index.db'), targets.database, rollbackRoot, journal);
    await swapPath(path.join(stage, 'skills/managed'), targets.managedSkills, rollbackRoot, journal);
    await swapPath(path.join(stage, 'secrets'), targets.secrets, rollbackRoot, journal);
    rewriteRestoredPathSettings(targets.database, config);
    remapSkillPaths({ databasePath: targets.database, config });
    const restarted = ensureRuntime({ allowMaintenance: true });
    if (!restarted.ok) throw backupError('恢复后运行时初始化失败', 'BACKUP_RESTORE_FAILED', 500);
    await restorePortableSecrets(stage);
    scanAllSkills();
    const db = getDb();
    const summary = {
      notes: db.prepare('SELECT COUNT(*) AS count FROM files').get()?.count || 0,
      conversations: db.prepare('SELECT COUNT(*) AS count FROM conversations').get()?.count || 0,
      skills: listSkills().length,
      mcp_servers: db.prepare('SELECT COUNT(*) AS count FROM mcp_servers').get()?.count || 0,
      mcp_tokens: db.prepare('SELECT COUNT(*) AS count FROM external_mcp_tokens').get()?.count || 0,
    };
    endDataMaintenance();
    maintenance = false;
    await fsp.rm(rollbackRoot, { recursive: true, force: true }).catch(() => {});
    return { ok: true, requires_reload: true, summary };
  } catch (error) {
    if (maintenance && runtimeStopped) {
      await stopRuntime().catch(() => {});
      let rollbackError = null;
      try { await rollbackSwaps(journal); } catch (cause) { rollbackError = cause; }
      preserveRollback = Boolean(rollbackError);
      if (rollbackError) await fsp.writeFile(path.join(rollbackRoot, 'recovery.json'), JSON.stringify({ journal }, null, 2)).catch(() => {});
      const restarted = rollbackError ? { ok: false } : ensureRuntime({ allowMaintenance: true });
      if (rollbackError) error = backupError('备份还原失败，旧数据回滚未完成', 'BACKUP_RESTORE_FAILED', 500);
      else if (!restarted.ok) error = backupError('备份还原失败，旧数据已恢复但运行时未能重新启动', 'BACKUP_RESTORE_FAILED', 500);
      endDataMaintenance();
    }
    throw error?.code && CONTROLLED_ERROR_CODES.has(error.code)
      ? error
      : backupError('备份还原失败，旧数据已恢复', 'BACKUP_RESTORE_FAILED', 500);
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (!preserveRollback) await fsp.rm(rollbackRoot, { recursive: true, force: true }).catch(() => {});
    if (maintenance) endDataMaintenance();
  }
}

function getLimits() {
  return { maxUploadBytes: MAX_UPLOAD_BYTES, maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES, maxEntries: MAX_ENTRIES };
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  MAX_UPLOAD_BYTES,
  getBackupTargets,
  getLimits,
  findActiveTasks,
  streamExport,
  restoreFromZip,
  validateZip,
  readManifest,
  buildManifest,
  normalizedArchivePath,
  allowedArchivePath,
  validateDatabaseFile,
  rewriteRestoredPathSettings,
  remapSkillPaths,
};
