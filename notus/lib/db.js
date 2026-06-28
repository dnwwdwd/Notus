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

  [agentLoopMigration].forEach((migration) => {
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
  `);

  [
    ['web_search_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['web_search_provider', 'TEXT'],
    ['web_search_mode', 'TEXT'],
    ['web_search_count', 'INTEGER'],
    ['tool_profile', "TEXT NOT NULL DEFAULT 'default'"],
  ].forEach(([column, definition]) => {
    if (!hasColumn(database, 'agent_sessions', column)) {
      database.exec(`ALTER TABLE agent_sessions ADD COLUMN ${column} ${definition};`);
    }
  });
}

function ensureAgentLoopIndexes(database) {
  if (tableExists(database, 'canvas_operation_sets') && hasColumn(database, 'canvas_operation_sets', 'agent_session_id')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_canvas_operation_sets_agent_session
        ON canvas_operation_sets(agent_session_id, status, updated_at DESC);
    `);
  }
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
