const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function buildTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notus-title-binding-'));
}

function runTests() {
  const tempDir = buildTempWorkspace();
  fs.mkdirSync(path.join(tempDir, 'notes'), { recursive: true });

  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempDir;

  [
    '../lib/db',
    '../lib/config',
    '../lib/files',
    '../lib/markdownMeta',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const { setSetting } = require('../lib/db');
  const {
    createFile,
    getFileById,
    renameFile,
    syncFileHeadingToName,
    updateFile,
  } = require('../lib/files');

  setSetting('editor_title_filename_binding_enabled', 'true');

  const created = createFile('old-name.md', '# 初始标题\n\n正文内容');
  const initial = getFileById(created.id);
  const renamedOnSave = updateFile(created.id, initial.content.replace('# 初始标题', '# 保存后新标题'));

  assert.strictEqual(renamedOnSave.path, '保存后新标题.md');
  assert.strictEqual(renamedOnSave.title_binding_applied, true);
  assert.strictEqual(renamedOnSave.title_binding_warning, '');
  assert.ok(fs.existsSync(path.join(tempDir, 'notes', '保存后新标题.md')));

  createFile('冲突标题.md', '# 冲突标题\n\n已有文件');
  const beforeConflict = getFileById(created.id);
  const conflictResult = updateFile(created.id, beforeConflict.content.replace('# 保存后新标题', '# 冲突标题'));
  const afterConflict = getFileById(created.id);

  assert.strictEqual(conflictResult.path, '保存后新标题.md');
  assert.strictEqual(conflictResult.title_binding_applied, false);
  assert.ok(conflictResult.title_binding_warning.includes('未同步文件名'));
  assert.ok(afterConflict.content.includes('# 冲突标题'));
  assert.ok(fs.existsSync(path.join(tempDir, 'notes', '保存后新标题.md')));

  const noHeadingFile = createFile('rename-source.md', '正文第一段\n\n正文第二段');
  const renamedFile = renameFile(noHeadingFile.path, '侧边栏重命名.md');
  const syncedRename = syncFileHeadingToName(renamedFile.id, renamedFile.name.replace(/\.md$/i, ''));
  const latestRenamed = getFileById(renamedFile.id);

  assert.strictEqual(latestRenamed.path, '侧边栏重命名.md');
  assert.strictEqual(renamedFile.name, '侧边栏重命名.md');
  assert.ok(renamedFile.content.includes('正文第一段'));
  assert.ok(latestRenamed.content.startsWith('---\nid: '), '应保留系统 frontmatter');
  assert.ok(latestRenamed.content.includes('# 侧边栏重命名'));
  assert.ok(syncedRename.content.includes('# 侧边栏重命名'));

  console.log('file title binding tests passed');
}

runTests();
