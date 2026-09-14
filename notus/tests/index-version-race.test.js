const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-index-version-'));
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: temp, EMBEDDING_DIM: '4',
  NOTES_DIR: path.join(temp, 'notes'), ASSETS_DIR: path.join(temp, 'assets'), DB_PATH: path.join(temp, 'index.db'),
});
let release;
let entered;
let calls = 0;
const ready = new Promise((resolve) => { entered = resolve; });
const embeddingId = require.resolve('../lib/embeddings');
require.cache[embeddingId] = { id: embeddingId, filename: embeddingId, loaded: true, exports: {
  getEmbeddings: async (rows) => {
    calls += 1;
    if (calls === 1) { entered(); await new Promise((resolve) => { release = resolve; }); }
    return rows.map(() => [0.1, 0.2, 0.3, 0.4]);
  },
} };
const styleId = require.resolve('../lib/style');
require.cache[styleId] = { id: styleId, filename: styleId, loaded: true, exports: { enqueueStyleExtraction() {}, setStyleBackfillPaused() {} } };
const files = require('../lib/files');
const { getDb } = require('../lib/db');
const { indexFile } = require('../lib/indexer');
async function run() {
  const file = files.createFile('version.md', '# version\nOLD BODY\n');
  const first = indexFile('version.md');
  await ready;
  files.updateFile(file.id, '# version\nSECOND BODY\n');
  const second = indexFile('version.md');
  files.updateFile(file.id, '# version\nLATEST BODY\n');
  const third = indexFile('version.md');
  release();
  await Promise.all([first, second, third]);
  const row = getDb().prepare('SELECT hash, indexed FROM files WHERE id=?').get(file.id);
  const chunks = getDb().prepare('SELECT content, source_hash FROM chunks WHERE file_id=?').all(file.id);
  assert.equal(row.indexed, 1);
  assert.ok(chunks.some((chunk) => chunk.content.includes('LATEST BODY')));
  assert.ok(chunks.every((chunk) => !chunk.content.includes('OLD BODY') && chunk.source_hash === row.hash));
  assert.equal(calls, 2, '在途期间的多次保存只合并为一次后续索引');
  console.log('index version race tests passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
