const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-file-identity-'));
const notesDir = path.join(root, 'notes');
const dbPath = path.join(root, 'db.sqlite');
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: notesDir,
  DB_PATH: dbPath, ASSETS_DIR: path.join(root, 'assets'), SESSION_DIR: path.join(root, 'session'),
});

const { closeDb, getDb } = require('../lib/db');
const { createFile, getAllFiles, getFileById, renameFile } = require('../lib/files');
getDb();
const peer = new Database(dbPath, { timeout: 0 });

function assertWriteLocked() {
  assert.throws(() => peer.exec('BEGIN IMMEDIATE'), error => error.code === 'SQLITE_BUSY',
    '并发磁盘扫描不得在文件写盘或改名中途取得数据库写锁');
}

const originalRename = fs.renameSync;
try {
  let createLockSeen = false;
  fs.renameSync = (from, to) => {
    if (to === path.join(notesDir, '旧名.md')) { assertWriteLocked(); createLockSeen = true; }
    return originalRename(from, to);
  };
  const created = createFile('旧名.md', '# 旧名\n', { titleFilenameBindingEnabled: false });
  assert(createLockSeen);

  let renameLockSeen = false;
  fs.renameSync = (from, to) => {
    if (to === path.join(notesDir, '新名.md')) { assertWriteLocked(); renameLockSeen = true; }
    return originalRename(from, to);
  };
  const renamed = renameFile(created.path, '新名.md');
  assert(renameLockSeen);
  assert.equal(renamed.id, created.id);

  const originalReadDir = fs.readdirSync;
  let scanLockSeen = false;
  try {
    fs.readdirSync = (...args) => {
      if (!scanLockSeen && args[0] === notesDir) { assertWriteLocked(); scanLockSeen = true; }
      return originalReadDir(...args);
    };
    const rows = getAllFiles();
    assert(scanLockSeen);
    assert.equal(rows.find(file => file.path === '新名.md')?.id, created.id);
    assert.equal(getFileById(created.id)?.path, '新名.md');
  } finally {
    fs.readdirSync = originalReadDir;
  }
  closeDb();
  assert.equal(getFileById(created.id)?.path, '新名.md', '数据库重开后链接 ID 仍指向原文件');
  closeDb();
  console.log('file identity atomicity tests passed');
} finally {
  fs.renameSync = originalRename;
  peer.close();
  fs.rmSync(root, { recursive: true, force: true });
}
