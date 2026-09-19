// Browser-only preview helpers; attachment content remains external material.
const previewCache = new WeakMap();

function pastedTextFileName(text) {
  const prefix = Array.from(String(text || '').trim().replace(/\s+/gu, ' '))
    .slice(0, 20).join('').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim();
  return `${prefix || '粘贴内容'}.txt`;
}

async function normalizePastedAttachmentName(attachment) {
  const file = attachment.fileObject || attachment.blob;
  if (attachment.source_kind !== 'pasted_text' || !file?.text) return attachment;
  try {
    return { ...attachment, name: pastedTextFileName(await file.text()) };
  } catch {
    return attachment;
  }
}

async function readLocalAttachment(attachment) {
  const file = attachment.fileObject;
  if (!file) throw new Error('附件原文件不可用');
  if (previewCache.has(file)) return previewCache.get(file);
  const task = (async () => {
    if (/\.(txt|md|markdown|csv)$/i.test(attachment.name || file.name || '')) {
      return { source: attachment.name, text: await file.text(), status: 'success', canCopy: true };
    }
    const form = new FormData();
    form.append('files', file, attachment.name);
    const upload = await fetch('/api/agent/attachments/upload', { method: 'POST', body: form });
    const uploaded = await upload.json();
    if (!upload.ok || !uploaded.attachments?.[0]) throw new Error(uploaded.error || '附件上传失败');
    const response = await fetch('/api/agent/attachments/content', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachment: uploaded.attachments[0] }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '附件内容读取失败');
    return payload;
  })();
  previewCache.set(file, task);
  try { return await task; } catch (error) {
    previewCache.delete(file);
    throw error;
  }
}

module.exports = { pastedTextFileName, normalizePastedAttachmentName, readLocalAttachment };
