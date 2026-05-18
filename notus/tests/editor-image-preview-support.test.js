const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function runTests() {
  const editorSource = read('components/Editor/WysiwygEditor.js');
  const styleSource = read('styles/globals.css');

  [
    'ImagePreviewOverlay',
    'collectEditorImages',
    "event.key === 'ArrowLeft'",
    "event.key === 'ArrowRight'",
    "event.key === 'Escape'",
    "event.target.closest('.ProseMirror img')",
    'document.body.style.overflow = \'hidden\'',
  ].forEach((snippet) => {
    assert.ok(
      editorSource.includes(snippet),
      `WysiwygEditor should include ${snippet}`
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
