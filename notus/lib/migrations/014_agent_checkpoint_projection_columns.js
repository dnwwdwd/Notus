module.exports = {
  version: 14,
  up(db, { hasColumn, tableExists } = {}) {
    const checkpointTableExists = typeof tableExists === 'function'
      ? tableExists(db, 'agent_checkpoints')
      : Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_checkpoints'").get());
    if (!checkpointTableExists) return;

    const columnExists = (column) => (typeof hasColumn === 'function'
      ? hasColumn(db, 'agent_checkpoints', column)
      : db.prepare('PRAGMA table_info(agent_checkpoints)').all().some((row) => row.name === column));

    if (!columnExists('runtime_mode')) {
      db.exec("ALTER TABLE agent_checkpoints ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'legacy';");
    }
    if (!columnExists('tool_result_projection_version')) {
      db.exec('ALTER TABLE agent_checkpoints ADD COLUMN tool_result_projection_version INTEGER NOT NULL DEFAULT 0;');
    }
  },
  down() {
    // SQLite 删除列需要重建表；降级时保留加法字段。
  },
};
