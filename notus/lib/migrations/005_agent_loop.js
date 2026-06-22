function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

module.exports = {
  version: 5,
  up(db, helpers = {}) {
    const exists = helpers.tableExists || tableExists;
    const columnExists = helpers.hasColumn || hasColumn;
    if (!exists(db, 'canvas_operation_sets')) return;
    if (!columnExists(db, 'canvas_operation_sets', 'agent_session_id')) {
      db.prepare('ALTER TABLE canvas_operation_sets ADD COLUMN agent_session_id INTEGER').run();
    }
    if (!columnExists(db, 'canvas_operation_sets', 'pathes_json')) {
      db.prepare('ALTER TABLE canvas_operation_sets ADD COLUMN pathes_json TEXT').run();
    }
  },
  down() {
    // SQLite 旧版本不支持安全 DROP COLUMN，回滚保持 no-op。
  },
};
