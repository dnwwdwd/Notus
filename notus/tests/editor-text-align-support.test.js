const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function runTests() {
  const editorSource = read('components/Editor/WysiwygEditor.js');
  const toolbarSource = read('components/Editor/EditorToolbar.js');
  const extensionSource = read('components/Editor/TextAlignCenterExtension.js');
  const styleSource = read('styles/globals.css');
  const packageJson = JSON.parse(read('package.json'));

  [
    'CenterParagraph',
    'CenterHeading',
    'data-text-align="center"',
    'markdown-it-container',
  ].forEach((snippet) => {
    assert.ok(
      extensionSource.includes(snippet),
      `Text align center extension should include ${snippet}`
    );
  });

  assert.ok(
    packageJson.dependencies['markdown-it-container'],
    'package.json should declare markdown-it-container for centered block markdown parsing'
  );

  ['CenterParagraph', 'CenterHeading'].forEach((snippet) => {
    assert.ok(
      editorSource.includes(snippet),
      `WysiwygEditor should register ${snippet}`
    );
  });

  ['文本居中', 'toggleTextAlignCenter', 'AlignCenterIcon'].forEach((snippet) => {
    assert.ok(
      toolbarSource.includes(snippet),
      `EditorToolbar should include ${snippet}`
    );
  });

  assert.ok(
    styleSource.includes('[data-text-align="center"]'),
    'globals.css should style centered editor blocks'
  );

  console.log('editor text align support tests passed');
}

runTests();
