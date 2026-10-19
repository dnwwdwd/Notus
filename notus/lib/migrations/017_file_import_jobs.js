function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

module.exports = {
  version: 17,
  up(db, helpers = {}) {
    const exists = helpers.tableExists || tableExists;
    if (exists(db, 'file_import_jobs')) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_import_jobs (
        job_id         TEXT NOT NULL,
        item_key       TEXT NOT NULL,
        parent_path    TEXT NOT NULL DEFAULT '',
        name           TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'imported',
        path           TEXT NOT NULL DEFAULT '',
        warning        TEXT NOT NULL DEFAULT '',
        warning_code   TEXT NOT NULL DEFAULT '',
        created_at     TEXT DEFAULT (datetime('now')),
        updated_at     TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (job_id, item_key)
      );
      CREATE INDEX IF NOT EXISTS idx_file_import_jobs_updated
        ON file_import_jobs(updated_at DESC);
    `);
  },
  down() {
    // 作业记录是幂等重试的恢复依据，迁移不做破坏性回滚。
  },
};
