module.exports = {
  version: 7,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        event_type TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_run_events_session
        ON agent_run_events(session_id, id ASC);
    `);
  },
  down() {
    // 时间线属于任务恢复数据，SQLite 增量迁移不自动删除。
  },
};
