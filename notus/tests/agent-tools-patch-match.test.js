const assert = require('assert');
const { alignPatchOldText } = require('../lib/agentTools');

function runTests() {
  const current = [
    '# 标题',
    '',
    '第一段保留。',
    '',
    '第二段  中间有两个空格。',
    '第三段继续。',
  ].join('\n');

  const whitespaceMismatch = alignPatchOldText(current, '第二段 中间有两个空格。 第三段继续。');
  assert.strictEqual(whitespaceMismatch.ok, true);
  assert.strictEqual(whitespaceMismatch.strategy, 'collapsed_whitespace');
  assert.strictEqual(whitespaceMismatch.old, '第二段  中间有两个空格。\n第三段继续。');
  assert.strictEqual(current.includes(whitespaceMismatch.old), true);

  const trimmed = alignPatchOldText(current, '\r\n第一段保留。\r\n');
  assert.strictEqual(trimmed.ok, true);
  assert.strictEqual(trimmed.old, '第一段保留。');

  const crlfCurrent = '第一段\r\n第二段  继续';
  const crlfAligned = alignPatchOldText(crlfCurrent, '第一段\n第二段 继续');
  assert.strictEqual(crlfAligned.ok, true);
  assert.strictEqual(crlfAligned.old, '第一段\r\n第二段  继续');
  assert.strictEqual(crlfCurrent.includes(crlfAligned.old), true);

  const ambiguous = alignPatchOldText('A  B C\n\nA B  C', 'A B C');
  assert.strictEqual(ambiguous.ok, false);
  assert.strictEqual(ambiguous.reason, 'OLD_MATCH_NOT_UNIQUE');

  console.log('agent tools patch match tests passed');
}

runTests();
