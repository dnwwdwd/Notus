import { normalizeText } from './documentNavigation';

const VIEW_POSITION_STORAGE_KEY = 'notus-view-position-v1';
const EDITOR_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,blockquote,ul,ol,li,pre,td,th';
const CANVAS_BLOCK_SELECTOR = '[data-canvas-block-id]';
const ANCHOR_TEXT_LIMIT = 240;

function normalizeFileId(fileId) {
  const normalizedFileId = Number(fileId);
  return Number.isFinite(normalizedFileId) && normalizedFileId > 0
    ? normalizedFileId
    : null;
}

function getStorageMap() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(VIEW_POSITION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStorageMap(map) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VIEW_POSITION_STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

export function buildViewPositionKey(page, fileId) {
  const normalizedPage = ['files', 'knowledge', 'canvas'].includes(page) ? page : 'files';
  const normalizedFileId = normalizeFileId(fileId);
  if (!normalizedFileId) return null;
  return `${normalizedPage}:file:${normalizedFileId}`;
}

export function buildDocumentViewPositionKey(fileId) {
  const normalizedFileId = normalizeFileId(fileId);
  if (!normalizedFileId) return null;
  return `document:file:${normalizedFileId}`;
}

export function readLatestViewPosition(page, fileId) {
  const pageKey = buildViewPositionKey(page, fileId);
  const documentKey = buildDocumentViewPositionKey(fileId);
  if (!pageKey || !documentKey) return null;

  const map = getStorageMap();
  const pageEntry = map[pageKey] || null;
  const documentEntry = map[documentKey] || null;
  return !pageEntry
    ? documentEntry
    : !documentEntry
      ? pageEntry
      : Number(documentEntry.updatedAt || 0) >= Number(pageEntry.updatedAt || 0)
    ? documentEntry
    : pageEntry;
}

function writeEntry(page, fileId, entry) {
  const pageKey = buildViewPositionKey(page, fileId);
  const documentKey = buildDocumentViewPositionKey(fileId);
  if (!pageKey || !documentKey) return;

  const map = getStorageMap();
  const nextEntry = {
    ...entry,
    page,
  };
  map[pageKey] = nextEntry;
  map[documentKey] = nextEntry;
  writeStorageMap(map);
}

function getScrollProgress(container) {
  const scrollTop = Math.max(Number(container?.scrollTop) || 0, 0);
  const scrollRange = Math.max(
    (Number(container?.scrollHeight) || 0) - (Number(container?.clientHeight) || 0),
    0
  );
  if (scrollRange <= 0) return 0;
  return Math.min(Math.max(scrollTop / scrollRange, 0), 1);
}

function getNodeProgress(container, node) {
  const scrollRange = Math.max(
    (Number(container?.scrollHeight) || 0) - (Number(container?.clientHeight) || 0),
    0
  );
  if (scrollRange <= 0) return 0;
  return Math.min(Math.max((Number(node?.offsetTop) || 0) / scrollRange, 0), 1);
}

function getNodeViewportOffset(container, node) {
  if (!container || !node) return 0;
  if (typeof container.getBoundingClientRect === 'function' && typeof node.getBoundingClientRect === 'function') {
    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    if (Number.isFinite(containerRect?.top) && Number.isFinite(nodeRect?.top)) {
      return nodeRect.top - containerRect.top;
    }
  }
  return (Number(node.offsetTop) || 0) - (Number(container.scrollTop) || 0);
}

function getAnchorText(node) {
  return normalizeText(node?.textContent).slice(0, ANCHOR_TEXT_LIMIT);
}

function normalizeAnchorText(value) {
  return normalizeText(value)
    .replace(/^#\d+\s*/, '')
    .replace(/^#{1,6}\s*/, '')
    .slice(0, ANCHOR_TEXT_LIMIT);
}

function getCanvasAnchorText(node) {
  const contentNode = node?.querySelector?.('[data-canvas-block-content="true"]');
  const value = contentNode?.tagName === 'TEXTAREA'
    ? contentNode.value
    : contentNode?.textContent || node?.textContent;
  return normalizeAnchorText(value);
}

function findClosestVisibleNode(container, candidates) {
  if (!container || candidates.length === 0) return null;
  const targetOffset = Math.min(Math.max((Number(container.clientHeight) || 0) * 0.18, 48), 120);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  candidates.forEach((node) => {
    if (!getAnchorText(node)) return;
    const viewportOffset = getNodeViewportOffset(container, node);
    const nodeHeight = Math.max(Number(node.offsetHeight) || 0, 1);
    const visible = viewportOffset <= (Number(container.clientHeight) || 0)
      && viewportOffset + nodeHeight >= 0;
    const distance = Math.abs(viewportOffset - targetOffset) + (visible ? 0 : 100000);
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  });

  return best;
}

function captureEditorAnchor(container) {
  if (!container) return null;
  const candidates = [...container.querySelectorAll(EDITOR_SELECTOR)];
  const anchorNode = findClosestVisibleNode(container, candidates);
  if (!anchorNode) return null;

  const text = getAnchorText(anchorNode);
  const tagName = String(anchorNode.tagName || '').toUpperCase();
  const occurrence = candidates
    .slice(0, candidates.indexOf(anchorNode))
    .filter((node) => (
      String(node.tagName || '').toUpperCase() === tagName
      && getAnchorText(node) === text
    ))
    .length;

  return {
    text,
    tagName,
    occurrence,
    viewportOffset: getNodeViewportOffset(container, anchorNode),
  };
}

function isBoundaryPrefix(prefix, value) {
  if (!prefix || !value || !value.startsWith(prefix)) return false;
  const nextCharacter = value.slice(prefix.length, prefix.length + 1);
  return !nextCharacter || /[\s,，.。:：;；!?！？、)\]】]/.test(nextCharacter);
}

function scoreTextMatch(nodeText, targetText) {
  if (!nodeText || !targetText) return 0;
  if (nodeText === targetText) return 4;
  if (isBoundaryPrefix(nodeText, targetText) || isBoundaryPrefix(targetText, nodeText)) return 3;
  if (
    Math.min(nodeText.length, targetText.length) >= 12
    && (nodeText.includes(targetText) || targetText.includes(nodeText))
  ) return 2;
  const shortTarget = targetText.slice(0, 80);
  if (shortTarget.length >= 12 && nodeText.includes(shortTarget)) return 1;
  return 0;
}

function findEditorAnchorNode(container, anchor, scrollProgress) {
  const targetText = normalizeAnchorText(anchor?.text || anchor?.preview);
  if (!container || !targetText) return null;

  const candidates = [...container.querySelectorAll(EDITOR_SELECTOR)];
  const targetTagName = String(anchor?.tagName || '').toUpperCase();
  const targetProgress = Number(scrollProgress);
  const scored = candidates
    .map((node, index) => {
      const nodeText = getAnchorText(node);
      const textScore = scoreTextMatch(nodeText, targetText);
      const tagScore = targetTagName && String(node.tagName || '').toUpperCase() === targetTagName ? 1 : 0;
      const progressDistance = Number.isFinite(targetProgress)
        ? Math.abs(getNodeProgress(container, node) - targetProgress)
        : 0;
      return { node, index, nodeText, progressDistance, score: textScore * 10 + tagScore };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || left.progressDistance - right.progressDistance
      || left.nodeText.length - right.nodeText.length
      || left.index - right.index
    ));

  if (scored.length === 0) return null;
  const occurrenceValue = Number(anchor?.occurrence);
  const hasOccurrence = anchor?.occurrence !== null
    && anchor?.occurrence !== undefined
    && Number.isFinite(occurrenceValue);
  if (hasOccurrence) {
    const exactScore = targetTagName ? 41 : 40;
    const exactMatches = scored
      .filter((item) => item.score >= exactScore)
      .sort((left, right) => left.index - right.index);
    const occurrence = Math.max(occurrenceValue, 0);
    if (exactMatches[occurrence]) return exactMatches[occurrence].node;
  }
  return scored[0].node;
}

function captureCanvasAnchor(container) {
  if (!container) return null;
  const blocks = [...container.querySelectorAll(CANVAS_BLOCK_SELECTOR)];
  const anchorNode = findClosestVisibleNode(container, blocks);
  if (!anchorNode) return null;

  const blockId = String(anchorNode.getAttribute('data-canvas-block-id') || '').trim();
  if (!blockId) return null;

  return {
    blockId,
    text: getCanvasAnchorText(anchorNode),
    preview: getCanvasAnchorText(anchorNode).slice(0, 120),
    viewportOffset: getNodeViewportOffset(container, anchorNode),
  };
}

function findCanvasBlockNode(container, anchor, scrollProgress) {
  if (!container || !anchor) return null;
  const blockId = String(anchor.blockId || '');
  if (blockId) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      const matched = container.querySelector(`${CANVAS_BLOCK_SELECTOR}[data-canvas-block-id="${CSS.escape(blockId)}"]`);
      if (matched) return matched;
    }
    const matched = [...container.querySelectorAll(CANVAS_BLOCK_SELECTOR)]
      .find((node) => String(node.getAttribute('data-canvas-block-id') || '') === blockId);
    if (matched) return matched;
  }

  const targetText = normalizeAnchorText(anchor.text || anchor.preview);
  if (!targetText) return null;
  const targetProgress = Number(scrollProgress);
  const scored = [...container.querySelectorAll(CANVAS_BLOCK_SELECTOR)]
    .map((node, index) => {
      const nodeText = getCanvasAnchorText(node);
      const progressDistance = Number.isFinite(targetProgress)
        ? Math.abs(getNodeProgress(container, node) - targetProgress)
        : 0;
      return {
        node,
        index,
        nodeText,
        progressDistance,
        score: scoreTextMatch(nodeText, targetText),
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || left.progressDistance - right.progressDistance
      || left.nodeText.length - right.nodeText.length
      || left.index - right.index
    ));
  return scored[0]?.node || null;
}

function setContainerScrollTop(container, top) {
  if (!container) return false;
  const requestedTop = Math.max(Number(top) || 0, 0);
  const maxScrollTop = Math.max(
    (Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0),
    0
  );
  if (requestedTop > 0 && maxScrollTop <= 0) return false;
  const nextTop = Math.min(requestedTop, maxScrollTop);
  container.scrollTop = nextTop;
  return true;
}

function restoreAnchor(container, node, anchor, legacyTop) {
  if (!container || !node) return false;
  const viewportOffset = Number(anchor?.viewportOffset);
  if (Number.isFinite(viewportOffset)) {
    const currentOffset = getNodeViewportOffset(container, node);
    const requestedTop = (Number(container.scrollTop) || 0) + currentOffset - viewportOffset;
    const maxScrollTop = Math.max(
      (Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0),
      0
    );
    const expectedTop = Math.min(Math.max(requestedTop, 0), maxScrollTop);
    const applied = setContainerScrollTop(container, requestedTop);
    if (!applied) return false;
    return Math.abs((Number(container.scrollTop) || 0) - expectedTop) <= 2;
  }
  return setContainerScrollTop(container, legacyTop(node, anchor));
}

function restoreScrollFallback(container, entry) {
  const scrollProgress = Number(entry?.scrollProgress);
  if (Number.isFinite(scrollProgress)) {
    const scrollRange = Math.max(
      (Number(container?.scrollHeight) || 0) - (Number(container?.clientHeight) || 0),
      0
    );
    return setContainerScrollTop(container, scrollRange * Math.min(Math.max(scrollProgress, 0), 1));
  }
  return setContainerScrollTop(container, entry?.scrollTop);
}

export function readViewPosition(page, fileId) {
  return readLatestViewPosition(page, fileId);
}

export function retryRestoreViewPosition(restore, options = {}) {
  if (typeof window === 'undefined' || typeof restore !== 'function') return () => {};
  const maxAttempts = Math.max(Number(options.maxAttempts) || 20, 1);
  let cancelled = false;
  let frameId = null;
  let attempts = 0;

  const run = () => {
    if (cancelled) return;
    attempts += 1;
    const restored = restore();
    if (restored || attempts >= maxAttempts) {
      options.onComplete?.(restored);
      return;
    }
    frameId = window.requestAnimationFrame(run);
  };

  frameId = window.requestAnimationFrame(run);
  return () => {
    cancelled = true;
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
    }
  };
}

export function writeEditorViewPosition(page, fileId, container) {
  if (!container) return null;
  const payload = {
    kind: 'editor',
    scrollTop: Math.max(Number(container.scrollTop) || 0, 0),
    scrollProgress: getScrollProgress(container),
    anchor: captureEditorAnchor(container),
    updatedAt: Date.now(),
  };
  writeEntry(page, fileId, payload);
  return payload;
}

export function restoreEditorViewPosition(page, fileId, container) {
  const entry = readLatestViewPosition(page, fileId);
  if (!entry || !container) return false;

  const anchorNode = findEditorAnchorNode(container, entry.anchor, entry.scrollProgress);
  if (anchorNode) {
    return restoreAnchor(
      container,
      anchorNode,
      entry.anchor,
      (node) => Math.max((Number(node.offsetTop) || 0) - 56, 0)
    );
  }

  return restoreScrollFallback(container, entry);
}

export function writeCanvasViewPosition(fileId, container) {
  if (!container) return null;
  const payload = {
    kind: 'canvas',
    scrollTop: Math.max(Number(container.scrollTop) || 0, 0),
    scrollProgress: getScrollProgress(container),
    anchor: captureCanvasAnchor(container),
    updatedAt: Date.now(),
  };
  writeEntry('canvas', fileId, payload);
  return payload;
}

export function restoreCanvasViewPosition(fileId, container) {
  const entry = readLatestViewPosition('canvas', fileId);
  if (!entry || !container) return false;

  const anchorNode = findCanvasBlockNode(container, entry.anchor, entry.scrollProgress);
  if (anchorNode) {
    return restoreAnchor(
      container,
      anchorNode,
      entry.anchor,
      (node, anchor) => (
        Math.max(
          (Number(node.offsetTop) || 0) + Math.max(Number(anchor?.offsetWithinBlock) || 0, 0) - 24,
          0
        )
      )
    );
  }

  return restoreScrollFallback(container, entry);
}
