const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const unzipper = require('unzipper');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { inferRuntimeTarget } = require('./platform/target');
const { getSkillMcpCapabilities } = require('./platform/capabilities');
const { readSecret, saveSecret } = require('./secretStore');

const OWNER_ID = 'local-user';
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 512 * 1024 * 1024;
const MAX_SKILL_FILES = 20000;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let watchersStarted = false;
let chokidarModulePromise = null;
const watchers = new Map();

function now() { return new Date().toISOString(); }
function parseJson(value, fallback) { try { return JSON.parse(value || ''); } catch { return fallback; } }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function getCapabilities() {
  const config = getEffectiveConfig();
  return getSkillMcpCapabilities(inferRuntimeTarget(), { dataRoot: config.dataRoot });
}
function sourceLabel(root) {
  if (root.scope === 'managed') return 'Notus 管理';
  if (root.scope === 'workspace') return '当前工作区';
  return (root.providers || []).join(' / ') || '外部 Skill';
}
function skillRoots() {
  const config = getEffectiveConfig();
  const runtime = inferRuntimeTarget();
  const caps = getCapabilities();
  const managed = caps.skills.managedRoot;
  if (runtime !== 'electron') {
    return [{ id: sha256(managed), path: managed, scope: 'managed', providers: ['notus'], writable: true, managedByNotus: true, watch: true, priority: 100 }];
  }
  const home = os.homedir();
  const candidates = [
    { path: managed, scope: 'managed', providers: ['notus', 'codex', 'opencode'], writable: true, managedByNotus: true, priority: 100 },
    { path: path.join(home, '.claude', 'skills'), scope: 'user', providers: ['claude-code', 'opencode'], writable: false, managedByNotus: false, priority: 80 },
    { path: path.join(home, '.config', 'opencode', 'skills'), scope: 'user', providers: ['opencode'], writable: false, managedByNotus: false, priority: 70 },
    { path: path.join(home, '.codex', 'skills'), scope: 'user', providers: ['codex'], writable: false, managedByNotus: false, priority: 75 },
    { path: '/etc/codex/skills', scope: 'admin', providers: ['codex'], writable: false, managedByNotus: false, priority: 40 },
    { path: path.join(config.notesDir, '.agents', 'skills'), scope: 'workspace', providers: ['codex'], writable: false, managedByNotus: false, priority: 90 },
    { path: path.join(config.notesDir, '.claude', 'skills'), scope: 'workspace', providers: ['claude-code'], writable: false, managedByNotus: false, priority: 90 },
    { path: path.join(config.notesDir, '.opencode', 'skills'), scope: 'workspace', providers: ['opencode'], writable: false, managedByNotus: false, priority: 90 },
  ];
  const seen = new Set();
  return candidates.filter((item) => {
    const normalized = path.resolve(item.path);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return item.managedByNotus || fs.existsSync(normalized);
  }).map((item) => ({ ...item, id: sha256(path.resolve(item.path)), path: path.resolve(item.path), watch: true }));
}
function ensureRootRecords() {
  const db = getDb();
  const roots = skillRoots();
  const statement = db.prepare(`INSERT INTO skill_roots (id,path,real_path,scope,providers_json,writable,managed_by_notus,watch_enabled,priority,last_scan_at,last_error)
    VALUES (@id,@path,@real_path,@scope,@providers_json,@writable,@managed_by_notus,@watch_enabled,@priority,NULL,NULL)
    ON CONFLICT(path) DO UPDATE SET scope=excluded.scope,providers_json=excluded.providers_json,writable=excluded.writable,managed_by_notus=excluded.managed_by_notus,watch_enabled=excluded.watch_enabled,priority=excluded.priority`);
  roots.forEach((root) => {
    if (root.managedByNotus) fs.mkdirSync(root.path, { recursive: true, mode: 0o700 });
    let realPath = null; try { realPath = fs.realpathSync(root.path); } catch {}
    statement.run({ ...root, real_path: realPath, providers_json: JSON.stringify(root.providers), writable: root.writable ? 1 : 0, managed_by_notus: root.managedByNotus ? 1 : 0, watch_enabled: root.watch ? 1 : 0 });
  });
  return roots;
}
function walkSkill(dir, rootReal) {
  const files = [];
  let total = 0;
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.forEach((entry) => {
      if (['.git', 'node_modules', '.staging', '.DS_Store'].includes(entry.name) || entry.name.endsWith('~') || entry.name.endsWith('.swp')) return;
      const next = path.join(current, entry.name);
      const stat = fs.lstatSync(next);
      if (stat.isSymbolicLink()) throw Object.assign(new Error('Skill 包含越界符号链接'), { code: 'SKILL_PATH_OUTSIDE_ROOT' });
      if (stat.isDirectory()) return visit(next);
      if (!stat.isFile()) return;
      total += stat.size;
      files.push(next);
      if (files.length > MAX_SKILL_FILES || total > MAX_SKILL_BYTES) throw Object.assign(new Error('Skill 文件数量或体积超限'), { code: 'SKILL_TOO_LARGE' });
    });
  };
  const real = fs.realpathSync(dir);
  if (!real.startsWith(`${rootReal}${path.sep}`) && real !== rootReal) throw Object.assign(new Error('Skill 目录超出 Root'), { code: 'SKILL_PATH_OUTSIDE_ROOT' });
  visit(dir);
  return { files, total };
}
function inspectSkill(root, directory) {
  const errors = [];
  const skillMd = path.join(directory, 'SKILL.md');
  let frontmatter = {};
  let body = '';
  let files = [];
  let contentHash = '';
  try {
    const rootReal = fs.realpathSync(root.path);
    const stat = fs.statSync(skillMd);
    if (!stat.isFile() || stat.size > MAX_SKILL_MD_BYTES) throw new Error('SKILL.md 不存在、不是普通文件或超过 1 MiB');
    const text = fs.readFileSync(skillMd, 'utf8');
    const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!match) throw new Error('SKILL.md 缺少 YAML Frontmatter');
    const document = YAML.parseDocument(match[1]);
    if (document.errors.length) throw new Error(`YAML 解析失败：${document.errors[0].message}`);
    frontmatter = document.toJSON() || {};
    body = text.slice(match[0].length);
    const name = String(frontmatter.name || '').trim();
    const description = String(frontmatter.description || '').trim();
    if (!NAME_RE.test(name) || name.length > 64) errors.push({ code: 'SKILL_NAME_INVALID', message: 'name 必须使用小写短横线名称' });
    if (path.basename(directory) !== name) errors.push({ code: 'SKILL_NAME_MISMATCH', message: 'name 与目录名不一致' });
    if (!description || description.length > 1024) errors.push({ code: 'SKILL_DESCRIPTION_REQUIRED', message: 'description 不能为空且最长 1024 字符' });
    if (String(frontmatter.compatibility || '').length > 500) errors.push({ code: 'SKILL_COMPATIBILITY_TOO_LONG', message: 'compatibility 过长' });
    if (frontmatter.metadata !== undefined && (!frontmatter.metadata || Array.isArray(frontmatter.metadata) || typeof frontmatter.metadata !== 'object')) errors.push({ code: 'SKILL_METADATA_INVALID', message: 'metadata 必须是对象' });
    const walked = walkSkill(directory, rootReal);
    files = walked.files;
    const hash = crypto.createHash('sha256');
    files.sort().forEach((file) => {
      const relative = path.relative(directory, file).replace(/\\/g, '/');
      const fileStat = fs.statSync(file);
      hash.update(`${relative}\0${fileStat.size}\0`);
      hash.update(fs.readFileSync(file));
    });
    contentHash = hash.digest('hex');
  } catch (error) {
    errors.push({ code: error.code || 'SKILL_INVALID', message: error.message });
  }
  return {
    name: String(frontmatter.name || path.basename(directory) || ''),
    description: String(frontmatter.description || ''), frontmatter, body, files,
    status: errors.length ? 'invalid' : 'valid', errors, contentHash, skillMd,
  };
}
function scanRoot(root) {
  const db = getDb();
  const seen = new Set();
  try {
    if (!fs.existsSync(root.path)) return [];
    const entries = fs.readdirSync(root.path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    const upsert = db.prepare(`INSERT INTO skills (id,root_id,name,description,directory_path,real_path,skill_md_path,frontmatter_json,status,validation_errors_json,content_hash,source_label,managed,last_seen_at,created_at,updated_at)
      VALUES (@id,@root_id,@name,@description,@directory_path,@real_path,@skill_md_path,@frontmatter_json,@status,@validation_errors_json,@content_hash,@source_label,@managed,@last_seen_at,datetime('now'),datetime('now'))
      ON CONFLICT(root_id,directory_path) DO UPDATE SET name=excluded.name,description=excluded.description,real_path=excluded.real_path,skill_md_path=excluded.skill_md_path,frontmatter_json=excluded.frontmatter_json,status=excluded.status,validation_errors_json=excluded.validation_errors_json,content_hash=excluded.content_hash,source_label=excluded.source_label,managed=excluded.managed,last_seen_at=excluded.last_seen_at,updated_at=datetime('now')`);
    entries.forEach((entry) => {
      const directory = path.join(root.path, entry.name);
      if (!fs.existsSync(path.join(directory, 'SKILL.md'))) return;
      const skill = inspectSkill(root, directory);
      const relative = path.relative(root.path, directory).replace(/\\/g, '/');
      seen.add(relative);
      let realPath = null; try { realPath = fs.realpathSync(directory); } catch {}
      const existing = db.prepare('SELECT id FROM skills WHERE root_id = ? AND directory_path = ?').get(root.id, relative);
      upsert.run({ id: existing?.id || crypto.randomUUID(), root_id: root.id, name: skill.name, description: skill.description, directory_path: relative, real_path: realPath, skill_md_path: skill.skillMd, frontmatter_json: JSON.stringify(skill.frontmatter), status: skill.status, validation_errors_json: JSON.stringify(skill.errors), content_hash: skill.contentHash, source_label: sourceLabel(root), managed: root.managedByNotus ? 1 : 0, last_seen_at: now() });
    });
    db.prepare(`UPDATE skills SET status = 'missing', updated_at = datetime('now') WHERE root_id = ? AND last_seen_at < ?`).run(root.id, now());
    db.prepare(`UPDATE skill_roots SET last_scan_at = datetime('now'), last_error = NULL WHERE id = ?`).run(root.id);
  } catch (error) {
    db.prepare(`UPDATE skill_roots SET last_error = ? WHERE id = ?`).run(error.message, root.id);
  }
  return listSkills({ rootId: root.id });
}
function scanAllSkills() { return ensureRootRecords().flatMap(scanRoot); }
async function startSkillWatchers() {
  if (watchersStarted) return;
  watchersStarted = true;
  if (!chokidarModulePromise) chokidarModulePromise = import('chokidar');
  const imported = await chokidarModulePromise;
  if (!watchersStarted) return;
  const chokidar = imported.default || imported;
  ensureRootRecords().forEach((root) => {
    if (watchers.has(root.id)) return;
    const watcher = chokidar.watch(root.path, { persistent: true, ignoreInitial: true, usePolling: true, interval: 3000, depth: 5, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }, ignored: ['**/.git/**', '**/node_modules/**', '**/.staging/**', '**/*.swp', '**/*~'] });
    let timer = null;
    const rescan = () => { clearTimeout(timer); timer = setTimeout(() => scanRoot(root), 500); };
    watcher.on('all', rescan);
    watchers.set(root.id, watcher);
  });
}
function stopSkillWatchers() { watchers.forEach((watcher) => watcher.close()); watchers.clear(); watchersStarted = false; }
function initializeSkills() {
  ensureRootRecords();
  scanAllSkills();
  startSkillWatchers().catch(() => { watchersStarted = false; });
}
function formatSkill(row) {
  const enabled = getDb().prepare('SELECT enabled FROM skill_user_state WHERE owner_id = ? AND skill_id = ?').get(OWNER_ID, row.id);
  return { ...row, managed: Boolean(row.managed), enabled: enabled ? Boolean(enabled.enabled) : true, frontmatter: parseJson(row.frontmatter_json, {}), validation_errors: parseJson(row.validation_errors_json, []) };
}
function listSkills({ rootId = '', includeMissing = false } = {}) {
  const db = getDb();
  const rows = rootId ? db.prepare('SELECT * FROM skills WHERE root_id = ? ORDER BY name, source_label').all(rootId) : db.prepare('SELECT * FROM skills ORDER BY name, source_label').all();
  return rows.map(formatSkill).filter((item) => includeMissing || item.status !== 'missing');
}
function getSkill(id) { const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(String(id || '')); return row ? formatSkill(row) : null; }
function setSkillEnabled(id, enabled) {
  if (!getSkill(id)) throw Object.assign(new Error('Skill 不存在'), { code: 'SKILL_NOT_FOUND' });
  getDb().prepare(`INSERT INTO skill_user_state (owner_id,skill_id,enabled,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(owner_id,skill_id) DO UPDATE SET enabled=excluded.enabled,updated_at=datetime('now')`).run(OWNER_ID, id, enabled ? 1 : 0);
  return getSkill(id);
}
function eligibleSkillSummaries(goal = '', explicitIds = []) {
  const words = String(goal).toLowerCase().split(/[\s，。；、,.!?？]+/).filter((word) => word.length > 1);
  const explicit = new Set(explicitIds.map(String));
  return listSkills().filter((item) => item.status === 'valid' && item.enabled).map((item) => ({ ...item, score: explicit.has(item.id) ? 10000 : words.reduce((sum, word) => sum + (String(item.name + ' ' + item.description).toLowerCase().includes(word) ? 1 : 0), 0) })).sort((left, right) => right.score - left.score || String(left.name).localeCompare(String(right.name))).slice(0, 50).map((item) => ({ id: item.id, name: item.name, description: item.description, sourceLabel: item.source_label, explicit: explicit.has(item.id) }));
}
function loadSkill(id) {
  const skill = getSkill(id);
  if (!skill || skill.status !== 'valid' || !skill.enabled) throw Object.assign(new Error('Skill 不可用'), { code: 'SKILL_UNAVAILABLE' });
  const root = getDb().prepare('SELECT * FROM skill_roots WHERE id = ?').get(skill.root_id);
  const directory = path.join(root.path, skill.directory_path);
  const checked = inspectSkill(root, directory);
  if (checked.status !== 'valid') throw Object.assign(new Error('Skill 文件已失效'), { code: 'SKILL_INVALID' });
  return { id: skill.id, name: checked.name, description: checked.description, source_label: skill.source_label, frontmatter: checked.frontmatter, instructions: checked.body, files: checked.files.map((file) => path.relative(directory, file).replace(/\\/g, '/')).slice(0, 200), root: directory };
}
function readSkillFile(id, relativePath) {
  const loaded = loadSkill(id);
  const target = path.resolve(loaded.root, String(relativePath || ''));
  if (!target.startsWith(`${loaded.root}${path.sep}`) || !fs.statSync(target).isFile()) throw Object.assign(new Error('Skill 文件越界或不存在'), { code: 'SKILL_PATH_OUTSIDE_ROOT' });
  const stat = fs.statSync(target);
  if (stat.size > 256 * 1024) throw Object.assign(new Error('Skill 支持文件超过 256 KiB'), { code: 'SKILL_FILE_TOO_LARGE' });
  return { path: path.relative(loaded.root, target).replace(/\\/g, '/'), content: fs.readFileSync(target, 'utf8') };
}
function createJob(type, input = {}) { const id = crypto.randomUUID(); getDb().prepare('INSERT INTO skill_jobs (id,type,status,stage,progress,input_json) VALUES (?,?,?,?,?,?)').run(id, type, 'running', 'validating_source', 1, JSON.stringify(input)); return id; }
function updateJob(id, stage, progress, extra = {}) { getDb().prepare(`UPDATE skill_jobs SET stage=?,progress=?,status=?,result_json=?,error_code=?,error_message=?,updated_at=datetime('now'),finished_at=CASE WHEN ? IN ('completed','failed') THEN datetime('now') ELSE NULL END WHERE id=?`).run(stage, progress, extra.status || 'running', extra.result ? JSON.stringify(extra.result) : null, extra.errorCode || null, extra.errorMessage || null, extra.status || 'running', id); }
function getJob(id) { const row = getDb().prepare('SELECT * FROM skill_jobs WHERE id = ?').get(id); return row ? { ...row, input: parseJson(row.input_json, {}), result: parseJson(row.result_json, null) } : null; }
function validateGitUrl(value) { const url = new URL(String(value || '')); if (url.protocol !== 'https:' || url.username || url.password) throw Object.assign(new Error('只支持不含凭据的 HTTPS Git URL'), { code: 'SKILL_SOURCE_UNREACHABLE' }); return url.toString(); }
function discoverCandidates(root) {
  const result = [];
  const visit = (dir, depth) => {
    if (depth > 4) return;
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) result.push(dir);
    fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)).forEach((entry) => visit(path.join(dir, entry.name), depth + 1));
  };
  visit(root, 0);
  return [...new Set(result)];
}
function installCandidate(candidate, source = {}) {
  const caps = getCapabilities();
  const managed = caps.skills.managedRoot;
  fs.mkdirSync(path.join(managed, '.staging'), { recursive: true, mode: 0o700 });
  const syntheticRoot = { path: path.dirname(candidate), providers: ['source'] };
  const inspected = inspectSkill(syntheticRoot, candidate);
  if (inspected.status !== 'valid') throw Object.assign(new Error(inspected.errors.map((item) => item.message).join('；')), { code: 'SKILL_INVALID' });
  const target = path.join(managed, inspected.name);
  if (fs.existsSync(target) && source.conflictPolicy !== 'replace') throw Object.assign(new Error('同名 Skill 已存在'), { code: 'SKILL_ALREADY_EXISTS' });
  const stage = path.join(managed, '.staging', `${crypto.randomUUID()}-${inspected.name}`);
  fs.cpSync(candidate, stage, { recursive: true, dereference: false, errorOnExist: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(stage, target);
  scanAllSkills();
  const installed = listSkills().find((item) => item.managed && item.name === inspected.name && item.status === 'valid');
  if (!installed) throw new Error('安装后的 Skill 未被索引');
  getDb().prepare('INSERT INTO skill_installations (id,skill_id,method,repository_url,repository_ref,repository_commit,repository_subdirectory,archive_sha256,draft_id,installed_hash,installed_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), installed.id, source.method || 'local', source.repositoryUrl || null, source.ref || null, source.commit || null, source.subdirectory || null, source.archiveSha256 || null, source.draftId || null, installed.content_hash, now(), now());
  return installed;
}
async function installFromGit(input = {}) {
  const jobId = createJob('git_install', { repository_url: input.repositoryUrl, ref: input.ref || '' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-skill-git-'));
  try {
    const url = validateGitUrl(input.repositoryUrl);
    updateJob(jobId, 'cloning_or_uploading', 20);
    const token = input.credentialId ? await readSecret(input.credentialId) : String(input.token || '');
    await git.clone({ fs, http, dir: temp, url, ref: input.ref || undefined, singleBranch: Boolean(input.ref), depth: 1, onAuth: token ? () => ({ username: 'oauth2', password: token }) : undefined });
    const root = input.subdirectory ? path.resolve(temp, input.subdirectory) : temp;
    if (!root.startsWith(temp)) throw Object.assign(new Error('子目录越界'), { code: 'SKILL_PATH_OUTSIDE_ROOT' });
    updateJob(jobId, 'finding_skills', 50);
    const candidates = discoverCandidates(root);
    if (!candidates.length) throw Object.assign(new Error('仓库中没有 Skill'), { code: 'SKILL_INVALID' });
    const selected = input.selectedSkillPaths?.length ? candidates.filter((candidate) => input.selectedSkillPaths.includes(path.relative(temp, candidate).replace(/\\/g, '/'))) : candidates;
    const installed = selected.map((candidate) => installCandidate(candidate, { method: 'git', repositoryUrl: url, ref: input.ref || '', subdirectory: path.relative(temp, candidate).replace(/\\/g, '/'), conflictPolicy: input.conflictPolicy }));
    updateJob(jobId, 'completed', 100, { status: 'completed', result: { skills: installed } });
    return { jobId, skills: installed };
  } catch (error) {
    updateJob(jobId, 'failed', 100, { status: 'failed', errorCode: error.code || 'SKILL_INSTALL_FAILED', errorMessage: error.message });
    throw error;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
async function installFromZip(filePath, input = {}) {
  const jobId = createJob('zip_install', {});
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-skill-zip-'));
  try {
    const stat = fs.statSync(filePath); if (stat.size > 100 * 1024 * 1024) throw Object.assign(new Error('ZIP 超过 100 MiB'), { code: 'SKILL_ARCHIVE_UNSAFE' });
    updateJob(jobId, 'extracting', 30);
    const directory = await unzipper.Open.file(filePath);
    if (directory.files.length > MAX_SKILL_FILES) throw Object.assign(new Error('ZIP 条目过多'), { code: 'SKILL_ARCHIVE_UNSAFE' });
    let extracted = 0;
    for (const entry of directory.files) {
      const name = String(entry.path || '');
      if (!name || name.startsWith('/') || name.includes('..') || /(^|\/)[A-Za-z]:/.test(name) || entry.type === 'SymbolicLink') throw Object.assign(new Error('ZIP 包含不安全路径'), { code: 'SKILL_ARCHIVE_UNSAFE' });
      extracted += Number(entry.uncompressedSize || 0); if (extracted > MAX_SKILL_BYTES) throw Object.assign(new Error('ZIP 解压后过大'), { code: 'SKILL_ARCHIVE_UNSAFE' });
    }
    await directory.extract({ path: temp });
    updateJob(jobId, 'finding_skills', 60);
    const candidates = discoverCandidates(temp); if (!candidates.length) throw Object.assign(new Error('压缩包中没有 Skill'), { code: 'SKILL_INVALID' });
    const installed = candidates.map((candidate) => installCandidate(candidate, { method: 'zip', archiveSha256: sha256(fs.readFileSync(filePath)), conflictPolicy: input.conflictPolicy }));
    updateJob(jobId, 'completed', 100, { status: 'completed', result: { skills: installed } });
    return { jobId, skills: installed };
  } catch (error) { updateJob(jobId, 'failed', 100, { status: 'failed', errorCode: error.code || 'SKILL_INSTALL_FAILED', errorMessage: error.message }); throw error; } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function createSkillDraft(input = {}) {
  const id = crypto.randomUUID();
  const draft = { id, name: String(input.name || '').trim(), description: String(input.description || '').trim(), instructions: String(input.instructions || '').trim(), files: Array.isArray(input.files) ? input.files : [] };
  const validation = validateDraft(draft);
  getDb().prepare('INSERT INTO skill_drafts (id,name,description,instructions,files_json,validation_json,status,expires_at) VALUES (?,?,?,?,?,?,?,datetime(\'now\',\'+1 day\'))').run(id, draft.name, draft.description, draft.instructions, JSON.stringify(draft.files), JSON.stringify(validation), validation.length ? 'invalid' : 'draft');
  return { ...draft, validation };
}
function validateDraft(draft) {
  const errors = [];
  if (!NAME_RE.test(draft.name)) errors.push({ code: 'SKILL_NAME_INVALID', message: '名称必须使用小写短横线格式' });
  if (!draft.description || draft.description.length > 1024) errors.push({ code: 'SKILL_DESCRIPTION_REQUIRED', message: '请填写 Skill 描述' });
  if (!draft.instructions) errors.push({ code: 'SKILL_INSTRUCTIONS_REQUIRED', message: '请填写 Skill 指令' });
  if ((draft.files || []).some((file) => !file?.path || path.isAbsolute(file.path) || String(file.path).includes('..'))) errors.push({ code: 'SKILL_PATH_OUTSIDE_ROOT', message: '草稿文件路径不安全' });
  return errors;
}
function getSkillDraft(id) { const row = getDb().prepare('SELECT * FROM skill_drafts WHERE id = ?').get(id); return row ? { ...row, files: parseJson(row.files_json, []), validation: parseJson(row.validation_json, []) } : null; }
function installSkillDraft(id, conflictPolicy = 'reject') {
  const draft = getSkillDraft(id); if (!draft) throw Object.assign(new Error('草稿不存在'), { code: 'SKILL_DRAFT_NOT_FOUND' });
  if (draft.validation.length) throw Object.assign(new Error('草稿未通过校验'), { code: 'SKILL_INVALID' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-skill-draft-'));
  try {
    const directory = path.join(temp, draft.name); fs.mkdirSync(directory);
    const frontmatter = YAML.stringify({ name: draft.name, description: draft.description });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\n${frontmatter}---\n\n${draft.instructions}\n`);
    draft.files.forEach((file) => { const target = path.join(directory, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, String(file.content || '')); });
    const installed = installCandidate(directory, { method: 'agent_draft', draftId: draft.id, conflictPolicy });
    getDb().prepare(`UPDATE skill_drafts SET status = 'installed', updated_at = datetime('now') WHERE id = ?`).run(id);
    return installed;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function deleteSkill(id) {
  const skill = getSkill(id); if (!skill) throw Object.assign(new Error('Skill 不存在'), { code: 'SKILL_NOT_FOUND' });
  if (!skill.managed) throw Object.assign(new Error('外部 Skill 只能从 Notus 停用'), { code: 'SKILL_NOT_MANAGED' });
  const root = getDb().prepare('SELECT * FROM skill_roots WHERE id = ?').get(skill.root_id);
  const target = path.resolve(root.path, skill.directory_path); if (!target.startsWith(`${path.resolve(root.path)}${path.sep}`)) throw Object.assign(new Error('删除路径非法'), { code: 'SKILL_PATH_OUTSIDE_ROOT' });
  fs.rmSync(target, { recursive: true, force: true }); scanAllSkills(); return { deleted: true };
}

module.exports = { getCapabilities, skillRoots, initializeSkills, stopSkillWatchers, scanAllSkills, listSkills, getSkill, setSkillEnabled, eligibleSkillSummaries, loadSkill, readSkillFile, installFromGit, installFromZip, createSkillDraft, getSkillDraft, installSkillDraft, deleteSkill, getJob, saveSecret };
