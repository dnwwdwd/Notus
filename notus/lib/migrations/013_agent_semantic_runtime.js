module.exports = {
  version: 13,
  up(db) {
    db.exec(`
      ALTER TABLE agent_checkpoints ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE agent_checkpoints ADD COLUMN tool_result_projection_version INTEGER NOT NULL DEFAULT 0;
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_turn_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
        task_id INTEGER REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        parent_frame_id INTEGER REFERENCES agent_turn_frames(id) ON DELETE SET NULL,
        frame_version INTEGER NOT NULL DEFAULT 1 CHECK(frame_version >= 1),
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version >= 1),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','superseded','cancelled')),
        change_reason TEXT NOT NULL DEFAULT 'initial',
        facts_json TEXT NOT NULL DEFAULT '{}',
        intent_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0 CHECK(confidence >= 0 AND confidence <= 1),
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, frame_version)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_turn_frames_conversation
        ON agent_turn_frames(conversation_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_turn_frames_session
        ON agent_turn_frames(session_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_turn_frames_fingerprint
        ON agent_turn_frames(fingerprint);

      CREATE TABLE IF NOT EXISTS agent_task_turn_frames (
        task_id INTEGER PRIMARY KEY REFERENCES agent_task_queue(id) ON DELETE CASCADE,
        turn_frame_id INTEGER NOT NULL REFERENCES agent_turn_frames(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_task_turn_frames_frame
        ON agent_task_turn_frames(turn_frame_id);

      CREATE TABLE IF NOT EXISTS agent_runtime_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
        task_id INTEGER REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        turn_frame_id INTEGER REFERENCES agent_turn_frames(id) ON DELETE SET NULL,
        run_id TEXT,
        execution_segment_id INTEGER,
        request_window_id INTEGER,
        actor TEXT NOT NULL CHECK(actor IN ('runtime','model','user','system')),
        fact_type TEXT NOT NULL,
        tool_call_id TEXT,
        invocation_key TEXT,
        model_visible INTEGER NOT NULL DEFAULT 0 CHECK(model_visible IN (0,1)),
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_facts_session_order
        ON agent_runtime_facts(session_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_facts_frame_order
        ON agent_runtime_facts(turn_frame_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_facts_tool_call
        ON agent_runtime_facts(tool_call_id, fact_type, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_facts_invocation
        ON agent_runtime_facts(invocation_key, id ASC);

      CREATE TABLE IF NOT EXISTS agent_tool_result_artifacts (
        id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
        task_id INTEGER REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        turn_frame_id INTEGER REFERENCES agent_turn_frames(id) ON DELETE SET NULL,
        tool_call_id TEXT NOT NULL,
        invocation_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('runtime','model')),
        relative_path TEXT UNIQUE,
        content_type TEXT NOT NULL DEFAULT 'application/json+gzip',
        sha256 TEXT,
        original_bytes INTEGER NOT NULL DEFAULT 0 CHECK(original_bytes >= 0),
        stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK(stored_bytes >= 0),
        redaction_version INTEGER NOT NULL DEFAULT 1 CHECK(redaction_version >= 1),
        status TEXT NOT NULL CHECK(status IN ('ready','archive_failed','quota_exceeded','corrupt')),
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, invocation_key)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tool_result_artifacts_conversation
        ON agent_tool_result_artifacts(conversation_id, id);
      CREATE INDEX IF NOT EXISTS idx_agent_tool_result_artifacts_tool_call
        ON agent_tool_result_artifacts(tool_call_id);
    `);
  },
  down() {
    // 语义运行层使用加法迁移；降级时通过运行模式忽略新表，不删除用户的任务事实。
  },
};
