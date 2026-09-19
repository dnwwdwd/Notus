const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { pastedTextFileName } = require('../utils/attachmentPreview');
const source = fs.readFileSync(require.resolve('../components/AgentWorkspace/AgentWorkspace.js'), 'utf8');
const handler = source.match(/const handlePaste = \(event\) => \{([\s\S]*?)\n  \};/)[1];
let uploads = [], prevented = false;
const count = { current: { attachment: 0 } };
const paste = vm.runInNewContext(`(event) => {${handler}\n}`, {
  parsedAttachmentMode: true, busy: false, disabled: false,
  getClipboardFiles: clipboard => clipboard.files || [],
  isSupportedImageFile: file => file.type === 'image/png',
  addFiles: (files, options) => uploads.push({ files, options }),
  LONG_PASTE_ATTACHMENT_THRESHOLD: Number(source.match(/LONG_PASTE_ATTACHMENT_THRESHOLD = (\d+)/)[1]),
  MAX_PARSED_ATTACHMENTS: 10, selectedMediaCountRef: count,
  pastedTextFileName,
  File: class { constructor(parts, name) { this.name = name; this.parts = parts; } },
  toast() {},
});
function pasteText(text) {
  prevented = false; uploads = [];
  paste({ clipboardData: { getData: () => text }, preventDefault: () => { prevented = true; } });
}
for (const text of ['短任务', '字'.repeat(599), '字'.repeat(600), '😀'.repeat(600)]) {
  pasteText(text);
  assert.strictEqual(prevented, false, '600 字符以内保留在输入框');
  assert.strictEqual(uploads.length, 0);
}
for (const text of ['字'.repeat(601), '😀'.repeat(601), '第一段\n'.repeat(200)]) {
  pasteText(text);
  assert.strictEqual(prevented, true, '超过 600 字符自动转附件');
  assert.strictEqual(uploads.length, 1);
  assert.strictEqual(uploads[0].files[0].parts[0], text, '附件必须保留完整原文');
  assert.strictEqual(uploads[0].files[0].name, pastedTextFileName(text));
  assert.strictEqual(uploads[0].options.sourceKind, 'pasted_text');
}
count.current.attachment = 10;
pasteText('字'.repeat(601));
assert.strictEqual(prevented, false, '附件满额时不能吞掉粘贴内容');
assert.strictEqual(uploads.length, 0);
for (const type of ['image/png', 'text/plain']) {
  uploads = []; prevented = false;
  paste({ clipboardData: { files: [{ type }] }, preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true);
  assert.strictEqual(uploads[0].options.mediaKind, type === 'image/png' ? 'image' : 'attachment');
}
console.log('agent text paste tests passed');
