const { ensureRuntime } = require('../../../lib/runtime');
const { getFileById } = require('../../../lib/files');
const { hybridSearch, retrieveKnowledgeContext } = require('../../../lib/retrieval');
const { completeChat } = require('../../../lib/llm');
const { buildOutlinePrompt } = require('../../../lib/prompt');
const {
  sanitizeKnowledgeSections,
  sanitizeStyleSamples,
} = require('../../../lib/contextCompaction');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function safeJsonParse(content) {
  if (!content) return null;
  const text = String(content).trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```json\s*([\s\S]+?)```/i) || text.match(/```([\s\S]+?)```/i);
    if (!match) return null;
    try {
      return JSON.parse(match[1].trim());
    } catch {
      return null;
    }
  }
}

function fallbackBlocks(topic, chunks) {
  return [
    { id: 'b_1', type: 'heading', content: `# ${topic}` },
    { id: 'b_2', type: 'paragraph', content: chunks[0]?.preview || '先写出这个主题的背景和核心问题。' },
    { id: 'b_3', type: 'heading', content: '## 主要观点' },
    { id: 'b_4', type: 'paragraph', content: '结合已有笔记，展开几个主要观点。' },
  ];
}

function summarizeCurrentDocument(file) {
  if (!file?.content) return null;
  const lines = String(file.content)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const outline = lines.filter((line) => /^#{1,4}\s/.test(line)).slice(0, 5).join(' | ');
  const summary = lines.filter((line) => !/^#{1,6}\s/.test(line)).slice(0, 4).join(' ').slice(0, 280);
  return {
    id: file.id,
    title: file.title || file.name,
    outline,
    summary,
  };
}

async function loadStyleSamples(topic, options = {}) {
  const activeFileId = Number(options.activeFileId) || null;
  const styleMode = options.styleMode || 'auto';
  const manualStyleFileIds = Array.isArray(options.styleFileIds) ? options.styleFileIds : [];

  if (styleMode === 'manual') {
    if (manualStyleFileIds.length === 0) return [];
    return hybridSearch(topic, { topK: 6, fileIds: manualStyleFileIds });
  }

  const preferred = activeFileId
    ? await hybridSearch(topic, { topK: 3, fileIds: [activeFileId], vecThreshold: 0.2 })
    : [];
  const supplemental = await hybridSearch(topic, { topK: 4 });
  const byChunk = new Map();
  [...preferred, ...supplemental].forEach((chunk) => {
    if (!chunk?.chunk_id || byChunk.has(chunk.chunk_id)) return;
    byChunk.set(chunk.chunk_id, chunk);
  });
  return [...byChunk.values()].slice(0, 6);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const {
    topic,
    active_file_id: activeFileId,
    reference_mode: referenceMode = 'auto',
    reference_file_ids: referenceFileIds = [],
    style_mode: styleMode = 'auto',
    style_file_ids: styleFileIds = [],
  } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic is required', code: 'TOPIC_REQUIRED' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const currentDocument = summarizeCurrentDocument(getFileById(activeFileId));
    const factContext = await retrieveKnowledgeContext(topic, {
      topK: 4,
      activeFileId,
      fileIds: referenceMode === 'manual' ? referenceFileIds : [],
      restrictToFileIds: referenceMode === 'manual',
    });
    const styleSamples = await loadStyleSamples(topic, {
      activeFileId,
      styleMode,
      styleFileIds,
    });
    const compactSections = sanitizeKnowledgeSections(factContext.sections, {
      sectionLimit: 3,
      quoteLimit: 2,
      quoteTokenBudget: 110,
    });
    const compactStyleSamples = sanitizeStyleSamples(styleSamples, {
      limit: 4,
      contentTokenBudget: 150,
    });
    const reply = await completeChat(
      buildOutlinePrompt(topic, {
        currentDocument,
        sections: compactSections,
        styleSamples: compactStyleSamples,
      }),
      {
        temperature: 0.3,
        taskType: 'outline_json',
      }
    );
    const parsed = safeJsonParse(reply.message?.content);
    const blocks = Array.isArray(parsed?.blocks) && parsed.blocks.length > 0
      ? parsed.blocks.map((block, index) => ({
        id: `b_${index + 1}`,
        type: block.type || (/^#{1,6}\s/.test(String(block.content || '')) ? 'heading' : 'paragraph'),
        content: String(block.content || '').trim(),
      })).filter((block) => block.content)
      : fallbackBlocks(topic, factContext.chunks);
    blocks.forEach((block) => send(res, { type: 'block', block }));
    send(res, {
      type: 'done',
      citations: factContext.chunks,
      sections: factContext.sections,
      usage: reply.usage || null,
      budget: reply.budget || null,
      compacted: Boolean(reply.compacted),
    });
  } catch (error) {
    send(res, { type: 'error', error: error.message });
  }

  return res.end();
}
