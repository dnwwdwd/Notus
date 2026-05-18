const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function runTests() {
  const editorSource = read('components/Editor/WysiwygEditor.js');
  const toolbarSource = read('components/Editor/EditorToolbar.js');
  const tooltipSource = read('components/ui/Tooltip.js');
  const filesPageSource = read('pages/files/index.js');

  [
    'function getClipboardImageFile',
    'function readFileAsDataUrl',
    'const imageFile = getClipboardImageFile(event);',
    'readFileAsDataUrl(imageFile)',
    'chain.setImage({',
    'allowBase64: true',
  ].forEach((snippet) => {
    assert.ok(
      editorSource.includes(snippet),
      `WysiwygEditor should include ${snippet} for clipboard image paste support`
    );
  });

  [
    "document.addEventListener('pointerdown', close, true)",
    'onPointerDown={() => setOpen(false)}',
    'onClick={() => setOpen(false)}',
  ].forEach((snippet) => {
    assert.ok(
      tooltipSource.includes(snippet),
      `Tooltip should include ${snippet} so click-triggered controls close the tooltip`
    );
  });

  [
    "{ value: 'h1', label: 'H1' }",
    "{ value: 'h2', label: 'H2' }",
    "{ value: 'h3', label: 'H3' }",
  ].forEach((snippet) => {
    assert.ok(
      toolbarSource.includes(snippet),
      `EditorToolbar should include ${snippet}`
    );
  });

  [
    "const TOC_HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';",
    'querySelectorAll(TOC_HEADING_SELECTOR)',
    "node.type?.name !== 'heading'",
    'Number(node.attrs?.level)',
  ].forEach((snippet) => {
    assert.ok(
      filesPageSource.includes(snippet),
      `files/index.js should include ${snippet} for H1-H6 TOC support`
    );
  });

  console.log('editor image paste and toc support tests passed');
}

runTests();
