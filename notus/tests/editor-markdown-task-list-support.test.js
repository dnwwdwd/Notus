const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

async function runTests() {
  const editorSource = read('components/Editor/WysiwygEditor.js');
  const helperSource = read('lib/editorMarkdownTaskList.js');
  const helper = await import('../lib/editorMarkdownTaskList.js');

  [
    "import { extractMarkdownTaskList } from '../../lib/editorMarkdownTaskList';",
    'function shouldPreferMarkdownTaskListPaste(event) {',
    'extractMarkdownTaskList(plainText)',
    'Markdown task list paste failed, fallback to default paste handling.',
    'replaceSelection(slice)',
  ].forEach((snippet) => {
    assert.ok(
      editorSource.includes(snippet),
      `WysiwygEditor should include ${snippet} for markdown task list paste support`
    );
  });

  [
    'const TASK_LIST_LINE_PATTERN',
    'function extractMarkdownTaskList(text = \'\') {',
    'function normalizeTaskListLine(line = \'\') {',
  ].forEach((snippet) => {
    assert.ok(
      helperSource.includes(snippet),
      `editorMarkdownTaskList helper should include ${snippet}`
    );
  });

  assert.strictEqual(
    helper.extractMarkdownTaskList('- [ ] 第一项\n- [x] 第二项'),
    '- [ ] 第一项\n- [x] 第二项',
    '任务列表源码应被识别为 markdown task list'
  );

  assert.strictEqual(
    helper.extractMarkdownTaskList('1. [ ] 第一项\n2. [x] 第二项'),
    '1. [ ] 第一项\n2. [x] 第二项',
    '有序任务列表源码应被识别为 markdown task list'
  );

  assert.strictEqual(
    helper.extractMarkdownTaskList('- 普通列表\n- [ ] 混合内容'),
    null,
    '普通列表和任务列表混杂时不应误判为完整任务列表'
  );

  console.log('editor markdown task list support tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
