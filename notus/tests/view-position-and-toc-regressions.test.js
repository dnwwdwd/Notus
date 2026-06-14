const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function runTests() {
  const viewPosition = read('utils/viewPosition.js');
  const filesPage = read('pages/files/index.js');
  const knowledgePage = read('pages/knowledge.js');
  const canvasPage = read('pages/canvas.js');
  const canvasBlock = read('components/Canvas/CanvasBlock.js');
  const sidebar = read('components/Layout/Sidebar.js');
  const editorToc = read('hooks/useEditorToc.js');
  const documentNavigation = read('utils/documentNavigation.js');
  const aiLockedState = read('components/ui/AiLockedState.js');

  assert.ok(viewPosition.includes("return `document:file:${normalizedFileId}`;"));
  assert.ok(viewPosition.includes('viewportOffset'));
  assert.ok(viewPosition.includes('scrollProgress'));
  assert.ok(viewPosition.includes('readLatestViewPosition'));
  assert.ok(viewPosition.includes('retryRestoreViewPosition'));
  assert.ok(viewPosition.includes('requestedTop > 0 && maxScrollTop <= 0'));
  assert.ok(viewPosition.includes('const expectedTop = Math.min(Math.max(requestedTop, 0), maxScrollTop);'));
  assert.ok(viewPosition.includes('isBoundaryPrefix(nodeText, targetText)'));
  assert.ok(viewPosition.includes('left.progressDistance - right.progressDistance'));
  assert.ok(viewPosition.includes('const hasOccurrence = anchor?.occurrence !== null'));
  assert.ok(viewPosition.includes("contentNode?.tagName === 'TEXTAREA'"));
  assert.ok(canvasBlock.includes('data-canvas-block-content="true"'));
  assert.ok(documentNavigation.includes("document.querySelectorAll('.wysiwyg-root .tiptap.ProseMirror')"));

  assert.ok(filesPage.includes('window.setTimeout(savePosition'));
  assert.ok(knowledgePage.includes('window.setTimeout(savePosition'));
  assert.ok(canvasPage.includes('window.setTimeout(savePosition'));
  assert.ok(filesPage.includes("router.events.on('routeChangeStart', flushPosition)"));
  assert.ok(knowledgePage.includes("router.events.on('routeChangeStart', flushPosition)"));
  assert.ok(canvasPage.includes("router.events.on('routeChangeStart', flushPosition)"));
  assert.ok(filesPage.includes('restorePositionRef.current) return;'));
  assert.ok(knowledgePage.includes('restoreDocPositionRef.current) return;'));
  assert.ok(canvasPage.includes('restoreCanvasPositionRef.current) return;'));
  assert.ok(filesPage.includes('retryRestoreViewPosition('));
  assert.ok(knowledgePage.includes('retryRestoreViewPosition('));
  assert.ok(canvasPage.includes('retryRestoreViewPosition('));
  assert.ok(!filesPage.includes('savePositionFrameRef'));
  assert.ok(!knowledgePage.includes('saveDocPositionFrameRef'));
  assert.ok(!canvasPage.includes('saveCanvasPositionFrameRef'));

  assert.ok(!canvasPage.includes('const hasPendingRoute = Boolean(pendingRouteFileIdRef.current);'));
  assert.ok(knowledgePage.includes('tocDisabled={!activeFile || !editorOpen}'));
  assert.ok(knowledgePage.includes('tocItems={tocItems}'));
  assert.ok(knowledgePage.includes('variant="panel"'));
  assert.ok(aiLockedState.includes("variant === 'modal' || variant === 'panel'"));

  assert.ok(editorToc.includes('setActiveHeadingIndex(index);'));
  assert.ok(editorToc.includes('querySelectorAll(TOC_HEADING_SELECTOR)'));
  assert.ok(editorToc.includes('container.scrollTop = Math.max(target.offsetTop - 48, 0);'));
  assert.ok(!sidebar.includes('activeTocKey'));
  assert.ok(sidebar.includes('const selected = Boolean(t.active);'));
  assert.ok(sidebar.includes('<button'));

  console.log('view position and toc regression tests passed');
}

runTests();
