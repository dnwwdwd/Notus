import { normalizeText } from './documentNavigation';

const VIEW_POSITION_STORAGE_KEY = 'notus-view-position-v1';
const EDITOR_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,blockquote,ul,ol,li,pre,td,th';
const CANVAS_BLOCK_SELECTOR = '[data-canvas-block-id]';

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
  const normalizedFileId = Number(fileId);
  if (!Number.isFinite(normalizedFileId) || normalizedFileId <= 0) return null;
  return `${normalizedPage}:file:${normalizedFileId}`;
}

function readEntry(page, fileId) {
  const key = buildViewPositionKey(page, fileId);
  if (!key) return null;
  const map = getStorageMap();
  return map[key] || null;
}

function writeEntry(page, fileId, entry) {
  const key = buildViewPositionKey(page, fileId);
  if (!key) return;
  const map = getStorageMap();
  map[key] = entry;
  writeStorageMap(map);
}

function captureEditorAnchor(container) {
  if (!container) return null;
  const candidates = [...container.querySelectorAll(EDITOR_SELECTOR)];
  const top = container.scrollTop;
  const offset = top + Math.max(container.clientHeight * 0.35, 64);
  let anchor = null;

  for (const node of candidates) {
    const nodeTop = node.offsetTop;
    if (nodeTop <= offset) {
      const text = normalizeText(node.textContent);
      if (!text) continue;
      anchor = {
        text,
        tagName: node.tagName,
      };
    }
  }

  return anchor;
}

function findEditorAnchorNode(container, anchor) {
  if (!container || !anchor?.text) return null;
  const targetText = normalizeText(anchor.text);
  const candidates = [...container.querySelectorAll(EDITOR_SELECTOR)];
  let best = null;

  for (const node of candidates) {
    const text = normalizeText(node.textContent);
    if (!text) continue;
    if (text === targetText) return node;
    if (text.includes(targetText) || targetText.includes(text)) {
      if (!best || text.length < normalizeText(best.textContent).length) {
        best = node;
      }
    }
  }

  return best;
}

function captureCanvasAnchor(container) {
  if (!container) return null;
  const blocks = [...container.querySelectorAll(CANVAS_BLOCK_SELECTOR)];
  const top = container.scrollTop;
  const offset = top + Math.max(container.clientHeight * 0.35, 64);
  let anchor = null;

  for (const node of blocks) {
    const nodeTop = node.offsetTop;
    if (nodeTop <= offset) {
      const blockId = String(node.getAttribute('data-canvas-block-id') || '').trim();
      if (!blockId) continue;
      anchor = {
        blockId,
        offsetWithinBlock: Math.max(top - nodeTop, 0),
        preview: normalizeText(node.textContent).slice(0, 80),
      };
    }
  }

  return anchor;
}

function findCanvasBlockNode(container, anchor) {
  if (!container || !anchor?.blockId) return null;
  const blockId = String(anchor.blockId);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return container.querySelector(`${CANVAS_BLOCK_SELECTOR}[data-canvas-block-id="${CSS.escape(blockId)}"]`);
  }
  return [...container.querySelectorAll(CANVAS_BLOCK_SELECTOR)]
    .find((node) => String(node.getAttribute('data-canvas-block-id') || '') === blockId) || null;
}

function restoreScrollContainer(container, top) {
  if (!container) return false;
  const nextTop = Math.max(Number(top) || 0, 0);
  container.scrollTop = nextTop;
  return true;
}

export function readViewPosition(page, fileId) {
  return readEntry(page, fileId);
}

export function writeEditorViewPosition(page, fileId, container) {
  if (!container) return null;
  const payload = {
    kind: 'editor',
    scrollTop: Math.max(Number(container.scrollTop) || 0, 0),
    anchor: captureEditorAnchor(container),
    updatedAt: Date.now(),
  };
  writeEntry(page, fileId, payload);
  return payload;
}

export function restoreEditorViewPosition(page, fileId, container) {
  const entry = readEntry(page, fileId);
  if (!entry || entry.kind !== 'editor' || !container) return false;

  const anchorNode = findEditorAnchorNode(container, entry.anchor);
  if (anchorNode) {
    container.scrollTop = Math.max(anchorNode.offsetTop - 56, 0);
    return true;
  }

  return restoreScrollContainer(container, entry.scrollTop);
}

export function writeCanvasViewPosition(fileId, container) {
  if (!container) return null;
  const payload = {
    kind: 'canvas',
    scrollTop: Math.max(Number(container.scrollTop) || 0, 0),
    anchor: captureCanvasAnchor(container),
    updatedAt: Date.now(),
  };
  writeEntry('canvas', fileId, payload);
  return payload;
}

export function restoreCanvasViewPosition(fileId, container) {
  const entry = readEntry('canvas', fileId);
  if (!entry || entry.kind !== 'canvas' || !container) return false;

  const anchorNode = findCanvasBlockNode(container, entry.anchor);
  if (anchorNode) {
    const offset = Math.max(Number(entry.anchor?.offsetWithinBlock) || 0, 0);
    container.scrollTop = Math.max(anchorNode.offsetTop + offset - 24, 0);
    return true;
  }

  return restoreScrollContainer(container, entry.scrollTop);
}
