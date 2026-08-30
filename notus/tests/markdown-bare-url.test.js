const assert = require('assert');

async function runTests() {
  const { splitBareUrlLabel } = await import('../utils/markdownLinks.js');
  assert.deepStrictEqual(splitBareUrlLabel('https://example.com，也不会访问。'), {
    url: 'https://example.com',
    suffix: '，也不会访问。',
  });
  assert.deepStrictEqual(splitBareUrlLabel('https://example.com/path？确认'), {
    url: 'https://example.com/path',
    suffix: '？确认',
  });
  assert.strictEqual(splitBareUrlLabel('产品说明，包含链接'), null);
  assert.strictEqual(splitBareUrlLabel('https://example.com/path?x=1'), null);
  console.log('markdown bare url tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
