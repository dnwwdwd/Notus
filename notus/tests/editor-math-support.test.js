const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function runTests() {
  const editorSource = read('components/Editor/WysiwygEditor.js');
  const previewSource = read('components/Editor/MarkdownPreview.js');
  const streamingSource = read('components/ui/StreamingText.js');
  const globalStyles = read('styles/globals.css');
  const packageJson = JSON.parse(read('package.json'));

  assert.ok(
    packageJson.dependencies['@tiptap/extension-mathematics'],
    'package.json should declare @tiptap/extension-mathematics'
  );
  assert.ok(
    packageJson.dependencies['remark-math'],
    'package.json should declare remark-math'
  );

  [
    'Mathematics.configure',
    "output: 'htmlAndMathml'",
    'inlineOptions',
    'blockOptions',
    "openMathDialog('inline'",
    "openMathDialog('block'",
    'updateInlineMath',
    'updateBlockMath',
  ].forEach((snippet) => {
    assert.ok(
      editorSource.includes(snippet),
      `WysiwygEditor should include ${snippet} for editable KaTeX math support`
    );
  });

  [
    'handlePaste',
    'MATH_MARKDOWN_PASTE_PATTERN',
    'shouldPreferMarkdownMathPaste',
    'pasteMarkdownAsSlice',
    "clipboardData.getData('text/html')",
    "clipboardData.getData('text/plain')",
    'DOMParser.fromSchema',
    'replaceSelection(slice)',
  ].forEach((snippet) => {
    assert.ok(
      editorSource.includes(snippet),
      `WysiwygEditor should include ${snippet} for first-paste math Markdown handling`
    );
  });

  [
    'remarkMath',
    'rehypeKatex',
    'remarkPlugins={[remarkGfm, remarkMath]}',
  ].forEach((snippet) => {
    assert.ok(
      previewSource.includes(snippet),
      `MarkdownPreview should include ${snippet}`
    );
    assert.ok(
      streamingSource.includes(snippet),
      `StreamingText should include ${snippet}`
    );
  });

  [
    '.tiptap-mathematics-render',
    '[data-type="block-math"]',
    '[data-type="inline-math"]',
  ].forEach((snippet) => {
    assert.ok(
      globalStyles.includes(snippet),
      `globals.css should style ${snippet}`
    );
  });

  console.log('editor math support tests passed');
}

runTests();
