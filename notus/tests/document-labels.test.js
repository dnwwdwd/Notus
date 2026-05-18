const assert = require('assert');

const { getVisibleDocumentLabel, isTechnicalDocumentLabel } = require('../lib/documentLabels');

function runTests() {
  assert.strictEqual(isTechnicalDocumentLabel('article_123'), true);
  assert.strictEqual(isTechnicalDocumentLabel('notus_abc123'), true);
  assert.strictEqual(isTechnicalDocumentLabel('真实标题'), false);

  assert.strictEqual(
    getVisibleDocumentLabel({ title: '公开标题', name: 'article_123.md', path: 'drafts/article_123.md' }),
    '公开标题'
  );

  assert.strictEqual(
    getVisibleDocumentLabel({ title: 'article_123', name: 'my-note.md', path: 'drafts/my-note.md' }),
    'my-note'
  );

  assert.strictEqual(
    getVisibleDocumentLabel({ title: 'article_123', name: 'article_123.md', path: 'drafts/article_123.md' }),
    '未命名文档'
  );

  console.log('document label tests passed');
}

runTests();
