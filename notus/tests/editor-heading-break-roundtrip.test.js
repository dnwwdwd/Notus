const assert = require('assert');
const { JSDOM } = require('jsdom');

(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMParser = dom.window.DOMParser;
  global.Node = dom.window.Node;
  global.HTMLElement = dom.window.HTMLElement;
  global.getComputedStyle = dom.window.getComputedStyle;
  const { Editor } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { Markdown } = await import('tiptap-markdown');
  const { CenterHeading, MarkdownHardBreak } = await import('../components/Editor/TextAlignCenterExtension.js');
  const editor = new Editor({
    extensions: [StarterKit.configure({ heading: false, hardBreak: false }), CenterHeading, MarkdownHardBreak, Markdown.configure({ html: false })],
    content: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '第一行' }, { type: 'hardBreak' }, { type: 'text', text: '第二行' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '正文一' }, { type: 'hardBreak' }, { type: 'text', text: '正文二' }] },
    ] },
  });
  const before = editor.getJSON();
  const markdown = editor.storage.markdown.getMarkdown();
  assert.ok(markdown.includes('## 第一行<br>第二行'), '标题内换行必须在同一 Markdown 行中保存');
  assert.ok(markdown.includes('正文一\\\n正文二'), '段落保留标准硬换行');
  editor.commands.setContent(markdown);
  assert.deepStrictEqual(editor.getJSON(), before, '保存后重新解析应保留标题级别、换行及正文');
  editor.destroy();
  dom.window.close();
  console.log('editor heading break roundtrip tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
