const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { readEnvConfig } = require('./config');
const {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  deriveLlmConfigBudgetFields,
  getKnownModelBudget,
} = require('./llmBudget');
const agentLoopMigration = require('./migrations/005_agent_loop');
const agentControlPlaneMigration = require('./migrations/006_agent_control_plane');
const agentRunTimelineMigration = require('./migrations/007_agent_run_timeline');
const agentTaskQueueMigration = require('./migrations/008_agent_task_queue');
const orphanVectorCleanupMigration = require('./migrations/009_cleanup_orphan_vectors');
const agentExecutionChangesMigration = require('./migrations/010_agent_execution_changes');
const agentQueueResumeRequestMigration = require('./migrations/011_agent_queue_resume_request');
const agentResumeJobBindingMigration = require('./migrations/012_agent_resume_job_binding');
const agentSemanticRuntimeMigration = require('./migrations/013_agent_semantic_runtime');
const agentCheckpointProjectionColumnsMigration = require('./migrations/014_agent_checkpoint_projection_columns');

let db = null;
let vecAvailable = false;
let initError = null;
let schemaReady = false;

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadVecExtension(database) {
  sqliteVec.load(database);
  database.prepare('SELECT vec_version() AS version').get();
  vecAvailable = true;
}

function createVecTable(database, dim) {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}] distance_metric=cosine
    );
  `);
}

function createImageVecTable(database, dim) {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS images_vec USING vec0(
      image_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}] distance_metric=cosine
    );
  `);
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function tableExists(database, table) {
  const row = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  [agentLoopMigration, agentControlPlaneMigration, agentRunTimelineMigration, agentTaskQueueMigration, orphanVectorCleanupMigration, agentExecutionChangesMigration, agentQueueResumeRequestMigration, agentResumeJobBindingMigration, agentSemanticRuntimeMigration, agentCheckpointProjectionColumnsMigration].forEach((migration) => {
    const version = Number(migration.version);
    if (!Number.isFinite(version) || version <= 0 || typeof migration.up !== 'function') return;
    const applied = database.prepare('SELECT version FROM schema_version WHERE version = ?').get(version);
    if (applied) return;
    database.transaction(() => {
      migration.up(database, { hasColumn, tableExists });
      database.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, datetime(\'now\'))').run(version);
    })();
  });
}

function ensureAgentLoopSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id          INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      status                   TEXT NOT NULL DEFAULT 'pending',
      goal                     TEXT NOT NULL,
      authorized_paths         TEXT NOT NULL DEFAULT '[]',
      authorized_ops           TEXT NOT NULL DEFAULT '["modify","create"]',
      created_files            TEXT NOT NULL DEFAULT '[]',
      loop_count               INTEGER NOT NULL DEFAULT 0,
      soft_limit               INTEGER NOT NULL DEFAULT 15,
      hard_limit               INTEGER NOT NULL DEFAULT 30,
      search_knowledge_limit   INTEGER,
      web_search_enabled       INTEGER NOT NULL DEFAULT 0,
      web_search_provider      TEXT,
      web_search_mode          TEXT,
      web_search_count         INTEGER,
      tool_profile             TEXT NOT NULL DEFAULT 'default',
      tool_call_counts         TEXT NOT NULL DEFAULT '{}',
      consecutive_fails        TEXT NOT NULL DEFAULT '{}',
      last_tool_results        TEXT NOT NULL DEFAULT '{}',
      research_state_json      TEXT NOT NULL DEFAULT '{}',
      messages_checkpoint      TEXT,
      checkpoint_tool_use_id   TEXT,
      waiting_since            TEXT,
      session_token            TEXT UNIQUE NOT NULL,
      expires_at               TEXT,
      created_at               TEXT DEFAULT (datetime('now')),
      updated_at               TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_status_updated
      ON agent_sessions(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation
      ON agent_sessions(conversation_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      file_path    TEXT NOT NULL,
      content      TEXT NOT NULL,
      file_hash    TEXT NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_session
      ON agent_snapshots(session_id);

    CREATE TABLE IF NOT EXISTS agent_run_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      loop_index   INTEGER NOT NULL,
      tool_name    TEXT,
      tool_input   TEXT,
      tool_result  TEXT,
      thinking     TEXT,
      status       TEXT NOT NULL DEFAULT 'success',
      duration_ms  INTEGER,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_runlogs_session
      ON agent_run_logs(session_id, loop_index);

    CREATE TABLE IF NOT EXISTS agent_research_receipts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      source_type    TEXT NOT NULL,
      phase          TEXT NOT NULL DEFAULT '',
      query          TEXT NOT NULL DEFAULT '',
      source_title   TEXT NOT NULL DEFAULT '',
      source_ref     TEXT NOT NULL DEFAULT '',
      provider       TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'success',
      result_count   INTEGER NOT NULL DEFAULT 0,
      duration_ms    INTEGER NOT NULL DEFAULT 0,
      content_hash   TEXT NOT NULL DEFAULT '',
      error_code     TEXT NOT NULL DEFAULT '',
      summary        TEXT NOT NULL DEFAULT '',
      details_json   TEXT NOT NULL DEFAULT '{}',
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_research_receipts_session
      ON agent_research_receipts(session_id, id ASC);
    CREATE INDEX IF NOT EXISTS idx_agent_research_receipts_conversation
      ON agent_research_receipts(conversation_id, id ASC);
  `);

  [
    ['web_search_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['web_search_provider', 'TEXT'],
    ['web_search_mode', 'TEXT'],
    ['web_search_count', 'INTEGER'],
    ['tool_profile', "TEXT NOT NULL DEFAULT 'default'"],
    ['research_state_json', "TEXT NOT NULL DEFAULT '{}'"],
  ].forEach(([column, definition]) => {
    if (!hasColumn(database, 'agent_sessions', column)) {
      database.exec(`ALTER TABLE agent_sessions ADD COLUMN ${column} ${definition};`);
    }
  });

  if (tableExists(database, 'canvas_operation_sets')) {
    [
      ['revision_type', 'TEXT'],
      ['revision_file_path', 'TEXT'],
      ['revision_base_hash', 'TEXT'],
      ['revision_draft_hash', 'TEXT'],
      ['revision_applied_hash', 'TEXT'],
      ['revision_base_content', 'TEXT'],
      ['revision_draft_content', 'TEXT'],
      ['revision_error', 'TEXT'],
      ['revision_parent_id', 'INTEGER'],
      ['revision_sequence_no', 'INTEGER NOT NULL DEFAULT 0'],
      ['revision_applied_at', 'TEXT'],
      ['revision_discarded_at', 'TEXT'],
      ['revision_rolled_back_at', 'TEXT'],
      ['media_changes_json', "TEXT NOT NULL DEFAULT '[]'"],
    ].forEach(([column, definition]) => {
      if (!hasColumn(database, 'canvas_operation_sets', column)) {
        database.exec(`ALTER TABLE canvas_operation_sets ADD COLUMN ${column} ${definition};`);
      }
    });
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_canvas_operation_sets_revision_file
        ON canvas_operation_sets(conversation_id, revision_type, revision_file_path, status, updated_at DESC);
    `);
  }
}

function ensureAgentLoopIndexes(database) {
  if (tableExists(database, 'canvas_operation_sets') && hasColumn(database, 'canvas_operation_sets', 'agent_session_id')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_canvas_operation_sets_agent_session
        ON canvas_operation_sets(agent_session_id, status, updated_at DESC);
    `);
  }
}

function ensureSkillMcpSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS skill_roots (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, real_path TEXT, scope TEXT NOT NULL,
      providers_json TEXT NOT NULL, writable INTEGER NOT NULL DEFAULT 0,
      managed_by_notus INTEGER NOT NULL DEFAULT 0, watch_enabled INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES skill_roots(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', directory_path TEXT NOT NULL,
      real_path TEXT, skill_md_path TEXT NOT NULL, frontmatter_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL, validation_errors_json TEXT NOT NULL DEFAULT '[]', content_hash TEXT,
      source_label TEXT, managed INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(root_id, directory_path)
    );
    CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
    CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
    CREATE TABLE IF NOT EXISTS skill_installations (
      id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      method TEXT NOT NULL, repository_url TEXT, repository_ref TEXT, repository_commit TEXT,
      repository_subdirectory TEXT, archive_sha256 TEXT, draft_id TEXT, installed_hash TEXT NOT NULL,
      installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_user_state (
      owner_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1, priority_override INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(owner_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS skill_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, progress INTEGER NOT NULL DEFAULT 0,
      input_json TEXT NOT NULL DEFAULT '{}', result_json TEXT, error_code TEXT, error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS skill_drafts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL,
      files_json TEXT NOT NULL DEFAULT '[]', validation_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL, tool_policy_json TEXT NOT NULL,
      last_test_status TEXT, last_test_at TEXT, last_error_code TEXT, last_error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_id, name)
    );
    CREATE TABLE IF NOT EXISTS mcp_tool_cache (
      server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE, tool_name TEXT NOT NULL,
      description TEXT, input_schema_json TEXT NOT NULL, schema_hash TEXT NOT NULL, discovered_at TEXT NOT NULL,
      PRIMARY KEY(server_id, tool_name)
    );
    CREATE TABLE IF NOT EXISTS mcp_audit_logs (
      id TEXT PRIMARY KEY, server_id TEXT, action TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS external_mcp_tokens (
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1, approval_mode TEXT NOT NULL DEFAULT 'manual', permissions_json TEXT NOT NULL DEFAULT '[]',
      last_used_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS external_mcp_changes (
      id TEXT PRIMARY KEY, token_id TEXT REFERENCES external_mcp_tokens(id) ON DELETE SET NULL,
      token_name TEXT NOT NULL, tool_name TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', error_code TEXT, error_message TEXT,
      applied_at TEXT, rejected_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_external_mcp_changes_status
      ON external_mcp_changes(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS external_mcp_audit_logs (
      id TEXT PRIMARY KEY, token_id TEXT, tool_name TEXT NOT NULL, status TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_external_mcp_audit_token
      ON external_mcp_audit_logs(token_id, created_at DESC);
  `);
  try { db.exec("ALTER TABLE skill_drafts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'"); } catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
  [
    ['skill_mentions_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['mcp_selection_json', "TEXT NOT NULL DEFAULT '{\"mode\":\"off\"}'"],
    ['mcp_session_permissions_json', "TEXT NOT NULL DEFAULT '{}'"],
  ].forEach(([column, definition]) => {
    if (!hasColumn(database, 'agent_sessions', column)) {
      database.exec(`ALTER TABLE agent_sessions ADD COLUMN ${column} ${definition};`);
    }
  });
}

function ensureConversationIndexes(database) {
  if (!hasColumn(database, 'conversations', 'kind') || !hasColumn(database, 'conversations', 'updated_at')) {
    return;
  }

  if (hasColumn(database, 'conversations', 'file_id')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_kind_file_updated
        ON conversations(kind, file_id, updated_at DESC);
    `);
  }

  if (hasColumn(database, 'conversations', 'draft_key')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_kind_draft_updated
        ON conversations(kind, draft_key, updated_at DESC);
    `);
  }
}

function messageRoleAllowsSystem(database) {
  if (!tableExists(database, 'messages')) return true;
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  const sql = String(row?.sql || '');
  return /role\s+IN\s*\([^)]*system/i.test(sql) || /'system'/.test(sql);
}

function ensureMessagesSchema(database) {
  if (!tableExists(database, 'messages')) return;

  const hasType = hasColumn(database, 'messages', 'type');
  const needsRoleRebuild = !messageRoleAllowsSystem(database);

  if (!needsRoleRebuild) {
    if (!hasType) {
      database.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text';");
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_attachment
        ON messages(conversation_id, type)
        WHERE type = 'parsed_attachment';
      CREATE INDEX IF NOT EXISTS idx_messages_web_search_context
        ON messages(conversation_id, id)
        WHERE type = 'web_search_context';
    `);
    return;
  }

  const selectType = hasType ? "COALESCE(type, 'text')" : "'text'";
  database.exec('PRAGMA foreign_keys = OFF;');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS messages_next (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        type            TEXT NOT NULL DEFAULT 'text',
        content         TEXT NOT NULL,
        citations       TEXT,
        meta            TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      );
    `);
    database.exec(`
      INSERT INTO messages_next (id, conversation_id, role, type, content, citations, meta, created_at)
      SELECT
        id,
        conversation_id,
        CASE WHEN role IN ('user','assistant','tool','system') THEN role ELSE 'user' END,
        ${selectType},
        content,
        citations,
        meta,
        created_at
      FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_next RENAME TO messages;
    `);
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_attachment
      ON messages(conversation_id, type)
      WHERE type = 'parsed_attachment';
    CREATE INDEX IF NOT EXISTS idx_messages_web_search_context
      ON messages(conversation_id, id)
      WHERE type = 'web_search_context';
  `);
}

function migrateRegularTables(database) {
  const chunkColumns = [
    ['type', "TEXT NOT NULL DEFAULT 'paragraph'"],
    ['position', 'INTEGER NOT NULL DEFAULT 0'],
    ['has_image', 'INTEGER NOT NULL DEFAULT 0'],
    ['search_text', "TEXT NOT NULL DEFAULT ''"],
    ['source_hash', 'TEXT'],
    ['index_version', 'INTEGER NOT NULL DEFAULT 1'],
  ];

  chunkColumns.forEach(([column, definition]) => {
    if (!hasColumn(database, 'chunks', column)) {
      database.exec(`ALTER TABLE chunks ADD COLUMN ${column} ${definition};`);
    }
  });

  const fileColumns = [
    ['index_error', 'TEXT'],
    ['retry_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['stable_id', 'TEXT'],
    ['size', 'INTEGER NOT NULL DEFAULT 0'],
    ['mtime', 'INTEGER NOT NULL DEFAULT 0'],
    ['char_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['token_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['frontmatter', 'TEXT'],
    ['tags', 'TEXT'],
    ['heading_outline', 'TEXT'],
    ['index_version', 'INTEGER NOT NULL DEFAULT 1'],
  ];

  fileColumns.forEach(([column, definition]) => {
    if (!hasColumn(database, 'files', column)) {
      database.exec(`ALTER TABLE files ADD COLUMN ${column} ${definition};`);
    }
  });

  const imageColumns = [
    ['alt_text', 'TEXT'],
    ['cache_status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['cache_error', 'TEXT'],
    ['mime_type', 'TEXT'],
    ['content_length', 'INTEGER'],
    ['cached_at', 'TEXT'],
    ['embedding_status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['embedding_error', 'TEXT'],
    ['embedded_at', 'TEXT'],
  ];

  imageColumns.forEach(([column, definition]) => {
    if (!hasColumn(database, 'images', column)) {
      database.exec(`ALTER TABLE images ADD COLUMN ${column} ${definition};`);
    }
  });

  const conversationColumns = [
    ['draft_key', 'TEXT'],
    ['read_scope', 'TEXT'],
    ['retrieval_scope', 'TEXT'],
    ['write_scope', 'TEXT'],
    ['style_scope', 'TEXT'],
  ];

  conversationColumns.forEach(([column, definition]) => {
    if (!hasColumn(database, 'conversations', column)) {
      database.exec(`ALTER TABLE conversations ADD COLUMN ${column} ${definition};`);
    }
  });

  const llmConfigColumns = [
    ['api_protocol', "TEXT NOT NULL DEFAULT 'openai'"],
    ['context_window_tokens', `INTEGER NOT NULL DEFAULT ${DEFAULT_CONTEXT_WINDOW_TOKENS}`],
    ['max_output_tokens', `INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_OUTPUT_TOKENS}`],
  ];

  llmConfigColumns.forEach(([column, definition]) => {
    if (!hasColumn(database, 'llm_configs', column)) {
      database.exec(`ALTER TABLE llm_configs ADD COLUMN ${column} ${definition};`);
    }
  });

  const messageColumns = [
    ['meta', 'TEXT'],
    ['type', "TEXT NOT NULL DEFAULT 'text'"],
  ];

  messageColumns.forEach(([column, definition]) => {
    if (!hasColumn(database, 'messages', column)) {
      database.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition};`);
    }
  });

  if (!hasColumn(database, 'files', 'hash')) {
    database.exec("ALTER TABLE files ADD COLUMN hash TEXT;");
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_web_search_context
      ON messages(conversation_id, id)
      WHERE type = 'web_search_context';
  `);

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_files_stable_id
      ON files(stable_id)
      WHERE stable_id IS NOT NULL AND stable_id != '';
    CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_chunks_source_hash ON chunks(source_hash);
    CREATE INDEX IF NOT EXISTS idx_chunks_index_version ON chunks(index_version);
  `);

  database.prepare(`
    UPDATE chunks
    SET source_hash = (
      SELECT files.hash FROM files WHERE files.id = chunks.file_id
    )
    WHERE (source_hash IS NULL OR source_hash = '')
      AND EXISTS (SELECT 1 FROM files WHERE files.id = chunks.file_id)
  `).run();

  const rows = database.prepare(`
    SELECT id, model, context_window_tokens, max_output_tokens
    FROM llm_configs
  `).all();
  const updateBudget = database.prepare(`
    UPDATE llm_configs
    SET context_window_tokens = ?, max_output_tokens = ?
    WHERE id = ?
  `);

  rows.forEach((row) => {
    const knownBudget = getKnownModelBudget(row.model);
    const derived = deriveLlmConfigBudgetFields({
      model: row.model,
      context_window_tokens: knownBudget ? null : row.context_window_tokens,
      max_output_tokens: knownBudget ? null : row.max_output_tokens,
    });
    if (
      Number(row.context_window_tokens) !== Number(derived.context_window_tokens)
      || Number(row.max_output_tokens) !== Number(derived.max_output_tokens)
    ) {
      updateBudget.run(derived.context_window_tokens, derived.max_output_tokens, row.id);
    }
  });
}

function migrateIncompatibleTables(database) {
  if (!hasColumn(database, 'images', 'chunk_id')) {
    database.exec(`
      DROP TABLE IF EXISTS images;
      CREATE TABLE images (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id     INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        url          TEXT NOT NULL,
        status       TEXT DEFAULT 'pending',
        caption      TEXT,
        local_path   TEXT,
        processed_at TEXT,
        alt_text     TEXT,
        cache_status TEXT NOT NULL DEFAULT 'pending',
        cache_error  TEXT,
        mime_type    TEXT,
        content_length INTEGER,
        cached_at    TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending',
        embedding_error TEXT,
        embedded_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
    `);
  }

  const conversationId = database.prepare('PRAGMA table_info(conversations)').all()
    .find((row) => row.name === 'id');
  if (conversationId && !/INTEGER/i.test(conversationId.type || '')) {
    database.exec(`
      DROP TABLE IF EXISTS canvas_operation_sets;
      DROP TABLE IF EXISTS conversation_interactions;
    `);
    database.exec(`
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS conversations;

      CREATE TABLE conversations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        title      TEXT,
        file_id    INTEGER REFERENCES files(id) ON DELETE SET NULL,
        draft_key  TEXT,
        read_scope TEXT,
        retrieval_scope TEXT,
        write_scope TEXT,
        style_scope TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        type            TEXT NOT NULL DEFAULT 'text',
        content         TEXT NOT NULL,
        citations       TEXT,
        meta            TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    `);
  }
}

function recreateFts(database) {
  database.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
    DROP TABLE IF EXISTS chunks_fts;

    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content,
      search_text,
      tokenize='unicode61'
    );

    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, search_text)
      VALUES (new.id, new.content, new.search_text);
    END;

    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
      INSERT INTO chunks_fts(rowid, content, search_text)
      VALUES (new.id, new.content, new.search_text);
    END;

    INSERT INTO chunks_fts(rowid, content, search_text)
    SELECT id, content, search_text FROM chunks;
  `);
}

function recreateFilesFts(database) {
  database.exec(`
    DROP TRIGGER IF EXISTS files_ai;
    DROP TRIGGER IF EXISTS files_ad;
    DROP TRIGGER IF EXISTS files_au;
    DROP TABLE IF EXISTS files_fts;

    CREATE VIRTUAL TABLE files_fts USING fts5(
      title,
      path,
      tokenize='unicode61'
    );

    CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, title, path)
      VALUES (new.id, new.title, new.path);
    END;

    CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
      DELETE FROM files_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER files_au AFTER UPDATE ON files BEGIN
      DELETE FROM files_fts WHERE rowid = old.id;
      INSERT INTO files_fts(rowid, title, path)
      VALUES (new.id, new.title, new.path);
    END;

    INSERT INTO files_fts(rowid, title, path)
    SELECT
      id,
      title,
      path
    FROM files;
  `);
}

function ensureSchema(database, config) {
  migrateRegularTables(database);
  migrateIncompatibleTables(database);
  ensureConversationIndexes(database);
  ensureMessagesSchema(database);
  ensureAgentLoopSchema(database);
  ensureSkillMcpSchema(database);
  runMigrations(database);
  ensureAgentLoopIndexes(database);
  createVecTable(database, config.embeddingDim);
  createImageVecTable(database, config.embeddingDim);
  recreateFts(database);
  recreateFilesFts(database);
  schemaReady = true;
}

function initDb() {
  const config = readEnvConfig();
  if (db) {
    if (!schemaReady) {
      ensureSchema(db, config);
    }
    return db;
  }

  try {
    ensureParentDir(config.dbPath);
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    loadVecExtension(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT UNIQUE NOT NULL,
        title       TEXT,
        stable_id   TEXT,
        hash        TEXT,
        size        INTEGER NOT NULL DEFAULT 0,
        mtime       INTEGER NOT NULL DEFAULT 0,
        char_count  INTEGER NOT NULL DEFAULT 0,
        token_count INTEGER NOT NULL DEFAULT 0,
        frontmatter TEXT,
        tags        TEXT,
        heading_outline TEXT,
        index_version INTEGER NOT NULL DEFAULT 1,
        indexed     INTEGER DEFAULT 0,
        indexed_at  TEXT,
        index_error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_files_indexed ON files(indexed);

      CREATE TABLE IF NOT EXISTS chunks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        content      TEXT NOT NULL,
        type         TEXT NOT NULL,
        position     INTEGER NOT NULL,
        line_start   INTEGER,
        line_end     INTEGER,
        heading_path TEXT,
        has_image    INTEGER DEFAULT 0,
        search_text  TEXT NOT NULL DEFAULT '',
        source_hash  TEXT,
        index_version INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_position ON chunks(file_id, position);

      CREATE TABLE IF NOT EXISTS images (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id     INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        url          TEXT NOT NULL,
        status       TEXT DEFAULT 'pending',
        caption      TEXT,
        local_path   TEXT,
        processed_at TEXT,
        alt_text     TEXT,
        cache_status TEXT NOT NULL DEFAULT 'pending',
        cache_error  TEXT,
        mime_type    TEXT,
        content_length INTEGER,
        cached_at    TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending',
        embedding_error TEXT,
        embedded_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);

      CREATE TABLE IF NOT EXISTS conversations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        title      TEXT,
        file_id    INTEGER REFERENCES files(id) ON DELETE SET NULL,
        draft_key  TEXT,
        read_scope TEXT,
        retrieval_scope TEXT,
        write_scope TEXT,
        style_scope TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        type            TEXT NOT NULL DEFAULT 'text',
        content         TEXT NOT NULL,
        citations       TEXT,
        meta            TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS llm_configs (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT NOT NULL,
        provider             TEXT NOT NULL,
        api_protocol         TEXT NOT NULL DEFAULT 'openai',
        model                TEXT NOT NULL,
        base_url             TEXT NOT NULL,
        api_key              TEXT NOT NULL,
        context_window_tokens INTEGER NOT NULL DEFAULT ${DEFAULT_CONTEXT_WINDOW_TOKENS},
        max_output_tokens     INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_OUTPUT_TOKENS},
        is_active            INTEGER NOT NULL DEFAULT 0,
        last_test_latency_ms INTEGER,
        last_tested_at       TEXT,
        created_at           TEXT DEFAULT (datetime('now')),
        updated_at           TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_llm_configs_active ON llm_configs(is_active);
      CREATE INDEX IF NOT EXISTS idx_llm_configs_updated_at ON llm_configs(updated_at DESC);

      CREATE TABLE IF NOT EXISTS style_fingerprints (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id                INTEGER UNIQUE NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        file_hash              TEXT,
        sentence_style         TEXT,
        tone                   TEXT,
        structure              TEXT,
        vocabulary             TEXT,
        rhetoric               TEXT,
        signature_phrases_json TEXT,
        raw_response           TEXT,
        status                 TEXT NOT NULL DEFAULT 'pending',
        retry_count            INTEGER NOT NULL DEFAULT 0,
        last_error             TEXT,
        model_used             TEXT,
        created_at             TEXT DEFAULT (datetime('now')),
        updated_at             TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_style_fingerprints_status ON style_fingerprints(status, updated_at ASC);

      CREATE TABLE IF NOT EXISTS style_profile (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_json  TEXT NOT NULL,
        source_count  INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_style_profile_updated_at ON style_profile(updated_at DESC);

      CREATE TABLE IF NOT EXISTS canvas_operation_sets (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        file_id         INTEGER REFERENCES files(id) ON DELETE SET NULL,
        message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        article_hash    TEXT NOT NULL,
        mode            TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        revision_type   TEXT,
        revision_file_path TEXT,
        revision_base_hash TEXT,
        revision_draft_hash TEXT,
        revision_applied_hash TEXT,
        revision_base_content TEXT,
        revision_draft_content TEXT,
        revision_error TEXT,
        revision_parent_id INTEGER,
        revision_sequence_no INTEGER NOT NULL DEFAULT 0,
        revision_applied_at TEXT,
        revision_discarded_at TEXT,
        revision_rolled_back_at TEXT,
        media_changes_json TEXT NOT NULL DEFAULT '[]',
        expires_at      TEXT,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_canvas_operation_sets_conversation_status
        ON canvas_operation_sets(conversation_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_interactions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id        INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        kind              TEXT NOT NULL,
        source            TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        schema_version    INTEGER NOT NULL DEFAULT 1,
        reason_code       TEXT NOT NULL,
        article_hash      TEXT NOT NULL,
        payload_json      TEXT NOT NULL,
        response_json     TEXT,
        answer_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        expires_at        TEXT,
        created_at        TEXT DEFAULT (datetime('now')),
        updated_at        TEXT DEFAULT (datetime('now')),
        answered_at       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_interactions_conversation_status
        ON conversation_interactions(conversation_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversation_interactions_message
        ON conversation_interactions(message_id);
    `);

    ensureSchema(db, config);

    initError = null;
    return db;
  } catch (error) {
    schemaReady = false;
    if (db) {
      try {
        db.close();
      } catch {}
    }
    db = null;
    vecAvailable = false;
    initError = error;
    throw error;
  }
}

function getDb() {
  return initDb();
}

function isVecAvailable() {
  if (!db) {
    try {
      initDb();
    } catch {
      return false;
    }
  }
  return vecAvailable;
}

function getInitError() {
  return initError;
}

function resetVec(dim) {
  const database = getDb();
  database.exec('DROP TABLE IF EXISTS chunks_vec;');
  database.exec('DROP TABLE IF EXISTS images_vec;');
  createVecTable(database, dim);
  createImageVecTable(database, dim);
}

function getSettingsMap() {
  const database = getDb();
  const rows = database.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function getSetting(key, fallback = null) {
  const database = getDb();
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  const database = getDb();
  database.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

function setSettings(values) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  database.transaction(() => {
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        stmt.run(key, String(value));
      }
    });
  })();
}

function removeSettings(keys = []) {
  const database = getDb();
  const normalizedKeys = keys.filter(Boolean);
  if (normalizedKeys.length === 0) return;
  const stmt = database.prepare('DELETE FROM settings WHERE key = ?');
  database.transaction(() => {
    normalizedKeys.forEach((key) => stmt.run(key));
  })();
}

module.exports = {
  getDb,
  initDb,
  resetVec,
  isVecAvailable,
  getInitError,
  getSettingsMap,
  getSetting,
  setSetting,
  setSettings,
  removeSettings,
};
