const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'components/AgentWorkspace/FileAgentWorkspace.js'), 'utf8');
const {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  normalizeConversationId,
  readActiveConversationId,
  saveActiveConversationId,
} = require('../utils/activeConversationPersistence');

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) || null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};

assert.equal(normalizeConversationId('42'), 42);
assert.equal(normalizeConversationId('0'), null);
assert.equal(normalizeConversationId('not-an-id'), null);
saveActiveConversationId(42, storage);
assert.equal(values.get(ACTIVE_CONVERSATION_STORAGE_KEY), '42');
assert.equal(readActiveConversationId(storage), 42);
saveActiveConversationId(null, storage);
assert.equal(readActiveConversationId(storage), null);
assert.ok(source.includes("from '../../utils/activeConversationPersistence'"));
assert.ok(source.includes('await loadConversation(savedId);'));
assert.ok(source.includes('saveActiveConversationId(null);'));
assert.ok(source.includes('setPersistedActiveConversationId(null);'));

console.log('conversation persistence tests passed');
