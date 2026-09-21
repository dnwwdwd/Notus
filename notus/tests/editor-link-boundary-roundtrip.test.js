const assert = require('assert');
const { JSDOM } = require('jsdom');
(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'DOMParser', 'Node', 'HTMLElement', 'getComputedStyle']) global[key] = dom.window[key];
  const { Editor } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { Markdown } = await import('tiptap-markdown');
  const { MarkdownLinkBoundary } = await import('../components/Editor/MarkdownLinkBoundary.js');
  const editor = new Editor({ extensions: [StarterKit, MarkdownLinkBoundary, Markdown.configure({ html: false })] });
  for (const punctuation of ['，', '。', '；', '：', '！', '？', '、', '（', '【', '《', '“', '‘']) {
    const suffix = `${punctuation}也欢迎大家。`;
    editor.commands.setContent(`<https://github.com/example/notus${suffix}>`);
    for (let round = 0; round < 3; round++) {
      const paragraph = editor.getJSON().content[0].content;
      assert.equal(paragraph[0].marks[0].attrs.href, 'https://github.com/example/notus');
      assert.equal(paragraph[1].text, suffix);
      assert.ok(!paragraph[1].marks);
      const saved = editor.storage.markdown.getMarkdown();
      assert.ok(!saved.includes('%EF%BC'));
      editor.commands.setContent(saved);
    }
  }
  for (const source of ['[点 star](https://example.com)，也欢迎。', '[说明](https://example.com/中文，路径?q=%E4%B8%AD)', '<https://example.com/中文路径?q=%E4%B8%AD>', '`<https://example.com/，中文>`', '```\n<https://example.com/，中文>\n```']) {
    const baseline = new Editor({ extensions: [StarterKit, Markdown.configure({ html: false })], content: source });
    baseline.commands.setContent(source);
    editor.commands.setContent(source);
    assert.deepStrictEqual(editor.getJSON(), baseline.getJSON(), source);
    baseline.destroy();
  }
  const pasted = editor.storage.markdown.parser.parse('<https://example.com/path，也欢迎>');
  assert.ok(pasted.includes('href="https://example.com/path"'));
  assert.ok(pasted.includes('</a>，也欢迎'));
  editor.destroy(); dom.window.close();
  console.log('editor link boundary roundtrip tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
