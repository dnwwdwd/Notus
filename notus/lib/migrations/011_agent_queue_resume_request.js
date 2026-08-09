function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

module.exports = {
  version: 11,
  up(db, helpers = {}) {
    const exists = helpers.tableExists || tableExists;
    const columnExists = helpers.hasColumn || hasColumn;
    if (!exists(db, 'agent_task_queue') || columnExists(db, 'agent_task_queue', 'resume_requested')) return;
    db.exec('ALTER TABLE agent_task_queue ADD COLUMN resume_requested INTEGER NOT NULL DEFAULT 0;');
  },
  down() {
    // SQLite 增量迁移保留历史队列数据。
  },
};
