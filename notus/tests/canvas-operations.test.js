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

  console.log('canvas operations tests passed');
}

runTests();
