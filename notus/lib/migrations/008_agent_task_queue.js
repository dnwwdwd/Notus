module.exports = {
  version: 8,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_task_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued',
        queue_order INTEGER NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        llm_config_id TEXT,
        approval_mode TEXT NOT NULL DEFAULT 'auto_confirm',
        user_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        run_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error_json TEXT,
        started_at TEXT,
        finished_at TEXT,
        final_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_task_queue_conversation_order
        ON agent_task_queue(conversation_id, queue_order ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_task_queue_status
        ON agent_task_queue(status, updated_at ASC);
    `);
  },
  down() {
    // 队列是任务恢复的持久化依据，增量迁移不删除历史数据。
  },
};
