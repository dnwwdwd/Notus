module.exports = {
  version: 15,
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_conversation_context (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      covered_message_id INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  },
  down() {},
};
