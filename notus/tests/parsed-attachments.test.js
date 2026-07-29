const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function buildTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notus-parsed-attachments-'));
}

async function runTests() {
  const tempDir = buildTempWorkspace();
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempDir;
  process.env.NOTUS_DATA_DIR = tempDir;

  [
    '../lib/db',
    '../lib/config',
    '../lib/conversations',
    '../lib/attachmentParsing',
    '../lib/parsedAttachmentStore',
    '../lib/agentInputSources',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const { getEffectiveConfig } = require('../lib/config');
  const { createConversation } = require('../lib/conversations');
  const { parseDocument, extractWebUrls } = require('../lib/attachmentParsing');
  const { parseAgentInputSources, parseGitHubRepositoryReadme } = require('../lib/agentInputSources');
  const {
    formatAttachmentsForPrompt,
    hasAttachment,
    loadAttachments,
    saveAttachment,
  } = require('../lib/parsedAttachmentStore');

  const config = getEffectiveConfig();
  const attachmentsDir = path.join(config.sessionDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const txtPath = path.join(tempDir, 'note.txt');
  const mdPath = path.join(tempDir, 'note.md');
  const emptyPath = path.join(tempDir, 'empty.txt');
  const unsupportedPath = path.join(tempDir, 'slides.pptx');
  fs.writeFileSync(txtPath, 'hello attachment', 'utf8');
  fs.writeFileSync(mdPath, '# 标题\n\nMarkdown 内容', 'utf8');
  fs.writeFileSync(emptyPath, '', 'utf8');
  fs.writeFileSync(unsupportedPath, 'pptx', 'utf8');

  const txt = await parseDocument(txtPath, 'note.txt');
  assert.strictEqual(txt.status, 'success');
  assert.strictEqual(txt.type, 'plaintext');
  assert.ok(txt.text.includes('hello attachment'));

  const md = await parseDocument(mdPath, 'note.md');
  assert.strictEqual(md.status, 'success');
  assert.strictEqual(md.type, 'markdown');

  const empty = await parseDocument(emptyPath, 'empty.txt');
  assert.strictEqual(empty.status, 'error');
  assert.strictEqual(empty.errorCode, 'EMPTY_CONTENT');

  const unsupported = await parseDocument(unsupportedPath, 'slides.pptx');
  assert.strictEqual(unsupported.status, 'error');
  assert.strictEqual(unsupported.errorCode, 'UNSUPPORTED_FORMAT');

  const conversation = createConversation({ kind: 'canvas', title: '附件测试' });
  const id = saveAttachment(conversation.id, txt);
  assert.ok(id > 0);
  assert.strictEqual(hasAttachment(conversation.id, 'note.txt'), true);
  assert.strictEqual(saveAttachment(conversation.id, txt), null);

  const longText = `${'A'.repeat(13000)}\nEND`;
  saveAttachment(conversation.id, {
    source: 'long.md',
    type: 'markdown',
    status: 'success',
    text: longText,
    parsedAt: new Date().toISOString(),
  });
  const prompt = formatAttachmentsForPrompt(loadAttachments(conversation.id), { maxCharsPerSource: 12000, maxTotalChars: 20000 });
  assert.ok(prompt.includes('note.txt'));
  assert.ok(prompt.includes('long.md'));
  assert.ok(prompt.includes('内容已截断'));

  const storedName = 'upload-note.txt';
  fs.copyFileSync(txtPath, path.join(attachmentsDir, storedName));
  const events = [];
  const results = await parseAgentInputSources({
    conversationId: conversation.id,
    attachments: [{ name: 'upload-note.txt', stored_name: storedName, size: 16, type: 'text/plain' }],
    text: '请读取上传的附件',
    onEvent: (event) => events.push(event),
  });
  assert.ok(results.some((item) => item.source === 'upload-note.txt' && item.status === 'success'));
  assert.ok(events.some((event) => event.type === 'attachment_parse_start'));

  const imageEvents = [];
  const imageResults = await parseAgentInputSources({
    conversationId: conversation.id,
    attachments: [{ name: 'screen.png', stored_name: 'screen.png', type: 'image/png', source_kind: 'image', media_kind: 'image' }],
    onEvent: (event) => imageEvents.push(event),
  });
  assert.deepStrictEqual(imageResults, [], '图片不能进入文本附件解析');
  assert.deepStrictEqual(imageEvents, [], '图片不能产生附件解析步骤');
  assert.deepStrictEqual(extractWebUrls('参考 https://example.com/a 和 https://example.com/file.pdf'), ['https://example.com/a']);

  const originalFetch = global.fetch;
  const githubFetchCalls = [];
  global.fetch = async (url) => {
    githubFetchCalls.push(String(url));
    if (String(url).endsWith('/readme')) {
      return new Response('# Notus\n\nGitHub README 内容', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify({ full_name: 'dnwwdwd/Notus', description: 'Notus project' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const github = await parseGitHubRepositoryReadme('https://github.com/dnwwdwd/Notus');
    assert.strictEqual(github.status, 'success');
    assert.strictEqual(github.metadata.title, 'dnwwdwd/Notus README');
    assert.ok(github.text.includes('GitHub README 内容'));
    assert.strictEqual(githubFetchCalls.length, 2, 'GitHub 仓库直连应先确认仓库，再读取 README');
    global.fetch = async (url) => String(url).endsWith('/readme')
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify({ full_name: 'dnwwdwd/NoReadme' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const missingReadme = await parseGitHubRepositoryReadme('https://github.com/dnwwdwd/NoReadme');
    assert.strictEqual(missingReadme.errorCode, 'README_MISSING');
  } finally {
    global.fetch = originalFetch;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head><title>网页解析测试</title></head>
        <body>
          <nav>导航内容</nav>
          <main>
            <article>
              <h1>网页解析测试</h1>
              <p>${'这是用于网页正文解析的稳定段落。'.repeat(12)}</p>
            </article>
          </main>
        </body>
      </html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const pageUrl = `http://127.0.0.1:${port}/article`;
    const normalizedPageUrl = new URL(pageUrl).toString();
    const boundaryConversation = createConversation({ kind: 'canvas', title: '输入边界测试' });
    const boundaryResults = await parseAgentInputSources({
      conversationId: boundaryConversation.id,
      attachments: [],
      userInputText: '根据我的笔记生成一个文档介绍我自己',
      text: `当前创作页文本块快照：${pageUrl}`,
    });
    assert.strictEqual(boundaryResults.some((item) => item.source === normalizedPageUrl), false);
    assert.strictEqual(loadAttachments(boundaryConversation.id).some((item) => item.source === normalizedPageUrl), false);

    const urlEvents = [];
    const urlResults = await parseAgentInputSources({
      conversationId: conversation.id,
      attachments: [],
      userInputText: `请结合这个链接 ${pageUrl} 分析`,
      onEvent: (event) => urlEvents.push(event),
    });
    assert.ok(urlResults.some((item) => item.source === normalizedPageUrl && item.status === 'success' && item.type === 'webpage'));
    assert.ok(urlEvents.some((event) => event.type === 'attachment_parse_done' && event.source_kind === 'url'));
    assert.ok(loadAttachments(conversation.id).some((item) => item.source === normalizedPageUrl && item.contentType === 'webpage'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('parsed attachment tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
