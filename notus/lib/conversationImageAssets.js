const fs = require('fs');
const { buildImageProxyUrl, isLocalImageSource } = require('./images');
const { persistImageBuffer } = require('./imageStorage');
const {
  listConversationImages,
  parseConversationImageReference,
  resolveConversationImages,
  resolveStoredImagePath,
} = require('./conversationImages');

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(<?([^\s)>]+)>?(?:\s+['\"][^)]*['\"])?\)/g;

function extractMarkdownImages(content = '') {
  const images = [];
  const source = String(content || '');
  let match = MARKDOWN_IMAGE_PATTERN.exec(source);
  while (match) {
    images.push({
      index: match.index,
      raw: match[0],
      alt: String(match[1] || ''),
      src: String(match[2] || ''),
    });
    match = MARKDOWN_IMAGE_PATTERN.exec(source);
  }
  return images;
}

function isConversationImageSource(src = '') {
  return Boolean(parseConversationImageReference(src));
}

function isConversationImageInsertionRequest(taskText = '') {
  const text = String(taskText || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const image = '(?:图片|截图|反馈图|照片)';
  const insert = '(?:贴入|贴到|插入|加入|写入|放进|放到|整理进|整理为|整理成|补进|补充到)';
  return new RegExp(`${image}.{0,18}${insert}|${insert}.{0,18}${image}`).test(text);
}

// 图片写入任务不能只依赖模型是否记得把受控引用放进 Markdown。
// 当用户明确要求把当前会话图片贴入文档而草稿遗漏引用时，补齐尚未出现的图片。
// 真正持久化仍发生在应用预览时，统一由 persistImageBuffer() 按当前本地/图床设置处理。
function ensureConversationImagesInMarkdown(content = '', { conversationId = null, taskText = '' } = {}) {
  const source = String(content || '');
  if (!conversationId || !isConversationImageInsertionRequest(taskText)) return source;
  const existingSources = new Set(extractMarkdownImages(source).map((image) => image.src));
  const missing = listConversationImages(conversationId).filter((image) => (
    image?.image_ref && !existingSources.has(image.image_ref)
  ));
  if (missing.length === 0) return source;
  const markdown = missing.map((image) => {
    const alt = String(image.name || '用户提供的图片').replace(/[\[\]]/g, '').trim() || '用户提供的图片';
    return `![${alt}](${image.image_ref})`;
  }).join('\n\n');
  return `${source.replace(/\s+$/, '')}\n\n## 用户提供的图片\n\n${markdown}\n`;
}

function resolveConversationPreview(src = '', conversationId = null) {
  if (!conversationId || !isConversationImageSource(src)) return '';
  try {
    const image = resolveConversationImages(conversationId, [src])[0];
    return image?.stored_name
      ? `/api/agent/images/${encodeURIComponent(image.stored_name)}?conversation_id=${encodeURIComponent(conversationId)}`
      : '';
  } catch {
    return '';
  }
}

function buildImageDescriptor(image = {}, { fileId = null, conversationId = null, side = 'after' } = {}) {
  const src = String(image.src || '');
  const conversationPreview = resolveConversationPreview(src, conversationId);
  const previewSrc = conversationPreview || (fileId && side === 'before'
    ? buildImageProxyUrl(fileId, src)
    : src);
  return {
    src,
    alt: String(image.alt || ''),
    ...(fileId ? { file_id: Number(fileId) } : {}),
    ...(isConversationImageSource(src) ? { source_ref: src } : {}),
    ...(previewSrc ? { preview_src: previewSrc } : {}),
  };
}

function longestCommonSourcePairs(before = [], after = []) {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = before[i].src === after[j].src
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i].src === after[j].src) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function buildMediaChanges({
  baseContent = '',
  draftContent = '',
  filePath = '',
  fileId = null,
  conversationId = null,
} = {}) {
  const before = extractMarkdownImages(baseContent);
  const after = extractMarkdownImages(draftContent);
  const pairs = longestCommonSourcePairs(before, after);
  const pairedBefore = new Set(pairs.map(([index]) => index));
  const pairedAfter = new Set(pairs.map(([, index]) => index));
  const removed = before.filter((_item, index) => !pairedBefore.has(index));
  const added = after.filter((_item, index) => !pairedAfter.has(index));
  const changes = [];
  const replacementCount = Math.min(removed.length, added.length);
  for (let index = 0; index < replacementCount; index += 1) {
    changes.push({
      id: `media-${changes.length + 1}`,
      kind: 'replace',
      file_path: String(filePath || ''),
      before: buildImageDescriptor(removed[index], { fileId, conversationId, side: 'before' }),
      after: buildImageDescriptor(added[index], { fileId, conversationId, side: 'after' }),
    });
  }
  removed.slice(replacementCount).forEach((image) => {
    changes.push({
      id: `media-${changes.length + 1}`,
      kind: 'remove',
      file_path: String(filePath || ''),
      before: buildImageDescriptor(image, { fileId, conversationId, side: 'before' }),
    });
  });
  added.slice(replacementCount).forEach((image) => {
    changes.push({
      id: `media-${changes.length + 1}`,
      kind: 'add',
      file_path: String(filePath || ''),
      after: buildImageDescriptor(image, { fileId, conversationId, side: 'after' }),
    });
  });
  return changes;
}

function replaceImageSources(content = '', sourceMap = new Map()) {
  if (!(sourceMap instanceof Map) || sourceMap.size === 0) return String(content || '');
  return String(content || '').replace(MARKDOWN_IMAGE_PATTERN, (raw, alt, src) => {
    const next = sourceMap.get(String(src || ''));
    if (!next) return raw;
    return raw.replace(String(src || ''), next);
  });
}

function previewStoredImage(src = '', fileId = null) {
  return fileId && isLocalImageSource(src) ? buildImageProxyUrl(fileId, src) : src;
}

function updateMaterializedMediaChanges(changes = [], sourceMap = new Map(), { fileId = null } = {}) {
  return (Array.isArray(changes) ? changes : []).map((change) => {
    const after = change?.after;
    const sourceRef = String(after?.source_ref || after?.src || '');
    const finalSrc = sourceMap.get(sourceRef);
    if (!after || !finalSrc) return change;
    const resolvedFileId = Number(after.file_id || fileId || 0) || null;
    return {
      ...change,
      after: {
        ...after,
        src: finalSrc,
        ...(resolvedFileId ? { file_id: resolvedFileId } : {}),
        preview_src: previewStoredImage(finalSrc, resolvedFileId),
        materialized_src: finalSrc,
      },
    };
  });
}

function attachMediaFileId(changes = [], fileId = null) {
  const resolvedFileId = Number(fileId || 0) || null;
  if (!resolvedFileId) return Array.isArray(changes) ? changes : [];
  return (Array.isArray(changes) ? changes : []).map((change) => {
    const hydrate = (image) => {
      if (!image || typeof image !== 'object') return image;
      const src = String(image.src || '');
      return {
        ...image,
        file_id: resolvedFileId,
        ...(src && !isConversationImageSource(src) ? { preview_src: previewStoredImage(src, resolvedFileId) } : {}),
      };
    };
    return {
      ...change,
      ...(change.before ? { before: hydrate(change.before) } : {}),
      ...(change.after ? { after: hydrate(change.after) } : {}),
    };
  });
}

async function materializeConversationImages({
  conversationId,
  content = '',
  filePath = '',
  fileId = null,
  mediaChanges = [],
} = {}) {
  const refs = [...new Set(extractMarkdownImages(content)
    .map((image) => image.src)
    .filter(isConversationImageSource))];
  if (refs.length === 0) {
    return { content: String(content || ''), media_changes: Array.isArray(mediaChanges) ? mediaChanges : [] };
  }
  const images = resolveConversationImages(conversationId, refs);
  const sourceMap = new Map();
  for (const image of images) {
    const absolutePath = resolveStoredImagePath(image.stored_name);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      const error = new Error(`图片临时文件不存在：${image.name}`);
      error.code = 'IMAGE_NOT_FOUND';
      throw error;
    }
    const stored = await persistImageBuffer({
      buffer: fs.readFileSync(absolutePath),
      mimeType: image.type,
      originalName: image.name,
      filePath,
    });
    sourceMap.set(image.image_ref, stored.src);
  }
  return {
    content: replaceImageSources(content, sourceMap),
    media_changes: updateMaterializedMediaChanges(mediaChanges, sourceMap, { fileId }),
  };
}

module.exports = {
  attachMediaFileId,
  buildMediaChanges,
  ensureConversationImagesInMarkdown,
  extractMarkdownImages,
  isConversationImageSource,
  materializeConversationImages,
  replaceImageSources,
};
