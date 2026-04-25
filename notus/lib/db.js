const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { readEnvConfig } = require('./config');

let db = null;
let vecAvailable = false;
let initError = null;

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

function migrateRegularTables(database) {
  const chunkColumns = [
    ['type', "TEXT NOT NULL DEFAULT 'paragraph'"],
    ['position', 'INTEGER NOT NULL DEFAULT 0'],
    ['has_image', 'INTEGER NOT NULL DEFAULT 0'],
    ['search_text', "TEXT NOT NULL DEFAULT ''"],
  ];

  chunkColumns.forEach(([column, definition]) => {
    if (!hasColumn(database, 'chunks', column)) {
      database.exec(`ALTER TABLE chunks ADD COLUMN ${column} ${definition};`);
    }
  });

  const fileColumns = [
    ['index_error', 'TEXT'],
    ['retry_count', 'INTEGER NOT NULL DEFAULT 0'],
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
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS conversations;

      CREATE TABLE conversations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        title      TEXT,
        file_id    INTEGER REFERENCES files(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
        content         TEXT NOT NULL,
        citations       TEXT,
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

function initDb() {
  if (db) return db;

  const config = readEnvConfig();
  ensureParentDir(config.dbPath);

  try {
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
        hash        TEXT,
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
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
        content         TEXT NOT NULL,
        citations       TEXT,
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
        model                TEXT NOT NULL,
        base_url             TEXT NOT NULL,
        api_key              TEXT NOT NULL,
        is_active            INTEGER NOT NULL DEFAULT 0,
        last_test_latency_ms INTEGER,
        last_tested_at       TEXT,
        created_at           TEXT DEFAULT (datetime('now')),
        updated_at           TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_llm_configs_active ON llm_configs(is_active);
      CREATE INDEX IF NOT EXISTS idx_llm_configs_updated_at ON llm_configs(updated_at DESC);
    `);

    migrateRegularTables(db);
    migrateIncompatibleTables(db);
    createVecTable(db, config.embeddingDim);
    createImageVecTable(db, config.embeddingDim);
    recreateFts(db);

    initError = null;
    return db;
  } catch (error) {
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
