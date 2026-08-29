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
    saveFileByPath,
    syncFileHeadingToName,
    updateFile,
  } = require('../lib/files');

  setSetting('editor_title_filename_binding_enabled', 'true');

  const created = createFile('old-name.md', '# 初始标题\n\n正文内容');
  assert.strictEqual(created.path, '初始标题.md');
  assert.strictEqual(created.title_binding_applied, true);
  const initial = getFileById(created.id);
  const renamedOnSave = updateFile(created.id, initial.content.replace('# 初始标题', '# 保存后新标题'));

  assert.strictEqual(renamedOnSave.path, '保存后新标题.md');
  assert.strictEqual(renamedOnSave.title_binding_applied, true);
  assert.strictEqual(renamedOnSave.title_binding_warning, '');
  assert.ok(fs.existsSync(path.join(tempDir, 'notes', '保存后新标题.md')));

  const frontmatterTitleFile = createFile('frontmatter-source.md', [
    '---',
    'id: notus_frontmatter_title',
    'created_by: notus_agent',
    'title: "旧标题"',
    '---',
    '',
    '# 旧标题',
    '',
    '正文内容',
  ].join('\n'), { titleFilenameBindingEnabled: false });
  const renamedFromEditorTitle = updateFile(frontmatterTitleFile.id, frontmatterTitleFile.content, { title: '顶部输入框新标题' });

  assert.strictEqual(renamedFromEditorTitle.path, '顶部输入框新标题.md');
  assert.strictEqual(renamedFromEditorTitle.title, '顶部输入框新标题');
  assert.ok(renamedFromEditorTitle.content.includes('title: "顶部输入框新标题"'));
  assert.ok(renamedFromEditorTitle.content.includes('# 顶部输入框新标题'));

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

  const imported = saveFileByPath('导入默认标题.md', [
    '---',
    'title: "导入源标题"',
    '---',
    '',
    '# 导入源标题',
    '',
    '导入正文',
  ].join('\n'), { titleFromFileName: true });
  assert.strictEqual(imported.path, '导入默认标题.md');
  assert.strictEqual(imported.title, '导入默认标题');
  assert.ok(imported.content.includes('title: "导入默认标题"'));
  assert.ok(imported.content.includes('# 导入默认标题'));

  if (process.platform !== 'win32') {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-outside-notes-'));
    const linkPath = path.join(tempDir, 'notes', 'outside-link');
    fs.writeFileSync(path.join(outsideDir, 'outside.md'), '# 外部文件');
    fs.symlinkSync(outsideDir, linkPath, 'dir');

    assert.throws(
      () => renameFile('outside-link/outside.md', '不应移动.md'),
      /symbolic links are not allowed/
    );

    const safeSource = createFile('安全移动源.md', '# 安全移动源');
    assert.throws(
      () => renameFile(safeSource.path, 'outside-link/不应写入.md'),
      /symbolic links are not allowed/
    );
  }

  console.log('file title binding tests passed');
}

runTests();
