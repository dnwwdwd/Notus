const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function runTests() {
  const editorSource = read('components/Editor/WysiwygEditor.js');
  const overlaySource = read('components/ui/ImagePreviewOverlay.js');
  const agentSource = read('components/AgentWorkspace/AgentWorkspace.js');
  const styleSource = read('styles/globals.css');

  [
    'ImagePreviewOverlay',
    'collectEditorImages',
    "event.target.closest('.ProseMirror img')",
  ].forEach((snippet) => {
    assert.ok(
      editorSource.includes(snippet),
      `WysiwygEditor should include ${snippet}`
    );
  });

  [
    "event.key === 'ArrowLeft'",
    "event.key === 'ArrowRight'",
    "event.key === 'Escape'",
    'document.body.style.overflow = \'hidden\'',
    'createPortal(',
  ].forEach((snippet) => {
    assert.ok(
      overlaySource.includes(snippet),
      `ImagePreviewOverlay should include ${snippet}`
    );
  });

  [
    'const openImagePreview = useCallback',
    'onPreview={openImagePreview}',
    '<ImagePreviewOverlay',
    'aria-label={canPreview ? `预览图片：${fileName}`',
  ].forEach((snippet) => {
    assert.ok(
      agentSource.includes(snippet),
      `AgentWorkspace should include ${snippet} for queued image preview support`
    );
  });

  [
    '.notus-image-preview',
    '.notus-image-preview-nav',
    '.notus-image-preview-image',
  ].forEach((snippet) => {
    assert.ok(
      styleSource.includes(snippet),
      `globals.css should include ${snippet}`
    );
  });

  console.log('editor image preview support tests passed');
}

runTests();
