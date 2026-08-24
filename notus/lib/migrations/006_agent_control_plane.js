function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

module.exports = {
  version: 6,
  up(db, helpers = {}) {
    const exists = helpers.tableExists || tableExists;
    const columnExists = helpers.hasColumn || hasColumn;
    if (!exists(db, 'agent_sessions')) return;

    [
      ['state_version', 'INTEGER NOT NULL DEFAULT 0'],
      ['active_run_id', 'TEXT'],
      ['lease_expires_at', 'TEXT'],
      ['cancel_requested_at', 'TEXT'],
      ['last_committed_checkpoint_id', 'INTEGER'],
      ['prompt_version', "TEXT NOT NULL DEFAULT 'agent-loop-v2'"],
      ['toolset_version', "TEXT NOT NULL DEFAULT ''"],
      ['token_budget_total', 'INTEGER'],
    ].forEach(([column, definition]) => {
      if (!columnExists(db, 'agent_sessions', column)) {
        db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${column} ${definition};`);
      }
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        messages_json TEXT NOT NULL,
        last_response_content_json TEXT NOT NULL DEFAULT '[]',
        tool_use_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        superseded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session_status
        ON agent_checkpoints(session_id, status, id DESC);

      CREATE TABLE IF NOT EXISTS agent_resume_jobs (
        id TEXT PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        interaction_id INTEGER NOT NULL REFERENCES conversation_interactions(id) ON DELETE CASCADE,
        owner_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        run_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(interaction_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_resume_jobs_session_status
        ON agent_resume_jobs(session_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_capabilities (
        nonce_hash TEXT PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        interaction_id INTEGER,
        resume_job_id TEXT,
        owner_id TEXT,
        action TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_capabilities_session_action
        ON agent_capabilities(session_id, action, expires_at DESC);

      CREATE TABLE IF NOT EXISTS agent_run_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        loop_index INTEGER,
        source_type TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_source TEXT NOT NULL DEFAULT 'provider',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_run_usage_session
        ON agent_run_usage(session_id, id ASC);
    `);

    db.prepare("UPDATE agent_sessions SET status = 'created' WHERE status = 'pending'").run();
    db.prepare("UPDATE agent_sessions SET status = 'waiting_interaction' WHERE status = 'waiting_confirm' AND checkpoint_tool_use_id IS NOT NULL").run();
    db.prepare("UPDATE agent_sessions SET status = 'waiting_limit_confirmation' WHERE status = 'waiting_confirm'").run();
  },
  down() {
    // SQLite 增量迁移不删除列和历史数据。
  },
};
