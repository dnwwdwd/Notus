const assert = require('assert');

const {
  normalizePositiveId,
  shouldSyncCanvasQueryFile,
  shouldKeepCanvasRoutePending,
} = require('../lib/canvasRouting');

function runTests() {
  assert.strictEqual(normalizePositiveId('12'), 12);
  assert.strictEqual(normalizePositiveId(0), null);
  assert.strictEqual(normalizePositiveId('abc'), null);

  assert.strictEqual(shouldSyncCanvasQueryFile({
    requestedFileId: 18,
    activeFileId: 12,
    articleFileId: 12,
    pendingRouteFileId: null,
  }), true);

  assert.strictEqual(shouldSyncCanvasQueryFile({
    requestedFileId: 18,
    activeFileId: 12,
    articleFileId: 12,
    pendingRouteFileId: 24,
  }), false);

  assert.strictEqual(shouldSyncCanvasQueryFile({
    requestedFileId: 18,
    activeFileId: 18,
    articleFileId: 12,
    pendingRouteFileId: null,
  }), false);

  assert.strictEqual(shouldSyncCanvasQueryFile({
    requestedFileId: 18,
    activeFileId: 12,
    articleFileId: 18,
    pendingRouteFileId: null,
  }), false);

  assert.strictEqual(shouldKeepCanvasRoutePending({
    pendingRouteFileId: 18,
    articleFileId: 12,
  }), true);

  assert.strictEqual(shouldKeepCanvasRoutePending({
    pendingRouteFileId: 18,
    articleFileId: 18,
  }), false);

  console.log('canvas routing tests passed');
}

runTests();
