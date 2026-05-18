function normalizePositiveId(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function shouldSyncCanvasQueryFile({
  requestedFileId,
  activeFileId,
  articleFileId,
  pendingRouteFileId,
} = {}) {
  const nextRequestedFileId = normalizePositiveId(requestedFileId);
  if (!nextRequestedFileId) return false;

  const nextPendingRouteFileId = normalizePositiveId(pendingRouteFileId);
  if (nextPendingRouteFileId && nextPendingRouteFileId !== nextRequestedFileId) {
    return false;
  }

  if (nextPendingRouteFileId === nextRequestedFileId) {
    return false;
  }

  const nextActiveFileId = normalizePositiveId(activeFileId);
  const nextArticleFileId = normalizePositiveId(articleFileId);
  return nextActiveFileId !== nextRequestedFileId && nextArticleFileId !== nextRequestedFileId;
}

function shouldKeepCanvasRoutePending({ pendingRouteFileId, articleFileId } = {}) {
  const nextPendingRouteFileId = normalizePositiveId(pendingRouteFileId);
  if (!nextPendingRouteFileId) return false;
  return normalizePositiveId(articleFileId) !== nextPendingRouteFileId;
}

function stripUrlToPath(url = '') {
  const source = String(url || '');
  return source.split('#')[0].split('?')[0] || '/';
}

function shouldSuppressQueryOnlyRouteOverlay({ currentUrl, nextUrl, shallow } = {}) {
  if (!shallow) return false;
  return stripUrlToPath(currentUrl) === stripUrlToPath(nextUrl);
}

module.exports = {
  normalizePositiveId,
  shouldSyncCanvasQueryFile,
  shouldKeepCanvasRoutePending,
  stripUrlToPath,
  shouldSuppressQueryOnlyRouteOverlay,
};
