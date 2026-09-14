const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-rebuild-dim-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, EMBEDDING_DIM: '3', NOTES_DIR: path.join(root, 'notes'), DB_PATH: path.join(root, 'test.db'), ASSETS_DIR: path.join(root, 'assets') });
const id = require.resolve('../lib/embeddings');
require.cache[id] = { id, filename: id, loaded: true, exports: { getEmbeddings: async rows => rows.map(() => [.1, .2, .3, .4]) } };
const styleId = require.resolve('../lib/style');
require.cache[styleId] = { id: styleId, filename: styleId, loaded: true, exports: { enqueueStyleExtraction() {}, setStyleBackfillPaused() {} } };
const db = require('../lib/db');
const files = require('../lib/files');
(async () => {
  try {
    files.createFile('dimension.md', '# Dimension\n\nThe vector index must follow the effective model dimensions.');
    db.setSetting('embedding_dim', '4');
    assert.ok(db.getDb().prepare("select sql from sqlite_master where name='chunks_vec'").get().sql.includes('FLOAT[3]'));
    await require('../lib/indexer').rebuildIndex();
    assert.equal(db.getDb().prepare('select indexed from files').get().indexed, 1, '全量重建应修复旧表维度与配置不一致');
    for (const name of ['chunks_vec', 'images_vec']) {
      assert.ok(db.getDb().prepare('select sql from sqlite_master where name=?').get(name).sql.includes('FLOAT[4]'));
    }
    assert.ok(fs.readFileSync(path.join(root, 'notes/dimension.md'), 'utf8').includes('effective model dimensions'));
    console.log('index rebuild dimension tests passed');
  } finally { db.closeDb(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
