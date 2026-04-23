const { getEmbeddings, getImageEmbedding, supportsImageEmbedding } = require('./embeddings');
const { ensureError } = require('./errors');
const { createLogger } = require('./logger');
const { buildSearchText } = require('./tokenizer');
const { downloadImage } = require('./images');
const {
  ensureMarkdownPath,
  readMarkdownFile,
  sha256,
} = require('./files');
const {
  getGenerationDb,
  getGenerationHandle,
} = require('./indexGenerationDb');

const BLOCK_NODE_TYPES = new Set([
  'heading',
  'paragraph',
  'code',
  'table',
  'list',
  'blockquote',
  'html',
  'thematicBreak',
]);
const logger = createLogger({ subsystem: 'indexer' });

function normalizeContent(content = '') {
  return String(content).replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
}

function nodeToChunkType(node) {
  if (node.type === 'heading') return 'heading';
  if (node.type === 'code') return 'code';
  if (node.type === 'table') return 'table';
  if (node.type === 'list') return 'list';
  if (node.type === 'blockquote') return 'blockquote';
  if (node.type === 'thematicBreak') return 'divider';
  if (node.type === 'html') return 'html';
  return 'paragraph';
}

function getNodeSlice(markdown, node) {
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return '';
  return normalizeContent(markdown.slice(start, end));
}

function headingText(node) {
  const values = [];
  function walk(current) {
    if (!current) return;
    if (current.type === 'text' || current.type === 'inlineCode') values.push(current.value);
    if (Array.isArray(current.children)) current.children.forEach(walk);
  }
  walk(node);
  return values.join('').trim();
}

function hasImage(node) {
  let found = false;
  function walk(current) {
    if (!current || found) return;
    if (current.type === 'image') {
      found = true;
      return;
    }
    if (Array.isArray(current.children)) current.children.forEach(walk);
  }
  walk(node);
  return found;
}

function extractImages(content) {
  const images = [];
  const re = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match = re.exec(content);
  while (match) {
    const full = match[0];
    const altMatch = full.match(/^!\[([^\]]*)]/);
    images.push({
      url: match[1],
      alt_text: altMatch ? altMatch[1].trim() : '',
    });
    match = re.exec(content);
  }
  return images;
}

let parserPromise = null;

async function getParser() {
  if (!parserPromise) {
    parserPromise = Promise.all([
      import('unified'),
      import('remark-parse'),
      import('remark-gfm'),
    ]).then(([unifiedModule, remarkParseModule, remarkGfmModule]) =>
      unifiedModule.unified()
        .use(remarkParseModule.default)
        .use(remarkGfmModule.default)
    );
  }
  return parserPromise;
}

async function splitIntoChunks(content) {
  const source = String(content || '');
  if (!source.trim()) return [];

  const parser = await getParser();
  const tree = parser.parse(source);
  const chunks = [];
  const headingStack = [];

  tree.children.forEach((node) => {
    if (node.type === 'heading') {
      const title = headingText(node);
      headingStack[node.depth - 1] = title;
      headingStack.length = node.depth;
    }

    if (!BLOCK_NODE_TYPES.has(node.type)) return;

    const chunkContent = getNodeSlice(source, node);
    if (!chunkContent) return;

    const lineStart = node.position?.start?.line || null;
    const lineEnd = node.position?.end?.line || null;
    const type = nodeToChunkType(node);
    const headingPath = headingStack.filter(Boolean).join(' > ');
    const textForSearch = `${headingPath}\n${chunkContent}`;

    chunks.push({
      type,
      content: chunkContent,
      position: chunks.length,
      line_start: lineStart,
      line_end: lineEnd,
      heading_path: headingPath,
      has_image: hasImage(node) || /!\[[^\]]*]\(/.test(chunkContent) ? 1 : 0,
      search_text: buildSearchText(textForSearch),
    });
  });

  return chunks;
}

function deleteFileVectors(db, fileId, vecEnabled) {
  const normalizedFileId = Number(fileId);
  if (!Number.isFinite(normalizedFileId) || normalizedFileId <= 0) return;

  const chunkIds = db.prepare('SELECT id FROM chunks WHERE file_id = ?').all(normalizedFileId);
  const imageIds = db.prepare(`
    SELECT i.id
    FROM images i
    JOIN chunks c ON c.id = i.chunk_id
    WHERE c.file_id = ?
  `).all(normalizedFileId);

  db.transaction(() => {
    if (vecEnabled) {
      const deleteChunkVec = db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?');
      const deleteImageVec = db.prepare('DELETE FROM images_vec WHERE image_id = ?');
      chunkIds.forEach((row) => deleteChunkVec.run(BigInt(row.id)));
      imageIds.forEach((row) => deleteImageVec.run(BigInt(row.id)));
    }
    db.prepare('DELETE FROM images WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)').run(normalizedFileId);
    db.prepare('DELETE FROM chunks WHERE file_id = ?').run(normalizedFileId);
  })();
}

async function processGenerationImages({
  generation,
  imageRecords,
  configSnapshot,
}) {
  const handle = getGenerationHandle(generation);
  const { db, vecEnabled } = handle;
  const canEmbedImages = vecEnabled &&
    Boolean(configSnapshot?.embeddingMultimodalEnabled) &&
    supportsImageEmbedding(configSnapshot || {});

  if (!imageRecords.length) {
    return {
      imageVectorIndexed: 1,
      imageError: null,
    };
  }

  const updateImage = db.prepare(`
    UPDATE images
    SET status = ?,
        local_path = ?,
        processed_at = ?,
        cache_status = ?,
        cache_error = ?,
        mime_type = ?,
        content_length = ?,
        cached_at = ?,
        embedding_status = ?,
        embedding_error = ?,
        embedded_at = ?
    WHERE id = ?
  `);
  const insertImageVec = canEmbedImages
    ? db.prepare('INSERT INTO images_vec (image_id, embedding) VALUES (?, ?)')
    : null;

  let failed = false;
  let firstError = null;

  for (const image of imageRecords) {
    if (!canEmbedImages) {
      updateImage.run(
        'pending',
        null,
        null,
        'pending',
        null,
        null,
        null,
        null,
        'skipped',
        null,
        null,
        image.id
      );
      continue;
    }

    if (!/^https?:\/\//i.test(String(image.url || ''))) {
      updateImage.run(
        'pending',
        null,
        null,
        'skipped',
        null,
        null,
        null,
        null,
        'skipped',
        null,
        null,
        image.id
      );
      continue;
    }

    try {
      const cached = await downloadImage(image.url);
      const now = new Date().toISOString();
      const embedding = await getImageEmbedding({
        absolutePath: cached.absolutePath,
        mimeType: cached.mimeType,
        sourceUrl: image.url,
      }, configSnapshot || {});

      if (insertImageVec) {
        insertImageVec.run(BigInt(image.id), JSON.stringify(embedding));
      }
      updateImage.run(
        'done',
        cached.relativePath,
        now,
        'done',
        null,
        cached.mimeType,
        cached.contentLength,
        now,
        'done',
        null,
        now,
        image.id
      );
    } catch (error) {
      failed = true;
      if (!firstError) firstError = error?.message || '图片向量化失败';
      const message = error?.message || '图片向量化失败';
      updateImage.run(
        'failed',
        null,
        null,
        'failed',
        message,
        null,
        null,
        null,
        'failed',
        message,
        null,
        image.id
      );
    }
  }

  return {
    imageVectorIndexed: failed ? 0 : 1,
    imageError: firstError,
  };
}

async function indexFileToGeneration({
  generation,
  relativePath,
  fileId,
  content = null,
} = {}) {
  const normalizedPath = ensureMarkdownPath(relativePath);
  const source = content === null ? readMarkdownFile(normalizedPath) : String(content || '');
  const contentHash = sha256(source);
  const handle = getGenerationHandle(generation);
  const { db, vecEnabled } = handle;
  const configSnapshot = generation?.config_snapshot_object || {};
  const chunks = await splitIntoChunks(source);

  let embeddings = null;
  let embeddingError = null;
  if (chunks.length > 0 && vecEnabled) {
    try {
      const inputs = chunks.map((chunk) => `${chunk.heading_path || ''}\n${chunk.content}`);
      embeddings = await getEmbeddings(inputs, configSnapshot);
    } catch (error) {
      embeddingError = ensureError(error, 'INDEX_EMBEDDING_FAILED', '向量化失败');
      logger.warn('indexer.embedding_failed', {
        generation_id: generation?.id,
        file_id: fileId,
        file_path: normalizedPath,
        error: embeddingError,
      });
    }
  }

  const insertChunk = db.prepare(`
    INSERT INTO chunks (
      file_id, content, type, position, line_start, line_end, heading_path, has_image, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertImage = db.prepare(`
    INSERT INTO images (
      chunk_id, url, alt_text, status, cache_status, embedding_status
    ) VALUES (?, ?, ?, 'pending', 'pending', 'pending')
  `);
  const insertVec = vecEnabled
    ? db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)')
    : null;

  const imageRecords = [];
  db.transaction(() => {
    deleteFileVectors(db, fileId, vecEnabled);

    chunks.forEach((chunk, index) => {
      const row = insertChunk.run(
        Number(fileId),
        chunk.content,
        chunk.type,
        chunk.position,
        chunk.line_start,
        chunk.line_end,
        chunk.heading_path,
        chunk.has_image,
        chunk.search_text
      );
      const chunkId = row.lastInsertRowid;

      if (insertVec && embeddings?.[index]) {
        insertVec.run(BigInt(chunkId), JSON.stringify(embeddings[index]));
      }

      extractImages(chunk.content).forEach((image) => {
        const imageRow = insertImage.run(chunkId, image.url, image.alt_text || '');
        imageRecords.push({
          id: Number(imageRow.lastInsertRowid),
          chunk_id: Number(chunkId),
          url: image.url,
          alt_text: image.alt_text || '',
        });
      });
    });
  })();

  const imageOutcome = await processGenerationImages({
    generation,
    imageRecords,
    configSnapshot,
  });

  const textIndexed = 1;
  const vectorIndexed = chunks.length === 0 ? 1 : (embeddingError ? 0 : (vecEnabled ? 1 : 0));
  const imageVectorIndexed = imageOutcome.imageVectorIndexed;
  const vectorUnavailable = chunks.length > 0 && !vecEnabled;
  const degraded = Boolean(embeddingError || imageOutcome.imageError || vectorUnavailable);
  const status = textIndexed ? (degraded ? 'degraded' : 'ready') : 'failed';
  const error = embeddingError?.message ||
    imageOutcome.imageError ||
    (vectorUnavailable ? '当前索引库未启用向量能力，已降级为文本检索' : null);

  return {
    fileId: Number(fileId),
    path: normalizedPath,
    contentHash,
    chunksCount: chunks.length,
    textIndexed,
    vectorIndexed,
    imageVectorIndexed,
    status,
    error,
  };
}

function removeFileFromGeneration(generation, { fileId } = {}) {
  if (!fileId) return;
  const handle = getGenerationHandle(generation);
  deleteFileVectors(handle.db, fileId, handle.vecEnabled);
}

module.exports = {
  splitIntoChunks,
  indexFileToGeneration,
  removeFileFromGeneration,
};
