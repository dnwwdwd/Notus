const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { Writable } = require('stream');
const crypto = require('crypto');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-backup-test-'));
const home = path.join(testRoot, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.NOTUS_RUNTIME_TARGET = 'electron';
process.env.NOTUS_DATA_ROOT = path.join(testRoot, 'data');
process.env.HOME = home;

function assertRejectsCode(promise, code) {
  return promise.then(
    () => { throw new Error(`预期失败：${code}`); },
    (error) => {
      assert.equal(error.code, code);
      return error;
    },
  );
}

async function exportArchive(backup) {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  const headers = {};
  response.setHeader = (name, value) => { headers[name] = value; };
  await backup.streamExport(response);
  return { buffer: Buffer.concat(chunks), headers };
}

async function writeZip(filePath, entries) {
  await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(filePath);
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    entries.forEach((entry) => archive.append(entry.content, { name: entry.path }));
    archive.finalize().catch(reject);
  });
}

async function writeSymlinkZip(filePath) {
  await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(filePath);
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.symlink('notes/link', '/etc/passwd');
    archive.finalize().catch(reject);
  });
}

async function addEntryToArchive(sourceZip, targetZip, extraPath, extraContent) {
  const directory = await unzipper.Open.file(sourceZip);
  await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(targetZip);
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    directory.files.forEach((entry) => {
      if (entry.type === 'Directory') archive.append('', { name: entry.path });
      else archive.append(entry.stream(), { name: entry.path });
    });
    archive.append(extraContent, { name: extraPath });
    archive.finalize().catch(reject);
  });
}

async function rewriteArchive(sourceZip, targetZip, replacements) {
  const directory = await unzipper.Open.file(sourceZip);
  const replacementMap = new Map(Object.entries(replacements));
  const contents = new Map();
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    contents.set(entry.path, replacementMap.has(entry.path) ? Buffer.from(replacementMap.get(entry.path)) : await entry.buffer());
  }
  await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(targetZip);
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    directory.files.forEach((entry) => {
      if (entry.type === 'Directory') archive.append('', { name: entry.path });
      else archive.append(contents.get(entry.path), { name: entry.path });
    });
    archive.finalize().catch(reject);
  });
}

async function run() {
  const runtime = require('../lib/runtime');
  const { getDb } = require('../lib/db');
  const configModule = require('../lib/config');
  const backup = require('../lib/backup');
  const { saveServer } = require('../lib/mcp');
  const { createToken } = require('../lib/externalMcp');
  const { createSession } = require('../lib/agentSession');
  const { readSecret } = require('../lib/secretStore');
  const { listSkills } = require('../lib/skills');

  try {
    assert.equal(runtime.ensureRuntime({ startBackground: false }).ok, true);
    const config = configModule.getEffectiveConfig();
    const targets = backup.getBackupTargets(config);
    fs.mkdirSync(path.join(config.assetsDir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(config.sessionDir, 'media'), { recursive: true });
    fs.writeFileSync(path.join(config.notesDir, 'keep.md'), '# 原始笔记\n');
    fs.writeFileSync(path.join(config.assetsDir, 'images', 'cover.png'), 'image');
    fs.writeFileSync(path.join(config.sessionDir, 'media', 'voice.txt'), 'media');

    const skillDir = path.join(targets.managedSkills, 'backup-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: backup-skill\ndescription: 备份测试 Skill\n---\n\n测试指令\n');

    const db = getDb();
    const conversation = db.prepare('INSERT INTO conversations (kind,title) VALUES (?,?)').run('knowledge', '备份对话');
    db.prepare('INSERT INTO messages (conversation_id,role,content) VALUES (?,?,?)').run(conversation.lastInsertRowid, 'user', '保留这条消息');
    const historicalSession = createSession({ goal: '已完成的历史 Agent', conversationId: Number(conversation.lastInsertRowid) });
    db.prepare("UPDATE agent_sessions SET status = 'completed' WHERE id = ?").run(historicalSession.sessionId);
    const secretServer = await saveServer({
      name: '备份 MCP',
      transport: 'streamable_http',
      http: { url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'secret-value', secret: true }] },
    });
    createToken({ name: '备份 Token', permissions: ['list_files'] });

    const exported = await exportArchive(backup);
    const archiveBytes = exported.buffer;
    assert.equal(exported.headers['Content-Type'], 'application/zip');
    assert.match(exported.headers['Content-Disposition'], /^attachment; filename="notus-backup-[^"]+\.zip"$/);
    const archivePath = path.join(testRoot, 'backup.zip');
    fs.writeFileSync(archivePath, archiveBytes);
    const zip = await unzipper.Open.buffer(archiveBytes);
    const paths = zip.files.map((entry) => entry.path);
    assert.ok(paths.includes('manifest.json'));
    assert.ok(paths.includes('database/index.db'));
    assert.ok(paths.includes('notes/keep.md'));
    assert.ok(paths.includes('assets/images/cover.png'));
    assert.ok(paths.includes('session/media/voice.txt'));
    assert.ok(paths.some((entry) => entry.startsWith('skills/managed/backup-skill/')));
    assert.ok(!paths.some((entry) => entry.startsWith('logs/')));
    assert.ok(!paths.some((entry) => entry.startsWith('cache/')));
    const manifest = JSON.parse((await zip.files.find((entry) => entry.path === 'manifest.json').buffer()).toString('utf8'));
    assert.equal(manifest.format, 'notus-backup');
    assert.equal(manifest.database_format_version, 1);
    assert.ok(!JSON.stringify(manifest).includes(config.dataRoot));
    const stage = await fsp.mkdtemp(path.join(testRoot, 'validated-'));
    await backup.validateZip(archivePath, stage);
    await fsp.rm(stage, { recursive: true, force: true });

    fs.writeFileSync(path.join(config.notesDir, 'keep.md'), '# 被覆盖\n');
    fs.writeFileSync(path.join(config.notesDir, 'only-current.md'), '不会残留');
    db.prepare('INSERT INTO conversations (kind,title) VALUES (?,?)').run('knowledge', '当前新增');
    await backup.restoreFromZip(archivePath);
    assert.equal(fs.readFileSync(path.join(config.notesDir, 'keep.md'), 'utf8'), '# 原始笔记\n');
    assert.equal(fs.existsSync(path.join(config.notesDir, 'only-current.md')), false);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM conversations WHERE title = ?').get('当前新增').count, 0);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE content = ?').get('保留这条消息').count, 1);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('chunks_vec', 'chunks_fts')").get().count, 2);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM agent_sessions WHERE status = ?').get('completed').count, 1);
    assert.equal(listSkills().some((skill) => skill.name === 'backup-skill'), true);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM mcp_servers WHERE name = ?').get('备份 MCP').count, 1);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM external_mcp_tokens WHERE name = ?').get('备份 Token').count, 1);
    const restoredConfig = JSON.parse(getDb().prepare('SELECT config_json FROM mcp_servers WHERE name = ?').get('备份 MCP').config_json);
    const restoredSecretId = restoredConfig.http.headers[0].secretId;
    assert.ok(restoredSecretId && restoredSecretId !== secretServer.config?.http?.headers?.[0]?.secretId);
    assert.equal(await readSecret(restoredSecretId), 'secret-value');
    const restoredTokenHash = getDb().prepare('SELECT token_hash FROM external_mcp_tokens WHERE name = ?').get('备份 Token').token_hash;
    assert.match(restoredTokenHash, /^[a-f0-9]{64}$/);

    const brokenPortable = Buffer.from(JSON.stringify({ version: 1, records: [] }, null, 2));
    const brokenManifest = { ...manifest, components: manifest.components.map((item) => item.path === 'secrets/portable.json'
      ? { ...item, bytes: brokenPortable.length, sha256: crypto.createHash('sha256').update(brokenPortable).digest('hex') }
      : item) };
    const brokenZip = path.join(testRoot, 'broken-secret.zip');
    await rewriteArchive(archivePath, brokenZip, {
      'manifest.json': JSON.stringify(brokenManifest, null, 2),
      'secrets/portable.json': brokenPortable,
    });
    await assertRejectsCode(backup.restoreFromZip(brokenZip), 'BACKUP_SECRET_RESTORE_FAILED');
    assert.equal(fs.readFileSync(path.join(config.notesDir, 'keep.md'), 'utf8'), '# 原始笔记\n');
    assert.equal(await readSecret(restoredSecretId), 'secret-value');

    const active = createSession({ goal: '未结束任务', conversationId: Number(conversation.lastInsertRowid) });
    await assertRejectsCode(backup.restoreFromZip(archivePath), 'BACKUP_ACTIVE_TASKS');
    assert.equal(fs.readFileSync(path.join(config.notesDir, 'keep.md'), 'utf8'), '# 原始笔记\n');
    getDb().prepare('DELETE FROM agent_sessions WHERE id = ?').run(active.sessionId);

    const invalidPathZip = path.join(testRoot, 'extra.zip');
    await addEntryToArchive(archivePath, invalidPathZip, 'notes/extra.md', 'not-listed');
    await assertRejectsCode(backup.restoreFromZip(invalidPathZip), 'BACKUP_INVALID');
    assert.equal(fs.readFileSync(path.join(config.notesDir, 'keep.md'), 'utf8'), '# 原始笔记\n');

    const symlinkZip = path.join(testRoot, 'symlink.zip');
    await writeSymlinkZip(symlinkZip);
    await assertRejectsCode(backup.restoreFromZip(symlinkZip), 'BACKUP_INVALID');
    const duplicateZip = path.join(testRoot, 'duplicate.zip');
    await writeZip(duplicateZip, [{ path: 'notes/duplicate.md', content: 'a' }, { path: 'notes/duplicate.md', content: 'b' }]);
    await assertRejectsCode(backup.restoreFromZip(duplicateZip), 'BACKUP_INVALID');

    assert.equal(backup.normalizedArchivePath('../escape'), null);
    assert.equal(backup.normalizedArchivePath('/absolute'), null);
    assert.equal(backup.normalizedArchivePath('notes/./escape'), null);
    console.log('backup restore tests passed');
  } finally {
    await runtime.stopRuntime().catch(() => {});
    await fsp.rm(testRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
