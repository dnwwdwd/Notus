const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

async function runTests() {
  const clipboardSource = read('utils/editorClipboard.js');
  const toolbarSource = read('components/Editor/EditorToolbar.js');
  const iconsSource = read('components/ui/Icons.js');
  const clipboardHelper = await import('../utils/editorClipboard.js');

  [
    'navigator.clipboard?.write',
    'window.ClipboardItem',
    "'text/html'",
    "'text/plain'",
    'data-notus-src',
    'content-image?src=',
    'cloneNode(true)',
    'FileReader',
    'document.execCommand(\'copy\')',
  ].forEach((snippet) => {
    assert.ok(
      clipboardSource.includes(snippet),
      `editorClipboard.js should include ${snippet}`
    );
  });

  [
    'copyEditorContentToClipboard',
    '复制全文',
    '已复制全文，包含文字和图片',
    "setCopiedAll(true)",
    "setCopiedAll(false)",
    'window.setTimeout(() => {',
    '图片未写入剪贴板',
    "result.mode === 'rich'",
  ].forEach((snippet) => {
    assert.ok(
      toolbarSource.includes(snippet),
      `EditorToolbar should include ${snippet}`
    );
  });

  assert.ok(
    iconsSource.includes('copy: (p) =>'),
    'Icons.js should include a copy icon for the full-document clipboard action'
  );

  assert.strictEqual(
    clipboardHelper.isLocalClipboardImageSource('assets/images/demo.png'),
    true,
    'relative asset paths should be treated as local clipboard images'
  );
  assert.strictEqual(
    clipboardHelper.isLocalClipboardImageSource('https://example.com/demo.png'),
    false,
    'absolute remote image URLs should not be treated as local clipboard images'
  );
  assert.strictEqual(
    clipboardHelper.isLocalClipboardImageSource('/api/files/1/content-image?src=assets%2Fimages%2Fdemo.png'),
    false,
    'preview API URLs should not be treated as local clipboard images'
  );

  console.log('editor copy all support tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
