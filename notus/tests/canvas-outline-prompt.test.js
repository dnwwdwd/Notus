const assert = require('assert');
const { buildOutlinePrompt } = require('../lib/prompt');

function runTests() {
  const promptWithStyle = buildOutlinePrompt('缓存设计', {
    currentDocument: {
      title: '旧文章',
      summary: '一篇讨论缓存设计的旧文章。',
      outline: '# 缓存设计 | ## 现状 | ## 方案',
    },
    sections: [],
    styleContext: {
      profile: { summary: '整体表达直接，先给判断再展开。' },
      dimensions: {
        sentence_style: '短句和中短句为主。',
        tone: '直接但克制。',
      },
      signature_phrases: ['先说结论'],
      reference_excerpts: [
        {
          file_title: '风格样本 A',
          heading_path: '正文',
          content: '先说结论，再解释为什么这么判断。',
        },
      ],
    },
  });
  const contentWithStyle = String(promptWithStyle[1].content || '');
  assert.ok(contentWithStyle.includes('总体风格画像：整体表达直接，先给判断再展开。'));
  assert.ok(contentWithStyle.includes('标志表达：先说结论'));
  assert.ok(contentWithStyle.includes('相关原文摘录：'));
  assert.ok(contentWithStyle.includes('风格样本 A'));

  const promptWithoutStyle = buildOutlinePrompt('新主题', {
    currentDocument: null,
    sections: [],
    styleContext: null,
  });
  const contentWithoutStyle = String(promptWithoutStyle[1].content || '');
  assert.ok(contentWithoutStyle.includes('无额外风格上下文。'));

  console.log('canvas outline prompt tests passed');
}

runTests();
