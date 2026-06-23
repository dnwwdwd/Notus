const assert = require('assert');
const { isPathSafe } = require('../lib/agentPathRules');

function runTests() {
  const currentFileAuth = ['typora_files/current.md'];
  const targetFile = 'typora_files/new-note.md';

  assert.strictEqual(isPathSafe(targetFile, currentFileAuth, 'create'), true);
  assert.strictEqual(isPathSafe(targetFile, currentFileAuth, 'modify'), false);
  assert.strictEqual(isPathSafe(targetFile, ['typora_files'], 'create'), true);
  assert.strictEqual(isPathSafe(targetFile, ['typora_files'], 'modify'), true);
  assert.strictEqual(isPathSafe(targetFile, [''], 'create'), true);
  assert.strictEqual(isPathSafe(targetFile, [''], 'modify'), true);
  assert.strictEqual(isPathSafe('other/new-note.md', currentFileAuth, 'create'), false);
  assert.strictEqual(isPathSafe('typora_files\\new-note.md', ['typora_files\\current.md'], 'create'), true);
  assert.strictEqual(isPathSafe('C:\\notes\\typora_files\\new-note.md', ['typora_files'], 'create'), false);

  console.log('agent session path tests passed');
}

runTests();
