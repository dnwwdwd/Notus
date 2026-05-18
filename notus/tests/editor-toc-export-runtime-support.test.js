const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

async function runTests() {
  const filesPageSource = read('pages/files/index.js');
  const editorSource = read('components/Editor/WysiwygEditor.js');
  const exportSource = read('pages/api/files/export.js');
  const tableHelperSource = read('lib/editorMarkdownTable.js');
  const tableHelper = await import('../lib/editorMarkdownTable.js');

  [
    'const syncTocHeadings = useCallback(() => {',
    'function collectHeadingItemsFromEditor(editorInstance) {',
    'editorInstance.state.doc.descendants((node) => {',
    'syncTocHeadings();',
  ].forEach((snippet) => {
    assert.ok(
      filesPageSource.includes(snippet),
      `files/index.js should include ${snippet} so TOC can retry after editor DOM settles`
    );
  });

  [
    "import { findMarkdownTableBlock } from '../../lib/editorMarkdownTable';",
    'function convertMarkdownTableAroundSelection(editorInstance) {',
    'const tableBlock = findMarkdownTableBlock(candidateLines, activeIndex);',
    'window.requestAnimationFrame(() => {',
    'convertMarkdownTableAroundSelection(currentEditor);',
  ].forEach((snippet) => {
    assert.ok(
      editorSource.includes(snippet),
      `WysiwygEditor should include ${snippet} for runtime markdown table conversion`
    );
  });

  [
    'function encodeContentDispositionFilename(filename = \'\') {',
    "filename*=UTF-8''",
    'encodeContentDispositionFilename(path.basename(file.path))',
  ].forEach((snippet) => {
    assert.ok(
      exportSource.includes(snippet),
      `files/export.js should include ${snippet} for non-ASCII download filenames`
    );
  });

  [
    'function findMarkdownTableBlock(lines = [], activeIndex = -1) {',
    'function looksLikeMarkdownTableLines(lines = []) {',
    'TABLE_SEPARATOR_CELL_PATTERN',
    'function splitMarkdownTableLine(value = \'\') {',
  ].forEach((snippet) => {
    assert.ok(
      tableHelperSource.includes(snippet),
      `editorMarkdownTable helper should include ${snippet}`
    );
  });

  assert.deepStrictEqual(
    tableHelper.findMarkdownTableBlock(
      ['Name | Value', '--- | ---', 'A | 1'],
      2
    ),
    {
      start: 0,
      end: 2,
      lines: ['| Name | Value |', '| --- | --- |', '| A | 1 |'],
    },
    'editorMarkdownTable helper should support GFM tables without outer pipes'
  );

  assert.deepStrictEqual(
    tableHelper.findMarkdownTableBlock(
      ['| Name | Value |', '| :--- | ---: |', '| A | 1 |'],
      0
    ),
    {
      start: 0,
      end: 2,
      lines: ['| Name | Value |', '| :--- | ---: |', '| A | 1 |'],
    },
    'editorMarkdownTable helper should preserve pipe-wrapped GFM tables'
  );

  assert.strictEqual(
    tableHelper.findMarkdownTableBlock(['Name | Value', '--- | ---'], 1),
    null,
    'editorMarkdownTable helper should not convert incomplete tables'
  );

  console.log('editor toc/export runtime support tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
