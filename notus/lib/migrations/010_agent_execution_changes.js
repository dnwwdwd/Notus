function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

module.exports = {
  version: 10,
  up(db, helpers = {}) {
    const exists = helpers.tableExists || tableExists;
    const columnExists = helpers.hasColumn || hasColumn;
    if (!exists(db, 'agent_sessions')) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_execution_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        sequence_no INTEGER NOT NULL,
        loop_index INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'requesting',
        label TEXT NOT NULL DEFAULT '',
        tool_names_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        UNIQUE(session_id, sequence_no)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_execution_segments_session
        ON agent_execution_segments(session_id, sequence_no ASC);

      CREATE TABLE IF NOT EXISTS agent_llm_request_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_segment_id INTEGER NOT NULL REFERENCES agent_execution_segments(id) ON DELETE CASCADE,
        window_no INTEGER NOT NULL,
        run_id TEXT,
        llm_config_id TEXT,
        status TEXT NOT NULL DEFAULT 'requesting',
        retry_attempts INTEGER NOT NULL DEFAULT 0,
        retry_limit INTEGER NOT NULL DEFAULT 0,
        error_category TEXT,
        error_code TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        UNIQUE(execution_segment_id, window_no)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_llm_windows_segment
        ON agent_llm_request_windows(execution_segment_id, window_no ASC);

      CREATE TABLE IF NOT EXISTS agent_task_change_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        approval_mode TEXT NOT NULL DEFAULT 'auto_confirm',
        status TEXT NOT NULL DEFAULT 'empty',
        current_operation_set_id INTEGER REFERENCES canvas_operation_sets(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_task_change_sets_conversation
        ON agent_task_change_sets(conversation_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_task_change_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        change_set_id INTEGER NOT NULL REFERENCES agent_task_change_sets(id) ON DELETE CASCADE,
        resource_key TEXT NOT NULL,
        resource_kind TEXT NOT NULL DEFAULT 'file',
        base_exists INTEGER NOT NULL DEFAULT 0,
        base_path TEXT NOT NULL DEFAULT '',
        base_hash TEXT NOT NULL DEFAULT '',
        base_content TEXT NOT NULL DEFAULT '',
        applied_exists INTEGER NOT NULL DEFAULT 0,
        applied_path TEXT NOT NULL DEFAULT '',
        applied_hash TEXT NOT NULL DEFAULT '',
        applied_content TEXT NOT NULL DEFAULT '',
        pending_exists INTEGER NOT NULL DEFAULT 0,
        pending_path TEXT NOT NULL DEFAULT '',
        pending_hash TEXT NOT NULL DEFAULT '',
        pending_content TEXT NOT NULL DEFAULT '',
        base_manifest_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        first_batch_no INTEGER NOT NULL DEFAULT 0,
        last_batch_no INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(change_set_id, resource_key)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_task_change_items_set
        ON agent_task_change_items(change_set_id, last_batch_no ASC, id ASC);

      CREATE TABLE IF NOT EXISTS agent_operation_resolutions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        operation_set_id INTEGER NOT NULL UNIQUE REFERENCES canvas_operation_sets(id) ON DELETE CASCADE,
        resolution TEXT NOT NULL,
        tool_result_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'resolved',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_operation_resolutions_session
        ON agent_operation_resolutions(session_id, created_at ASC);
    `);

    if (exists(db, 'canvas_operation_sets')) {
      [
        ['task_change_set_id', 'INTEGER REFERENCES agent_task_change_sets(id) ON DELETE SET NULL'],
        ['execution_segment_id', 'INTEGER REFERENCES agent_execution_segments(id) ON DELETE SET NULL'],
        ['batch_sequence_no', 'INTEGER NOT NULL DEFAULT 0'],
        ['tool_use_id', 'TEXT'],
      ].forEach(([column, definition]) => {
        if (!columnExists(db, 'canvas_operation_sets', column)) {
          db.exec(`ALTER TABLE canvas_operation_sets ADD COLUMN ${column} ${definition};`);
        }
      });
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_canvas_operation_sets_change_set
          ON canvas_operation_sets(task_change_set_id, batch_sequence_no ASC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_operation_sets_session_tool_use
          ON canvas_operation_sets(agent_session_id, tool_use_id)
          WHERE agent_session_id IS NOT NULL AND tool_use_id IS NOT NULL AND tool_use_id <> '';
      `);
    }

    if (exists(db, 'agent_checkpoints')) {
      [
        ['phase', "TEXT NOT NULL DEFAULT 'before_llm'"],
        ['execution_segment_id', 'INTEGER REFERENCES agent_execution_segments(id) ON DELETE SET NULL'],
        ['llm_request_window_id', 'INTEGER REFERENCES agent_llm_request_windows(id) ON DELETE SET NULL'],
        ['tool_results_json', "TEXT NOT NULL DEFAULT '[]'"],
        ['next_tool_index', 'INTEGER NOT NULL DEFAULT 0'],
        ['pending_operation_set_id', 'INTEGER REFERENCES canvas_operation_sets(id) ON DELETE SET NULL'],
        ['resume_tool_result_json', 'TEXT'],
      ].forEach(([column, definition]) => {
        if (!columnExists(db, 'agent_checkpoints', column)) {
          db.exec(`ALTER TABLE agent_checkpoints ADD COLUMN ${column} ${definition};`);
        }
      });
    }

  },
  down() {
    // SQLite 增量迁移保留历史执行与变更数据。
  },
};
