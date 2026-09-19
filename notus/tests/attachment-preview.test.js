const assert = require('assert');
const { pastedTextFileName, normalizePastedAttachmentName, readLocalAttachment } = require('../utils/attachmentPreview');
(async () => {
  assert.strictEqual(pastedTextFileName('  第一段\n第二段  '), '第一段 第二段.txt');
  assert.strictEqual(pastedTextFileName('😀'.repeat(25)), `${'😀'.repeat(20)}.txt`);
  assert.strictEqual(pastedTextFileName('a/b:c\\d'), 'a_b_c_d.txt');
  const text = '<script>不执行</script>\n保留原文';
  const file = new File([text], '材料.txt', { type: 'text/plain' });
  let requests = 0;
  global.fetch = async () => { requests++; throw new Error('不应联网'); };
  const result = await readLocalAttachment({ name: file.name, fileObject: file });
  assert.strictEqual(result.text, text);
  assert.strictEqual(requests, 0);
  assert.strictEqual(await readLocalAttachment({ name: file.name, fileObject: file }), result);
  const renamed = await normalizePastedAttachmentName({ name: 'pasted-text-123.txt', source_kind: 'pasted_text', blob: file });
  assert.strictEqual(renamed.name, pastedTextFileName(text));
  const original = { name: '原文件.txt', source_kind: 'file', fileObject: file };
  assert.strictEqual(await normalizePastedAttachmentName(original), original);
  assert.strictEqual((await readLocalAttachment({ name: '空.txt', fileObject: new File([], '空.txt') })).text, '');
  const doc = new File(['binary'], '文档.docx');
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/upload')
      ? { attachments: [{ name: '文档.docx', stored_name: 'test.docx' }] }
      : { text: '已解析内容', status: 'success' } };
  };
  assert.strictEqual((await readLocalAttachment({ name: doc.name, fileObject: doc })).text, '已解析内容');
  await readLocalAttachment({ name: doc.name, fileObject: doc });
  assert.strictEqual(calls.length, 2, '重复预览复用结果');
  assert.strictEqual(JSON.parse(calls[1].options.body).attachment.stored_name, 'test.docx');
  const failed = new File(['binary'], '失败.pdf');
  global.fetch = async () => ({ ok: false, json: async () => ({ error: '解析不可用' }) });
  await assert.rejects(readLocalAttachment({ name: failed.name, fileObject: failed }), /解析不可用/);
  global.fetch = async url => ({ ok: true, json: async () => url.endsWith('/upload')
    ? { attachments: [{ stored_name: 'retry.pdf' }] } : { text: '重试成功' } });
  assert.strictEqual((await readLocalAttachment({ name: failed.name, fileObject: failed })).text, '重试成功');
  // Exercise the actual restoration callback with a delayed legacy Blob read.
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync(require.resolve('../components/AgentWorkspace/AgentWorkspace.js'), 'utf8');
  const start = source.indexOf('    readAgentComposerDraft().then(');
  const restore = source.slice(start, source.indexOf('    return () => { cancelled = true; };', start));
  let releaseName;
  const legacyFile = { text: () => new Promise(resolve => { releaseName = resolve; }) };
  const draftFile = { id: 'legacy', source_kind: 'pasted_text', name: 'pasted-text-123.txt', fileObject: legacyFile };
  let visibleFiles = [], composer = '';
  const hydrated = { current: false };
  vm.runInNewContext(restore, {
    cancelled: false, composerDraftHydratedRef: hydrated,
    composerInteractionRef: { current: false }, previewUrlsRef: { current: new Set() },
    uploadOrderRef: { current: 0 }, selectedMediaCountRef: { current: {} },
    readAgentComposerDraft: async () => ({ content: '旧草稿', files: [draftFile] }),
    restoreComposerDom() {}, restoreAgentComposerFiles: files => files,
    normalizePastedAttachmentName, isImageMedia: () => false,
    setFiles: next => { visibleFiles = typeof next === 'function' ? next(visibleFiles) : next; },
    setComposerState: next => { composer = next.content; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(hydrated.current, true, '命名读取未结束也必须已启用新输入的草稿保存');
  composer = '用户刚输入的新内容';
  visibleFiles = []; // removed while the old name was being read
  releaseName('新的内容名字');
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(composer, '用户刚输入的新内容');
  assert.deepStrictEqual(visibleFiles, [], '迟到命名不能重新加入已移除附件');
  console.log('attachment preview tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
