const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function buildTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notus-db-migration-'));
}

function seedLegacyDatabase(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      title TEXT,
      hash TEXT,
      indexed INTEGER DEFAULT 0,
      indexed_at TEXT,
      index_error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      position INTEGER NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      heading_path TEXT,
      has_image INTEGER DEFAULT 0,
      search_text TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      file_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`
    INSERT INTO files (path, title, hash, indexed, indexed_at, updated_at)
    VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run('typora_files/legacy-note.md', 'Legacy Note', 'legacy-hash');
  db.close();
}

function runTests() {
  const tempDir = buildTempWorkspace();
  const dbPath = path.join(tempDir, 'notus.db');
  const notesDir = path.join(tempDir, 'notes');
  fs.mkdirSync(path.join(notesDir, 'typora_files'), { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'typora_files', 'legacy-note.md'), '# Legacy Note\n\nhello', 'utf8');
  seedLegacyDatabase(dbPath);

  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempDir;

  [
    '../lib/db',
    '../lib/config',
    '../lib/files',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const { getDb } = require('../lib/db');
  const { getAllFiles } = require('../lib/files');
  const db = getDb();
  const fileColumns = db.prepare('PRAGMA table_info(files)').all().map((row) => row.name);
  const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all().map((row) => row.name);
  const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map((row) => row.name);
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name);
  const agentSessionColumns = db.prepare('PRAGMA table_info(agent_sessions)').all().map((row) => row.name);
  const files = getAllFiles();

  [
    'stable_id',
    'size',
    'mtime',
    'char_count',
    'token_count',
    'frontmatter',
    'tags',
    'heading_outline',
    'index_version',
  ].forEach((column) => assert.ok(fileColumns.includes(column), `missing files.${column}`));

  ['source_hash', 'index_version'].forEach((column) => {
    assert.ok(chunkColumns.includes(column), `missing chunks.${column}`);
  });

  ['kind', 'draft_key', 'read_scope', 'retrieval_scope', 'write_scope', 'style_scope'].forEach((column) => {
    assert.ok(conversationColumns.includes(column), `missing conversations.${column}`);
  });

  assert.ok(messageColumns.includes('meta'), 'missing messages.meta');
  assert.ok(messageColumns.includes('type'), 'missing messages.type');
  ['web_search_enabled', 'web_search_provider', 'web_search_mode', 'web_search_count', 'tool_profile'].forEach((column) => {
    assert.ok(agentSessionColumns.includes(column), `missing agent_sessions.${column}`);
  });
  const conversationId = db.prepare("INSERT INTO conversations (kind, title) VALUES ('canvas', '系统消息测试')").run().lastInsertRowid;
  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO messages (conversation_id, role, type, content)
      VALUES (?, 'system', 'parsed_attachment', '已解析内容')
    `).run(conversationId);
  });
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].path, 'typora_files/legacy-note.md');

  console.log('legacy db migration tests passed');
}

runTests();
