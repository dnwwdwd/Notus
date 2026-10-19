const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');
const {
  repairImageHeadingMarkdown,
  serializeBlockImageMarkdown,
} = require('../utils/markdownImageHeadings');

async function runTests() {
  const editorSource = fs.readFileSync(path.join(__dirname, '../components/Editor/WysiwygEditor.js'), 'utf8');
  assert.ok(editorSource.includes('serialize: serializeBlockImageMarkdown'));
  assert.ok(editorSource.includes('repairImageHeadingMarkdown(value ||'));
  assert.ok(editorSource.includes('if (normalizedValue !== value) onChange?.(normalizedValue);'));

  assert.strictEqual(repairImageHeadingMarkdown('![图](a.png)## 二级'), '![图](a.png)\n\n## 二级');
  assert.strictEqual(repairImageHeadingMarkdown('![图](a.png)\\### 三级'), '![图](a.png)\n\n### 三级');
  assert.strictEqual(repairImageHeadingMarkdown('![图](https://a/b(c).png "图示")## 二级'), '![图](https://a/b(c).png "图示")\n\n## 二级');
  assert.strictEqual(repairImageHeadingMarkdown('```md\n![图](a.png)## 原样\n```'), '```md\n![图](a.png)## 原样\n```');
  assert.strictEqual(repairImageHeadingMarkdown('```md\n```js\n![图](a.png)## 原样\n```'), '```md\n```js\n![图](a.png)## 原样\n```');
  assert.strictEqual(repairImageHeadingMarkdown('正文 ![图](a.png)## 原样'), '正文 ![图](a.png)## 原样');

  const dom = new JSDOM('<div id="editor"></div>', { url: 'http://localhost' });
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getSelection: dom.window.getSelection.bind(dom.window),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });

  const [{ Editor }, { default: StarterKit }, { default: Image }, { Markdown }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/starter-kit'),
    import('@tiptap/extension-image'),
    import(pathToFileURL(path.join(__dirname, '../node_modules/tiptap-markdown/dist/tiptap-markdown.es.js')).href),
  ]);
  const BlockImage = Image.extend({
    addStorage() { return { markdown: { serialize: serializeBlockImageMarkdown } }; },
  });
  const editor = new Editor({
    element: document.querySelector('#editor'),
    extensions: [StarterKit, BlockImage.configure({ inline: false, allowBase64: true }), Markdown.configure({ html: false })],
    content: '',
    immediatelyRender: false,
  });

  try {
    for (let level = 1; level <= 6; level += 1) {
      const heading = `${'#'.repeat(level)} 第${level}级标题`;
      editor.commands.setContent(`![图](a.png)\n\n${heading}`);
      const saved = editor.storage.markdown.getMarkdown();
      assert.ok(saved.includes(`![图](a.png)\n\n${heading}`), `H${level} 必须与图片分块保存`);
      editor.commands.setContent(saved);
      assert.ok(editor.getHTML().includes(`<h${level}>第${level}级标题</h${level}>`), `H${level} 重新打开后仍是标题节点`);
    }

    editor.commands.setContent('前文\n\n![图](a.png)\n\n![图二](b.png)\n\n## 后文');
    const saved = editor.storage.markdown.getMarkdown();
    assert.ok(saved.includes('前文\n\n![图](a.png)\n\n![图二](b.png)\n\n## 后文'));
    editor.commands.setContent(repairImageHeadingMarkdown('![图](a.png)## 旧文档标题'));
    assert.ok(editor.getHTML().includes('<h2>旧文档标题</h2>'));
  } finally {
    editor.destroy();
    dom.window.close();
  }
  console.log('editor image heading boundary tests passed');
}

runTests().catch((error) => { console.error(error); process.exitCode = 1; });
