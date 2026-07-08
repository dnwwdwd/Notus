function isLocalClipboardImageSource(src = '') {
  const value = String(src || '').trim();
  if (!value || value.startsWith('data:')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (value.startsWith('//') || value.startsWith('/api/')) return false;
  return true;
}

function buildContentImageApiUrl(fileId, src = '') {
  return `/api/files/${encodeURIComponent(fileId)}/content-image?src=${encodeURIComponent(src)}`;
}

function buildClipboardImageFetchUrl(sourceImage, fileId = null) {
  const rawSrc = String(sourceImage?.getAttribute('data-notus-src') || '').trim();
  const renderedSrc = String(sourceImage?.getAttribute('src') || '').trim();

  if (fileId && isLocalClipboardImageSource(rawSrc)) {
    return buildContentImageApiUrl(fileId, rawSrc);
  }

  return renderedSrc || rawSrc;
}

function cleanupClonedEditorRoot(root) {
  if (!root) return root;

  root.removeAttribute('contenteditable');
  root.removeAttribute('role');
  root.removeAttribute('spellcheck');
  root.removeAttribute('translate');
  root.classList.remove('ProseMirror-focused');

  root.querySelectorAll('.ProseMirror-trailingBreak, .ProseMirror-gapcursor').forEach((node) => node.remove());
  root.querySelectorAll('[contenteditable]').forEach((node) => node.removeAttribute('contenteditable'));
  root.querySelectorAll('img').forEach((node) => {
    node.removeAttribute('data-notus-src');
    node.removeAttribute('draggable');
    node.removeAttribute('loading');
    node.removeAttribute('decoding');
    node.removeAttribute('srcset');
    node.removeAttribute('sizes');
  });

  return root;
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function inlineEditorImagesForClipboard(sourceRoot, clonedRoot, { fileId = null } = {}) {
  const sourceImages = Array.from(sourceRoot?.querySelectorAll('img') || []);
  const clonedImages = Array.from(clonedRoot?.querySelectorAll('img') || []);

  await Promise.all(clonedImages.map(async (clonedImage, index) => {
    const sourceImage = sourceImages[index];
    const rawSrc = String(sourceImage?.getAttribute('data-notus-src') || '').trim();
    const currentSrc = String(clonedImage.getAttribute('src') || '').trim();

    if (!currentSrc || currentSrc.startsWith('data:')) return;

    const fetchUrl = buildClipboardImageFetchUrl(sourceImage, fileId);
    if (!fetchUrl) return;

    try {
      const response = await fetch(fetchUrl);
      if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);

      const blob = await response.blob();
      if (!String(blob.type || '').startsWith('image/')) {
        throw new Error('复制图片时拿到的不是图片内容');
      }

      const dataUrl = await readBlobAsDataUrl(blob);
      if (dataUrl) clonedImage.setAttribute('src', dataUrl);
    } catch (error) {
      if (fileId && isLocalClipboardImageSource(rawSrc)) {
        throw error;
      }
    }
  }));
}

function getEditorHtmlRoot(editor) {
  return editor?.view?.dom || null;
}

async function buildClipboardHtml(editor, { fileId = null } = {}) {
  const sourceRoot = getEditorHtmlRoot(editor);
  if (!sourceRoot) return '';

  const clonedRoot = cleanupClonedEditorRoot(sourceRoot.cloneNode(true));
  await inlineEditorImagesForClipboard(sourceRoot, clonedRoot, { fileId });
  return clonedRoot.innerHTML;
}

function fallbackCopyPlainText(text = '') {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }

  if (!copied) {
    throw new Error('当前环境不支持复制到剪贴板');
  }
}

async function copyPlainText(text = '') {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  fallbackCopyPlainText(text);
}

export async function copyEditorContentToClipboard(editor, { fileId = null } = {}) {
  const sourceRoot = getEditorHtmlRoot(editor);
  const markdown = String(editor?.storage?.markdown?.getMarkdown?.() || '');
  const plainText = markdown || String(sourceRoot?.textContent || '');
  const hasRichContent = Boolean(
    sourceRoot?.textContent?.trim()
    || sourceRoot?.querySelector('img,table,pre,blockquote,hr,ul,ol')
  );

  if (!plainText && !hasRichContent) {
    return { mode: 'empty' };
  }

  const supportsRichClipboard = typeof window !== 'undefined'
    && typeof window.ClipboardItem !== 'undefined'
    && Boolean(navigator.clipboard?.write);

  if (!supportsRichClipboard) {
    await copyPlainText(plainText);
    return { mode: 'plain', reason: 'rich_unsupported' };
  }

  try {
    const htmlBody = await buildClipboardHtml(editor, { fileId });
    const html = `<!doctype html><html><body>${htmlBody}</body></html>`;

    await navigator.clipboard.write([
      new window.ClipboardItem({
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);

    return { mode: 'rich' };
  } catch (error) {
    await copyPlainText(plainText);
    return { mode: 'plain', reason: 'rich_failed', error };
  }
}

export {
  isLocalClipboardImageSource,
  buildClipboardImageFetchUrl,
  buildClipboardHtml,
};
