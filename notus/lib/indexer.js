const fs = require('fs');
const path = require('path');
const { getDb, isVecAvailable } = require('./db');
const { getEmbeddings } = require('./embeddings');
const { getEffectiveConfig } = require('./config');
const { buildSearchText } = require('./tokenizer');
const { processImagesForFile, deleteImageVectorsByFileId } = require('./images');
const {
  ensureMarkdownPath,
  extractTitle,
  readMarkdownFile,
  sha256,
} = require('./files');

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
    const headingPath = type === 'heading'
      ? headingStack.filter(Boolean).join(' > ')
      : headingStack.filter(Boolean).join(' > ');
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

function deleteOldVectors(db, fileId) {
  if (!isVecAvailable()) return;
  const oldChunkIds = db.prepare('SELECT id FROM chunks WHERE file_id = ?').all(fileId);
  const deleteVec = db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?');
  oldChunkIds.forEach((row) => deleteVec.run(BigInt(row.id)));
  deleteImageVectorsByFileId(fileId);
}

function resolveIndexPath(inputPath) {
  const config = getEffectiveConfig();
  if (path.isAbsolute(String(inputPath || ''))) {
    const root = path.resolve(config.notesDir);
    const absolute = path.resolve(inputPath);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw new Error('file is outside notes directory');
    }
    return path.relative(root, absolute).replace(/\\/g, '/');
  }
  return ensureMarkdownPath(inputPath);
}

async function indexFile(inputPath) {
  const db = getDb();
  const relativePath = resolveIndexPath(inputPath);
  const content = readMarkdownFile(relativePath);
  const hash = sha256(content);
  const title = extractTitle(relativePath, content);

  const existing = db.prepare('SELECT id, hash, indexed FROM files WHERE path = ?').get(relativePath);
  if (existing && existing.hash === hash && existing.indexed === 1) {
    return { fileId: existing.id, chunksCount: 0, skipped: true };
  }

  const upsert = db.prepare(`
    INSERT INTO files (path, title, hash, indexed, indexed_at, index_error, updated_at)
    VALUES (?, ?, ?, 0, NULL, NULL, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      hash = excluded.hash,
      indexed = 0,
      indexed_at = NULL,
      index_error = NULL,
      updated_at = excluded.updated_at
  `).run(relativePath, title, hash);

  const fileId = existing?.id || upsert.lastInsertRowid;
  const chunks = await splitIntoChunks(content);
  let embeddings = null;
  let embeddingError = null;

  try {
    const embeddingInputs = chunks.map((chunk) => `${chunk.heading_path || ''}\n${chunk.content}`);
    embeddings = embeddingInputs.length > 0 ? await getEmbeddings(embeddingInputs) : [];
  } catch (error) {
    embeddingError = error;
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
  const insertVec = isVecAvailable()
    ? db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)')
    : null;

  db.transaction(() => {
    deleteOldVectors(db, fileId);
    db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);

    chunks.forEach((chunk, index) => {
      const result = insertChunk.run(
        fileId,
        chunk.content,
        chunk.type,
        chunk.position,
        chunk.line_start,
        chunk.line_end,
        chunk.heading_path,
        chunk.has_image,
        chunk.search_text
      );
      const chunkId = result.lastInsertRowid;

      if (insertVec && embeddings?.[index]) {
        insertVec.run(BigInt(chunkId), JSON.stringify(embeddings[index]));
      }

      extractImages(chunk.content).forEach((image) => {
        insertImage.run(chunkId, image.url, image.alt_text || '');
      });
    });

    if (embeddingError) {
      db.prepare(`
        UPDATE files
        SET indexed = 0,
            index_error = ?,
            retry_count = retry_count + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(embeddingError.message, fileId);
    } else {
      db.prepare(`
        UPDATE files
        SET indexed = 1,
            indexed_at = datetime('now'),
            index_error = NULL,
            retry_count = 0,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(fileId);
    }
  })();

  if (chunks.some((chunk) => chunk.has_image)) {
    await processImagesForFile(fileId).catch((error) => {
      console.error('[indexer] image processing failed:', error);
    });
  }

  return {
    fileId,
    chunksCount: chunks.length,
    skipped: false,
    embeddingFailed: Boolean(embeddingError),
    error: embeddingError?.message || null,
  };
}

async function indexBatch(paths, onProgress) {
  const results = { indexed: 0, skipped: 0, failed: 0, errors: [] };
  for (let index = 0; index < paths.length; index += 1) {
    const currentFile = paths[index];
    try {
      const result = await indexFile(currentFile);
      if (result.skipped) results.skipped += 1;
      else if (result.embeddingFailed) {
        results.failed += 1;
        results.errors.push({ path: currentFile, error: result.error });
      } else results.indexed += 1;
    } catch (error) {
      results.failed += 1;
      results.errors.push({ path: currentFile, error: error.message });
    }
    if (onProgress) {
      onProgress({
        current: index + 1,
        total: paths.length,
        currentFile,
      });
    }
  }
  return results;
}

function removeFile(relativePath) {
  const db = getDb();
  const normalized = ensureMarkdownPath(relativePath);
  const row = db.prepare('SELECT id FROM files WHERE path = ?').get(normalized);
  if (row) deleteOldVectors(db, row.id);
  db.prepare('DELETE FROM files WHERE path = ?').run(normalized);
}

async function retryFailedIndexing(limit = 10) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT path FROM files
    WHERE indexed = 0 AND retry_count < 5
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(limit);
  return indexBatch(rows.map((row) => row.path));
}

async function rebuildIndex(onProgress) {
  const { listMarkdownFiles } = require('./files');
  const config = getEffectiveConfig();
  fs.mkdirSync(config.notesDir, { recursive: true });
  const paths = listMarkdownFiles();
  return indexBatch(paths, onProgress);
}

module.exports = {
  splitIntoChunks,
  indexFile,
  indexBatch,
  removeFile,
  retryFailedIndexing,
  rebuildIndex,
};
