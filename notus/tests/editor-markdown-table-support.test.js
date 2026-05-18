const assert = require('assert');
const fs = require('fs');
const path = require('path');

function runTests() {
  const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'Editor', 'WysiwygEditor.js'),
    'utf8'
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );
  const globalStyles = fs.readFileSync(
    path.join(__dirname, '..', 'styles', 'globals.css'),
    'utf8'
  );

  const expectedImports = [
    "@tiptap/extension-table",
    "@tiptap/extension-table-row",
    "@tiptap/extension-table-cell",
    "@tiptap/extension-table-header",
  ];

  expectedImports.forEach((item) => {
    assert.ok(
      editorSource.includes(item),
      `WysiwygEditor should import ${item} so pasted Markdown tables can be parsed`
    );
    assert.ok(
      packageJson.dependencies[item],
      `package.json should declare dependency ${item}`
    );
  });

  ['Table.configure', 'TableRow', 'TableHeader', 'TableCell'].forEach((item) => {
    assert.ok(
      editorSource.includes(item),
      `WysiwygEditor should register ${item} in editor extensions`
    );
  });

  [
    '.wysiwyg-content .ProseMirror table',
    'border-collapse: separate',
    'border: 1px solid var(--border-primary)',
    '.wysiwyg-content .ProseMirror th,',
    '.wysiwyg-content .ProseMirror td',
    '.wysiwyg-content .ProseMirror .selectedCell::after',
  ].forEach((snippet) => {
    assert.ok(
      globalStyles.includes(snippet),
      `globals.css should include ${snippet} so WYSIWYG Markdown tables have visible borders`
    );
  });

  console.log('editor markdown table support tests passed');
}

runTests();
