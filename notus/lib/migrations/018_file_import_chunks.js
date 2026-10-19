function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

module.exports = {
  version: 18,
  up(db, helpers = {}) {
    const exists = helpers.tableExists || tableExists;
    if (exists(db, 'file_import_chunks')) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_import_chunks (
        job_id       TEXT NOT NULL,
        item_key     TEXT NOT NULL,
        chunk_index  INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        bytes        INTEGER NOT NULL DEFAULT 0,
        digest       TEXT NOT NULL DEFAULT '',
        created_at   TEXT DEFAULT (datetime('now')),
        updated_at   TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (job_id, item_key, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_file_import_chunks_updated
        ON file_import_chunks(updated_at DESC);
    `);
  },
  down() {
    // 分片记录是断点续传的依据，迁移不做破坏性回滚。
  },
};
