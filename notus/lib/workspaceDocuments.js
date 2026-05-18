const { getDb } = require('./db');
const { getFileById, sha256 } = require('./files');
const { retrieveKnowledgeContext } = require('./retrieval');
const { getVisibleDocumentLabel } = require('./documentLabels');
const {
  estimateTextTokens,
  trimTextToTokenBudget,
} = require('./llmBudget');

const DEFAULT_TOTAL_DOCUMENT_TOKENS = 50000;
const DEFAULT_SINGLE_DOCUMENT_TOKENS = 18000;

function scoreDocuments(chunks = [], sections = []) {
  const scores = new Map();
  chunks.forEach((chunk) => {
    const fileId = Number(chunk.file_id || 0);
    if (!fileId) return;
    const score = Number(chunk.score || 0);
    scores.set(fileId, Math.max(scores.get(fileId) || 0, score));
  });
  sections.forEach((section) => {
    const fileId = Number(section.file_id || 0);
    if (!fileId) return;
    const score = Number(section.score || 0) * 0.92;
    scores.set(fileId, Math.max(scores.get(fileId) || 0, score));
  });
  return [...scores.entries()]
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .map(([fileId, score]) => ({ fileId, score }));
}

function rowsForFile(chunks = [], fileId) {
  return chunks.filter((chunk) => Number(chunk.file_id || 0) === Number(fileId));
}

function sectionsForFile(sections = [], fileId) {
  return sections.filter((section) => Number(section.file_id || 0) === Number(fileId));
}

function formatOutline(outline = []) {
  if (!Array.isArray(outline) || outline.length === 0) return '';
  return outline
    .slice(0, 80)
    .map((item) => `${'  '.repeat(Math.max(0, Number(item.level || 1) - 1))}- L${item.line || '?'} ${item.title || ''}`)
    .join('\n');
}

function buildCompactDocumentContent(file, matchedSections = [], tokenBudget) {
  const outline = formatOutline(file.heading_outline || []);
  const sectionText = matchedSections
    .map((section) => [
      section.heading_path ? `## ${section.heading_path}` : '## 命中片段',
      section.content || section.preview || '',
    ].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  const source = [
    outline ? `# 文档大纲\n${outline}` : '',
    sectionText ? `# 命中章节\n${sectionText}` : '',
  ].filter(Boolean).join('\n\n') || file.content;
  return trimTextToTokenBudget(source, tokenBudget);
}

function loadFileDocument(fileId, options = {}) {
  const file = getFileById(fileId);
  if (!file) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(fileId));
  const currentHash = sha256(file.content);
  const staleIndex = Boolean(row?.hash && currentHash !== row.hash);
  const tokenCount = Number(row?.token_count || file.token_count || estimateTextTokens(file.content));
  const matchedChunks = rowsForFile(options.chunks, fileId);
  const matchedSections = sectionsForFile(options.sections, fileId);
  const singleBudget = Number(options.singleDocumentTokens || DEFAULT_SINGLE_DOCUMENT_TOKENS);
  const includeFull = tokenCount <= singleBudget;
  const content = includeFull
    ? file.content
    : buildCompactDocumentContent(file, matchedSections, singleBudget);

  return {
    id: Number(file.id),
    stable_id: file.stable_id || row?.stable_id || null,
    path: file.path,
    title: getVisibleDocumentLabel(file, '未命名文档'),
    hash: currentHash,
    indexed_hash: row?.hash || '',
    stale_index: staleIndex,
    token_count: tokenCount,
    char_count: file.content.length,
    truncated: !includeFull,
    content,
    matched_chunks: matchedChunks.map((chunk) => chunk.chunk_id),
    matched_sections: matchedSections.map((section) => section.key),
    match_count: matchedChunks.length,
  };
}

function summarizeDocumentsForClient(documents = []) {
  return documents.map((doc) => ({
    id: doc.id,
    stable_id: doc.stable_id,
    path: doc.path,
    title: doc.title,
    stale_index: Boolean(doc.stale_index),
    truncated: Boolean(doc.truncated),
    token_count: Number(doc.token_count || 0),
    match_count: Number(doc.match_count || 0),
  }));
}

function buildWorkspaceDocumentStats(documents = []) {
  return {
    document_count: documents.length,
    full_document_count: documents.filter((doc) => !doc.truncated).length,
    truncated_document_count: documents.filter((doc) => doc.truncated).length,
    stale_document_count: documents.filter((doc) => doc.stale_index).length,
    document_token_count: documents.reduce((sum, doc) => sum + estimateTextTokens(doc.content || ''), 0),
  };
}

async function retrieveWorkspaceDocuments(queryInput, opts = {}) {
  const knowledgeContext = opts.knowledgeContext || await retrieveKnowledgeContext(queryInput, opts);
  const ranked = scoreDocuments(knowledgeContext.chunks || [], knowledgeContext.sections || []);
  const maxDocuments = Number(opts.maxDocuments || 5);
  const totalBudget = Number(opts.maxDocumentTokens || DEFAULT_TOTAL_DOCUMENT_TOKENS);
  const selected = [];
  let usedTokens = 0;

  ranked.slice(0, Math.max(maxDocuments * 2, maxDocuments)).some(({ fileId }) => {
    const doc = loadFileDocument(fileId, {
      chunks: knowledgeContext.chunks || [],
      sections: knowledgeContext.sections || [],
      singleDocumentTokens: opts.singleDocumentTokens,
    });
    if (!doc) return false;
    const contentTokens = estimateTextTokens(doc.content || '');
    if (selected.length > 0 && usedTokens + contentTokens > totalBudget) return true;
    selected.push(doc);
    usedTokens += contentTokens;
    return selected.length >= maxDocuments;
  });

  return {
    ...knowledgeContext,
    documents: selected,
    document_summaries: summarizeDocumentsForClient(selected),
    document_stats: buildWorkspaceDocumentStats(selected),
  };
}

module.exports = {
  buildWorkspaceDocumentStats,
  loadFileDocument,
  retrieveWorkspaceDocuments,
  summarizeDocumentsForClient,
};
