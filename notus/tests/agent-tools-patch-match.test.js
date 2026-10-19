const assert = require('assert');
const { alignPatchOldText, buildOldNotFoundDiagnostics } = require('../lib/agentTools');

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

  // OLD_NOT_FOUND 诊断：能定位 not_found 行的最近原文行，found 行给出当前行号
  const diagnostics = buildOldNotFoundDiagnostics(current, '第二段中间被改写的句子。\n第三段继续。');
  assert.strictEqual(diagnostics.file_hash.length, 64);
  assert.strictEqual(diagnostics.current_lines, 6);
  assert.strictEqual(diagnostics.lines.length, 2);
  assert.strictEqual(diagnostics.lines[0].status, 'not_found');
  assert.strictEqual(diagnostics.lines[0].nearest_current_line, 5);
  assert.ok(diagnostics.lines[0].similarity > 0);
  assert.ok(diagnostics.lines[0].nearest_excerpt.includes('第二段'));
  assert.strictEqual(diagnostics.lines[1].status, 'found');
  assert.strictEqual(diagnostics.lines[1].current_line, 6);
  assert.ok(diagnostics.hint.includes('read_file'));

  console.log('agent tools patch match tests passed');
}

runTests();
