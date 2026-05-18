const assert = require('assert');

const {
  extractVisiblePrimaryHeading,
  mergeEditorVisibleMarkdown,
  normalizeFileNameBase,
  rewriteVisibleMarkdownPrimaryHeading,
  splitEditorVisibleMarkdown,
} = require('../lib/markdownMeta');

function runTests() {
  const source = [
    '---',
    'id: "notus_123456"',
    '---',
    '',
    '# 新文档',
    '',
    '正文内容',
  ].join('\n');

  const hidden = splitEditorVisibleMarkdown(source);
  assert.strictEqual(hidden.visibleContent, '# 新文档\n\n正文内容');
  assert.strictEqual(hidden.hiddenFrontmatter, '---\nid: "notus_123456"\n---\n');
  assert.deepStrictEqual(hidden.hiddenFrontmatterData, { id: 'notus_123456' });

  const merged = mergeEditorVisibleMarkdown(hidden.visibleContent, hidden.hiddenFrontmatter);
  assert.strictEqual(merged, source);
  assert.strictEqual(extractVisiblePrimaryHeading(merged), '新文档');
  assert.strictEqual(normalizeFileNameBase('  新文档 / Draft.md  '), '新文档 Draft');

  const userFrontmatter = [
    '---',
    'title: "公开标题"',
    'tags: ["笔记"]',
    '---',
    '',
    '# 正文',
  ].join('\n');
  const visible = splitEditorVisibleMarkdown(userFrontmatter);
  assert.strictEqual(visible.visibleContent, userFrontmatter);
  assert.strictEqual(visible.hiddenFrontmatter, '');

  const rewritten = rewriteVisibleMarkdownPrimaryHeading(userFrontmatter, '更新后的标题');
  assert.strictEqual(rewritten, [
    '---',
    'title: "公开标题"',
    'tags: ["笔记"]',
    '---',
    '',
    '# 更新后的标题',
  ].join('\n'));

  const inserted = rewriteVisibleMarkdownPrimaryHeading('正文第一段\n\n正文第二段', '补出的标题');
  assert.strictEqual(inserted, '# 补出的标题\n\n正文第一段\n\n正文第二段');

  console.log('markdown meta editor visibility tests passed');
}

runTests();
