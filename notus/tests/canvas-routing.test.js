const assert = require('assert');

const {
  normalizePositiveId,
  shouldSyncCanvasQueryFile,
  shouldKeepCanvasRoutePending,
  stripUrlToPath,
  shouldSuppressQueryOnlyRouteOverlay,
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

  assert.strictEqual(stripUrlToPath('/canvas?fileId=2'), '/canvas');
  assert.strictEqual(stripUrlToPath('/canvas#draft'), '/canvas');

  assert.strictEqual(shouldSuppressQueryOnlyRouteOverlay({
    currentUrl: '/canvas?fileId=1',
    nextUrl: '/canvas?fileId=2',
    shallow: true,
  }), true);

  assert.strictEqual(shouldSuppressQueryOnlyRouteOverlay({
    currentUrl: '/canvas?fileId=1',
    nextUrl: '/knowledge?fileId=2',
    shallow: true,
  }), false);

  assert.strictEqual(shouldSuppressQueryOnlyRouteOverlay({
    currentUrl: '/canvas?fileId=1',
    nextUrl: '/canvas?fileId=2',
    shallow: false,
  }), false);

  console.log('canvas routing tests passed');
}

runTests();
