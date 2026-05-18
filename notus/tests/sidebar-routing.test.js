const assert = require('assert');

const { shouldSelectCreatedFileInContext } = require('../lib/sidebarRouting');

function runTests() {
  assert.strictEqual(shouldSelectCreatedFileInContext({
    navigateOnFileSelect: true,
    hasRequestAction: false,
  }), true);

  assert.strictEqual(shouldSelectCreatedFileInContext({
    navigateOnFileSelect: true,
    hasRequestAction: true,
  }), false);

  assert.strictEqual(shouldSelectCreatedFileInContext({
    navigateOnFileSelect: false,
    hasRequestAction: true,
  }), false);

  assert.strictEqual(shouldSelectCreatedFileInContext({
    navigateOnFileSelect: false,
    hasRequestAction: false,
  }), false);

  console.log('sidebar routing tests passed');
}

runTests();
