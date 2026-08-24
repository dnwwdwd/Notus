const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-file-vector-cleanup-'));
process.env.NOTUS_RUNTIME_TARGET = 'web';
process.env.NOTUS_DATA_ROOT = dataRoot;
process.env.EMBEDDING_DIM = '4';

const { getDb, isVecAvailable } = require('../lib/db');
const { getEffectiveConfig } = require('../lib/config');
const {
  createFile,
  deleteFile,
  deleteFolder,
  getFileByPath,
  syncFilesFromDisk,
} = require('../lib/files');
const { removeFile } = require('../lib/indexer');
const orphanVectorCleanupMigration = require('../lib/migrations/009_cleanup_orphan_vectors');

const db = getDb();
assert.ok(isVecAvailable(), '向量扩展必须可用，才能验证删除清理');

function seedIndexedFile(relativePath) {
  createFile(relativePath, `# ${relativePath}\n\n用于验证删除时的向量清理。`);
  const file = getFileByPath(relativePath);
  const chunkId = db.prepare(`
    INSERT INTO chunks (
      file_id, content, type, position, line_start, line_end, heading_path,
      has_image, search_text, source_hash, index_version
    ) VALUES (?, ?, 'paragraph', 0, 1, 1, '', 0, ?, '', 1)
  `).run(file.id, '可删除的测试内容', '可删除的测试内容').lastInsertRowid;
  const imageId = db.prepare(`
    INSERT INTO images (chunk_id, url, alt_text, status, cache_status, embedding_status)
    VALUES (?, 'https://example.test/image.png', '', 'ready', 'ready', 'indexed')
  `).run(chunkId).lastInsertRowid;
  const embedding = JSON.stringify([0.1, 0.2, 0.3, 0.4]);
  db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(BigInt(chunkId), embedding);
  db.prepare('INSERT INTO images_vec (image_id, embedding) VALUES (?, ?)').run(BigInt(imageId), embedding);
  return { file, chunkId, imageId };
}

function assertVectorsRemoved({ chunkId, imageId }, label) {
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM chunks_vec WHERE chunk_id = ?').get(BigInt(chunkId)).count,
    0,
    `${label} 后不得保留文本向量`
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM images_vec WHERE image_id = ?').get(BigInt(imageId)).count,
    0,
    `${label} 后不得保留图片向量`
  );
}

const direct = seedIndexedFile('single.md');
assert.strictEqual(deleteFile(direct.file.id), true, '文件删除接口应删除目标文件');
assertVectorsRemoved(direct, 'deleteFile');

const nested = seedIndexedFile('folder/nested.md');
deleteFolder('folder');
assertVectorsRemoved(nested, 'deleteFolder');

const watcher = seedIndexedFile('watcher.md');
fs.unlinkSync(path.join(getEffectiveConfig().notesDir, 'watcher.md'));
syncFilesFromDisk();
assertVectorsRemoved(watcher, 'syncFilesFromDisk');

const incremental = seedIndexedFile('incremental.md');
removeFile('incremental.md');
assertVectorsRemoved(incremental, 'removeFile');

const embedding = JSON.stringify([0.1, 0.2, 0.3, 0.4]);
db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(BigInt(999991), embedding);
db.prepare('INSERT INTO images_vec (image_id, embedding) VALUES (?, ?)').run(BigInt(999992), embedding);
orphanVectorCleanupMigration.up(db, {
  tableExists(database, name) {
    return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));
  },
});
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM chunks_vec WHERE chunk_id = ?').get(BigInt(999991)).count, 0, '迁移必须清理已有孤立文本向量');
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM images_vec WHERE image_id = ?').get(BigInt(999992)).count, 0, '迁移必须清理已有孤立图片向量');

console.log('file vector cleanup tests passed');
