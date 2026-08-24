const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function buildTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notus-conversation-delete-'));
}

function runTests() {
  const tempDir = buildTempWorkspace();
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempDir;
  process.env.NOTUS_DATA_DIR = tempDir;

  [
    '../lib/db',
    '../lib/config',
    '../lib/conversations',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const { getDb } = require('../lib/db');
  const {
    createConversation,
    appendConversationMessage,
    deleteConversation,
    getConversation,
    getConversationMessages,
  } = require('../lib/conversations');

  const db = getDb();
  db.exec('DELETE FROM messages; DELETE FROM conversations;');

  const conversation = createConversation({
    kind: 'knowledge',
    title: '待删除会话',
  });
  appendConversationMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '第一条消息',
  });
  appendConversationMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '第二条消息',
  });

  assert.strictEqual(getConversationMessages(conversation.id).length, 2);
  assert.strictEqual(deleteConversation(conversation.id), true);
  assert.strictEqual(getConversation(conversation.id), null);
  assert.deepStrictEqual(getConversationMessages(conversation.id), []);
  assert.strictEqual(deleteConversation(conversation.id), false);

  console.log('conversation delete tests passed');
}

runTests();
