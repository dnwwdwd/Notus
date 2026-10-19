const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-files-sync-'));
const notesDir = path.join(root, 'notes');
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web',
  NOTUS_DATA_ROOT: root,
  NOTES_DIR: notesDir,
  DB_PATH: path.join(root, 'db.sqlite'),
  ASSETS_DIR: path.join(root, 'assets'),
  SESSION_DIR: path.join(root, 'session'),
  LOG_DIR: path.join(root, 'logs'),
});

const { getDb } = require('../lib/db');
const {
  syncFilesFromDisk,
  getAllFiles,
  getFileByPath,
  listFilesByPaths,
  writeMarkdownFile,
} = require('../lib/files');

getDb();
fs.mkdirSync(notesDir, { recursive: true });

function stubReaddirSync(dirAbs) {
  const counter = { count: 0 };
  const original = fs.readdirSync;
  fs.readdirSync = (...args) => {
    if (String(args[0]) === dirAbs) counter.count += 1;
    return original(...args);
  };
  counter.restore = () => { fs.readdirSync = original; };
  return counter;
}

async function runTests() {
  // 1. 同 Hash、mtime、size 且已有稳定 ID 才跳过解析与写库；同大小/同时间戳的外部编辑仍被发现。
  const unchangedAbs = path.join(notesDir, 'unchanged.md');
  writeMarkdownFile('unchanged.md', '# Unchanged\n\nbody\n');
  syncFilesFromDisk();
  const before = getFileByPath('unchanged.md');
  writeMarkdownFile('unchanged.md', '# Unchanged\n\nbody\n');
  syncFilesFromDisk();
  const afterSameContent = getFileByPath('unchanged.md');
  assert.strictEqual(afterSameContent.hash, before.hash, '同内容重写 hash 应保持不变');

  const sameShapeAbs = path.join(notesDir, 'same-shape.md');
  writeMarkdownFile('same-shape.md', '# Same\n\nafter-1\n');
  syncFilesFromDisk();
  const sameShapeBefore = getFileByPath('same-shape.md');
  const sameShapeStat = fs.statSync(sameShapeAbs);
  fs.writeFileSync(sameShapeAbs, '# Same\n\nother-1\n');
  fs.utimesSync(sameShapeAbs, sameShapeStat.atime, sameShapeStat.mtime);
  syncFilesFromDisk();
  const sameShapeAfter = getFileByPath('same-shape.md');
  assert.notStrictEqual(sameShapeAfter.hash, sameShapeBefore.hash, '同大小同时间戳的内容修改仍应被发现');
  assert.ok(sameShapeAfter.content.includes('other-1'), '同步后应读取到修改后的内容');

  // 2. listFilesByPaths 一次 sync + 批量 WHERE path IN 查询。
  writeMarkdownFile('batch-a.md', '# A\n');
  writeMarkdownFile('batch-b.md', '# B\n');
  syncFilesFromDisk();
  let scans = stubReaddirSync(notesDir);
  try {
    const found = listFilesByPaths(['batch-a.md', 'batch-b.md', 'missing.md', 'batch-a.md']);
    assert.strictEqual(scans.count, 1, '多路径查询应只触发一次磁盘同步');
    assert.deepStrictEqual(found.map((file) => file.path), ['batch-a.md', 'batch-b.md', 'batch-a.md']);
    assert.deepStrictEqual(found.map((file) => file.title), ['A', 'B', 'A']);
  } finally {
    scans.restore();
  }

  // 3. 单个文件读取失败不瘫痪全库同步，且不删除 DB 旧记录。
  writeMarkdownFile('bad.md', '# Bad\n');
  writeMarkdownFile('good.md', '# Good\n');
  syncFilesFromDisk();
  assert.ok(getFileByPath('bad.md'));
  writeMarkdownFile('good.md', '# Good\n\nchanged\n');
  // 让 bad.md 的时间戳变化，强制同步路径尝试读取它。
  const badAbs = path.join(notesDir, 'bad.md');
  const now = new Date(Date.now() + 5000);
  fs.utimesSync(badAbs, now, now);
  const originalRead = fs.readFileSync;
  const originalWarn = console.warn;
  let warned = false;
  try {
    fs.readFileSync = (...args) => {
      if (String(args[0]) === badAbs) throw new Error('simulated unreadable file');
      return originalRead(...args);
    };
    console.warn = () => { warned = true; };
    syncFilesFromDisk();
  } finally {
    fs.readFileSync = originalRead;
    console.warn = originalWarn;
  }
  assert.ok(warned, '坏文件读取失败应记录警告');
  const badRow = getFileByPath('bad.md');
  assert.ok(badRow, '读取失败的文件不应从 DB 删除旧记录');
  assert.strictEqual(badRow.content, '# Bad\n');
  assert.strictEqual(getFileByPath('good.md').content, '# Good\n\nchanged\n', '其他文件应正常同步');

  // 4. getAllFiles({ skipSync: true }) 纯读路径不触发磁盘扫描。
  let skipScans = stubReaddirSync(notesDir);
  try {
    const rows = getAllFiles({ skipSync: true });
    assert.strictEqual(skipScans.count, 0, 'skipSync 时不应扫描磁盘');
    assert.ok(rows.some((file) => file.path === 'good.md'));
  } finally {
    skipScans.restore();
  }

  console.log('files sync tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
