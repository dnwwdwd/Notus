const assert = require('assert');
const {
  applyOperations,
} = require('../lib/diff');

function runTests() {
  const article = {
    title: '测试文章',
    blocks: [
      { id: 'b1', type: 'paragraph', content: '第一段' },
      { id: 'b2', type: 'paragraph', content: '第二段' },
      { id: 'b3', type: 'paragraph', content: '第三段' },
    ],
  };

  const success = applyOperations(article, [
    { op: 'replace', block_id: 'b1', old: '第一段', new: '第一段（已改）' },
    { op: 'delete', block_id: 'b3', old: '第三段' },
  ]);
  assert.strictEqual(success.success, true);
  assert.strictEqual(success.applied_count, 2);
  assert.strictEqual(success.article.blocks[0].content, '第一段（已改）');
  assert.strictEqual(success.article.blocks.length, 2);

  const failed = applyOperations(article, [
    { op: 'replace', block_id: 'b1', old: '错误旧内容', new: '不会成功' },
    { op: 'delete', block_id: 'b2', old: '第二段' },
  ]);
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.error, 'OLD_MISMATCH');
  assert.strictEqual(failed.failed_at, 0);
  assert.strictEqual(failed.applied_count, 0);
  assert.strictEqual(article.blocks.length, 3);
  assert.strictEqual(article.blocks[0].content, '第一段');

  const longContent = [
    '长文本块开头',
    ...Array.from({ length: 120 }).map((_, index) => `第 ${index + 1} 行内容`),
    '长文本块结尾',
  ].join('\n');
  const longArticle = {
    title: '长文本应用测试',
    blocks: [
      { id: 'b1', type: 'paragraph', content: longContent },
    ],
  };
  const longSuccess = applyOperations(longArticle, [
    {
      op: 'replace',
      block_id: 'b1',
      old: longContent,
      new: longContent.replace('第 60 行内容', '第 60 行内容（已修改）'),
    },
  ]);
  assert.strictEqual(longSuccess.success, true);
  assert.strictEqual(longSuccess.article.blocks[0].content.includes('第 59 行内容'), true);
  assert.strictEqual(longSuccess.article.blocks[0].content.includes('第 60 行内容（已修改）'), true);
  assert.strictEqual(longSuccess.article.blocks[0].content.includes('第 61 行内容'), true);

  const staleLong = applyOperations(longArticle, [
    {
      op: 'replace',
      block_id: 'b1',
      old: '长文本块开头\n[已按上下文预算截断]',
      new: '不会应用',
    },
  ]);
  assert.strictEqual(staleLong.success, false);
  assert.strictEqual(staleLong.error, 'OLD_MISMATCH');
  assert.strictEqual(longArticle.blocks[0].content, longContent);

  console.log('canvas operations tests passed');
}

runTests();
