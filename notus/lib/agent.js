const { getDb } = require('./db');
const { hybridSearch } = require('./retrieval');
const { completeChat } = require('./llm');
const { buildAgentSystemPrompt } = require('./prompt');
const { getGenerationDb } = require('./indexGenerationDb');
const { getActiveGeneration, ensureActiveGeneration } = require('./indexGenerations');

const STYLE_SAMPLE_MIN_LENGTH = 60;
const STYLE_SAMPLE_MAX_LENGTH = 420;
const DEFAULT_STYLE_SAMPLE_LIMIT = 8;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '搜索知识库中的事实内容，用于补充文章依据或例子',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topK: { type: 'integer', default: 5 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_style_samples',
      description: '补充更多可模仿的写作风格样本，会优先从用户指定文章或代表性笔记里挑完整段落',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          k: { type: 'integer', default: 6 },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_outline',
      description: '返回一组简单的大纲块',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_block',
      description: '为某个块起草替换内容',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string' },
          instruction: { type: 'string' },
        },
        required: ['block_id', 'instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'expand_block',
      description: '扩写一个块',
      parameters: {
        type: 'object',
        properties: { block_id: { type: 'string' } },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shrink_block',
      description: '压缩一个块',
      parameters: {
        type: 'object',
        properties: { block_id: { type: 'string' } },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'polish_style',
      description: '按当前风格要求润色一个块',
      parameters: {
        type: 'object',
        properties: { block_id: { type: 'string' }, instruction: { type: 'string' } },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_block',
      description: '在某个块后插入新块',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string' },
          content: { type: 'string' },
          type: { type: 'string' },
        },
        required: ['block_id', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_block',
      description: '删除某个块',
      parameters: {
        type: 'object',
        properties: { block_id: { type: 'string' } },
        required: ['block_id'],
      },
    },
  },
];

function findBlock(article, blockId) {
  return (article.blocks || []).find((block) => block.id === blockId);
}

function safeJsonParse(content) {
  if (!content) return null;
  const text = String(content).trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```json\s*([\s\S]+?)```/i) || text.match(/```([\s\S]+?)```/i);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeFileIds(value) {
  const input = Array.isArray(value) ? value : [];
  return [...new Set(
    input
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0)
  )];
}

function normalizeStyleSource(styleSource = 'auto') {
  if (styleSource === 'manual' || styleSource === 'auto') {
    return { mode: styleSource, fileIds: [] };
  }

  return {
    mode: styleSource?.mode === 'manual' ? 'manual' : 'auto',
    fileIds: normalizeFileIds(styleSource?.file_ids),
  };
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sanitizeStyleQuery(text) {
  return normalizeWhitespace(String(text || '').replace(/@b\d+/gi, ' '));
}

function buildLinesLabel(lineStart, lineEnd) {
  const start = Number(lineStart);
  const end = Number(lineEnd);
  if (!Number.isFinite(start) || start <= 0) return '';
  if (!Number.isFinite(end) || end <= start) return `L${start}`;
  return `L${start}-${end}`;
}

function normalizeCitation(item, kind = 'knowledge') {
  if (!item) return null;
  const fileId = Number(item.file_id);
  const lineStart = Number(item.line_start);
  const lineEnd = Number(item.line_end);
  return {
    citation_kind: item.citation_kind || kind,
    file: item.file_title || item.file || '',
    file_title: item.file_title || item.file || '',
    file_id: Number.isFinite(fileId) ? fileId : null,
    path: item.heading_path || item.path || '',
    heading_path: item.heading_path || item.path || '',
    quote: item.preview || item.content || item.quote || '',
    preview: item.preview || item.quote || item.content || '',
    lines: item.lines || buildLinesLabel(lineStart, lineEnd),
    line_start: Number.isFinite(lineStart) ? lineStart : null,
    line_end: Number.isFinite(lineEnd) ? lineEnd : null,
    image_id: item.image_id || null,
    image_url: item.image_url || null,
    image_proxy_url: item.image_proxy_url || null,
    image_alt_text: item.image_alt_text || '',
    image_caption: item.image_caption || '',
  };
}

function citationKey(item) {
  return [
    item.citation_kind || '',
    item.file_id || '',
    item.heading_path || '',
    item.line_start || '',
    item.line_end || '',
    normalizeWhitespace(item.preview || item.quote || '').slice(0, 120),
  ].join('::');
}

function mergeCitations(existing = [], additions = []) {
  const map = new Map();
  [...existing, ...additions]
    .map((item) => normalizeCitation(item, item?.citation_kind || 'knowledge'))
    .filter(Boolean)
    .forEach((item) => {
      map.set(citationKey(item), item);
    });
  return [...map.values()];
}

function styleSampleKey(sample) {
  return [
    sample.file_id || '',
    sample.heading_path || '',
    sample.line_start || '',
    sample.line_end || '',
    normalizeWhitespace(sample.content || sample.preview || '').slice(0, 160),
  ].join('::');
}

function isLikelyStyleSample(sample) {
  const text = normalizeWhitespace(sample.content || sample.preview || '');
  if (text.length < STYLE_SAMPLE_MIN_LENGTH || text.length > STYLE_SAMPLE_MAX_LENGTH) return false;
  if (/```|~~~/.test(text)) return false;
  if (/^\s*(#|[-*]|\d+\.)\s/.test(text)) return false;
  if (/\|/.test(text) && !/[。！？!?；;]/.test(text)) return false;
  if (/<[^>]+>/.test(text)) return false;
  if (!/[。！？!?；;]/.test(text)) return false;
  const markdownNoise = (text.match(/[#*`>\[\]\(\)!_]/g) || []).length;
  return markdownNoise <= Math.max(18, Math.floor(text.length * 0.12));
}

function scoreStyleSample(sample, preferredFileIds = []) {
  const text = normalizeWhitespace(sample.content || sample.preview || '');
  const lengthScore = Math.max(0, 90 - Math.abs(150 - text.length));
  const punctuationCount = (text.match(/[。！？!?；;]/g) || []).length;
  let score = lengthScore + Math.min(punctuationCount * 4, 24);

  if (sample.type === 'paragraph') score += 28;
  if (sample.type === 'heading') score -= 20;
  if (/我|我们|自己|觉得|发现|看到|想起/.test(text)) score += 8;
  if (/比如|例如|像是|其实|因此|不过|但/.test(text)) score += 6;
  if (preferredFileIds.includes(Number(sample.file_id))) score += 12;
  if (/```|~~~|^\s*(#|[-*]|\d+\.)\s/.test(text)) score -= 24;

  return score;
}

function enrichChunk(chunk) {
  if (!chunk) return null;
  const content = normalizeWhitespace(chunk.content || chunk.preview || chunk.quote || '');
  if (!content) return null;
  return {
    ...chunk,
    content,
    preview: chunk.preview || content.slice(0, 120),
  };
}

function mergeStyleSamples(existing = [], additions = [], preferredFileIds = []) {
  const merged = [...existing, ...additions]
    .map((sample) => enrichChunk(sample))
    .filter(Boolean);

  const deduped = new Map();
  merged.forEach((sample) => {
    const key = styleSampleKey(sample);
    const current = deduped.get(key);
    if (!current || scoreStyleSample(sample, preferredFileIds) > scoreStyleSample(current, preferredFileIds)) {
      deduped.set(key, sample);
    }
  });

  return [...deduped.values()]
    .filter((sample) => isLikelyStyleSample(sample) || normalizeWhitespace(sample.content).length >= 40)
    .sort((left, right) => scoreStyleSample(right, preferredFileIds) - scoreStyleSample(left, preferredFileIds));
}

function pickDiverseStyleSamples(samples = [], { limit = DEFAULT_STYLE_SAMPLE_LIMIT, perFile = 2 } = {}) {
  const picked = [];
  const counts = new Map();
  const queue = [...samples];

  queue.forEach((sample) => {
    if (picked.length >= limit) return;
    const fileId = Number(sample.file_id) || 0;
    const currentCount = counts.get(fileId) || 0;
    if (currentCount >= perFile) return;
    picked.push(sample);
    counts.set(fileId, currentCount + 1);
  });

  if (picked.length < limit) {
    queue.forEach((sample) => {
      if (picked.length >= limit) return;
      if (picked.some((item) => styleSampleKey(item) === styleSampleKey(sample))) return;
      picked.push(sample);
    });
  }

  return picked.slice(0, limit);
}

async function searchKnowledge(query, opts = {}) {
  const result = await hybridSearch(query, {
    topK: opts.topK || opts.top_k || 5,
    fileIds: normalizeFileIds(opts.fileIds || opts.file_ids),
  });
  const chunks = (result.chunks || []).map((chunk) => enrichChunk(chunk)).filter(Boolean);
  return {
    ...result,
    chunks,
    citations: chunks.map((chunk) => normalizeCitation(chunk, 'knowledge')).filter(Boolean),
  };
}

function listRecentFileIds(fileIds = [], limit = 12, excludeFileIds = []) {
  const db = getDb();
  const normalizedIds = normalizeFileIds(fileIds);
  const excludedIds = normalizeFileIds(excludeFileIds);
  const conditions = [];
  const params = [];

  if (normalizedIds.length > 0) {
    conditions.push(`id IN (${normalizedIds.map(() => '?').join(',')})`);
    params.push(...normalizedIds);
  }

  if (excludedIds.length > 0) {
    conditions.push(`id NOT IN (${excludedIds.map(() => '?').join(',')})`);
    params.push(...excludedIds);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT id
    FROM files
    ${where}
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT ?
  `).all(...params, Number(limit)).map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
}

function getRepresentativeChunksFromFiles(fileIds = [], opts = {}) {
  const normalizedIds = normalizeFileIds(fileIds);
  if (normalizedIds.length === 0) return [];

  const activeGeneration = getActiveGeneration() || ensureActiveGeneration();
  const generationDb = getGenerationDb(activeGeneration);
  const metadataDb = getDb();
  const fileRows = metadataDb.prepare(`
    SELECT id, title, path
    FROM files
    WHERE id IN (${normalizedIds.map(() => '?').join(',')})
  `).all(...normalizedIds);
  const metadataMap = new Map(fileRows.map((row) => [Number(row.id), row]));
  const preferredFileIds = normalizeFileIds(opts.preferredFileIds || normalizedIds);
  const perFile = Number(opts.perFile || 2);
  const limit = Number(opts.limit || DEFAULT_STYLE_SAMPLE_LIMIT);
  const samples = [];

  normalizedIds.forEach((fileId) => {
    const metadata = metadataMap.get(fileId);
    if (!metadata) return;

    const rows = generationDb.prepare(`
      SELECT id AS chunk_id, file_id, content, type, heading_path, line_start, line_end
      FROM chunks
      WHERE file_id = ?
      ORDER BY position ASC
      LIMIT 48
    `).all(fileId);

    const ranked = rows
      .map((row) => ({
        ...row,
        file_title: metadata.title || metadata.path,
        file_path: metadata.path,
        preview: normalizeWhitespace(row.content || '').slice(0, 120),
      }))
      .map((row) => enrichChunk(row))
      .filter(Boolean)
      .filter((row) => isLikelyStyleSample(row) || normalizeWhitespace(row.content).length >= 40)
      .sort((left, right) => scoreStyleSample(right, preferredFileIds) - scoreStyleSample(left, preferredFileIds))
      .slice(0, perFile);

    samples.push(...ranked);
  });

  return pickDiverseStyleSamples(
    mergeStyleSamples([], samples, preferredFileIds),
    { limit, perFile }
  );
}

async function collectStyleSamples({ article, userInput, styleSource, query, limit = DEFAULT_STYLE_SAMPLE_LIMIT }) {
  const mode = styleSource?.mode === 'manual' ? 'manual' : 'auto';
  const fileIds = normalizeFileIds(styleSource?.fileIds);
  const articleFileId = Number(article?.file_id || article?.fileId);
  const recentFileIds = mode === 'manual'
    ? fileIds
    : listRecentFileIds([], 12, Number.isFinite(articleFileId) ? [articleFileId] : []);

  const diverseSamples = getRepresentativeChunksFromFiles(
    recentFileIds,
    {
      perFile: mode === 'manual' ? 2 : 1,
      limit: Math.max(limit, 6),
      preferredFileIds: fileIds,
    }
  );

  const relatedQueries = [...new Set(
    [query, userInput, article?.title]
      .map((item) => sanitizeStyleQuery(item))
      .filter((item) => item && item.length >= 2)
  )].slice(0, 2);

  const relatedResults = await Promise.all(
    relatedQueries.map((item) => searchKnowledge(item, {
      topK: Math.max(limit, 6),
      fileIds: mode === 'manual' ? fileIds : [],
    }))
  );

  const relatedSamples = relatedResults.flatMap((result) => result.chunks || []);
  const mergedSamples = mergeStyleSamples(
    [],
    [...diverseSamples, ...relatedSamples],
    fileIds
  );
  const finalSamples = pickDiverseStyleSamples(
    mergedSamples,
    {
      limit,
      perFile: mode === 'manual' ? 2 : 1,
    }
  );

  return {
    samples: finalSamples,
    citations: finalSamples.map((sample) => normalizeCitation(sample, 'style')).filter(Boolean),
  };
}

function formatStyleProfile(profile) {
  if (!profile) return '';

  const lines = [];
  if (profile.rhythm) lines.push(`- 句子节奏：${profile.rhythm}`);
  if (profile.perspective) lines.push(`- 人称与视角：${profile.perspective}`);
  if (profile.rhetoric) lines.push(`- 惯用修辞：${profile.rhetoric}`);
  if (profile.structure) lines.push(`- 段落结构：${profile.structure}`);
  if (profile.vocabulary) lines.push(`- 词汇风格：${profile.vocabulary}`);
  if (profile.application) lines.push(`- 应用要求：${profile.application}`);
  return lines.join('\n');
}

function buildFallbackStyleProfile(samples = []) {
  const sampleTexts = samples.map((sample) => normalizeWhitespace(sample.content || ''));
  const avgLength = sampleTexts.length > 0
    ? Math.round(sampleTexts.reduce((sum, text) => sum + text.length, 0) / sampleTexts.length)
    : 0;
  const hasFirstPerson = sampleTexts.some((text) => /我|我们|自己|想起|觉得|发现/.test(text));
  const hasContrast = sampleTexts.some((text) => /但|不过|然而|而是|其实/.test(text));
  const hasExamples = sampleTexts.some((text) => /比如|例如|像是/.test(text));

  return formatStyleProfile({
    rhythm: avgLength > 150 ? '句子偏舒展，常用一到两句完成一个完整意思。' : '句子偏中短，叙述节奏较快，常用简洁句收束。',
    perspective: hasFirstPerson ? '偏第一人称或贴近个人观察的视角。' : '偏客观描述与归纳式表达。',
    rhetoric: hasContrast ? '常用转折或对比推进观点。' : '修辞相对克制，更像顺着事实往前讲。',
    structure: hasExamples ? '常见“观点 + 例子 + 收束”结构。' : '更常见“背景 + 判断 + 总结句”结构。',
    vocabulary: '词汇应保持自然、具体、不过分夸张，优先使用与样本接近的表达浓度。',
    application: '生成时优先模仿节奏、结构和措辞，不照搬样本事实。',
  });
}

async function analyzeStyleSamples(samples = [], mode = 'auto') {
  if (!samples.length) return '';

  const promptSamples = samples.slice(0, 6).map((sample, index) => {
    const meta = [
      sample.file_title || sample.file || '未命名笔记',
      sample.heading_path || sample.path || '',
      buildLinesLabel(sample.line_start, sample.line_end),
    ].filter(Boolean).join(' · ');
    return `[样本 ${index + 1}] ${meta}\n${sample.content || sample.preview || ''}`;
  }).join('\n\n');

  try {
    const reply = await completeChat([
      {
        role: 'system',
        content: [
          '你是写作风格分析助手。',
          '请只分析表达方式，不提取事实内容。',
          '只输出 JSON，格式为 {"rhythm":"","perspective":"","rhetoric":"","structure":"","vocabulary":"","application":""}。',
          mode === 'manual'
            ? '当前是手动风格来源模式，应用要求里要强调“只参考这些样本的风格”。'
            : '当前是自动风格来源模式，应用要求里要强调“模仿风格但不要照搬事实”。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `请基于以下风格样本，提炼五个维度的写作画像：\n\n${promptSamples}`,
      },
    ], {
      responseFormat: { type: 'json_object' },
    });

    const parsed = safeJsonParse(reply.content);
    return formatStyleProfile(parsed) || buildFallbackStyleProfile(samples);
  } catch {
    return buildFallbackStyleProfile(samples);
  }
}

function buildStylePromptContext(context) {
  return {
    mode: context.styleMode,
    summary: context.styleProfile,
    samples: context.styleSamples.slice(0, 6),
    citationCount: context.styleCitations.length,
  };
}

function updateSystemPrompt(history, context) {
  history[0] = {
    role: 'system',
    content: [
      buildAgentSystemPrompt(context.article.blocks || [], buildStylePromptContext(context)),
      '你可以调用工具。最终必须只输出 JSON：{"operations":[...],"citations":[...]}。',
    ].join('\n\n'),
  };
}

async function refreshStyleContext(context, nextSamples = []) {
  const previousKeys = new Set(context.styleSamples.map((sample) => styleSampleKey(sample)));
  context.styleSamples = mergeStyleSamples(context.styleSamples, nextSamples, context.styleFileIds)
    .slice(0, DEFAULT_STYLE_SAMPLE_LIMIT);
  context.styleCitations = mergeCitations(
    context.styleCitations,
    nextSamples.map((sample) => normalizeCitation(sample, 'style')).filter(Boolean)
  );

  const hasNewSample = context.styleSamples.some((sample) => !previousKeys.has(styleSampleKey(sample)));
  if (hasNewSample || (!context.styleProfile && context.styleSamples.length > 0)) {
    context.styleProfile = await analyzeStyleSamples(context.styleSamples, context.styleMode);
  }
}

async function generateOperation(article, blockId, instruction, styleContext = {}, mode = 'replace', llmConfig = null) {
  const block = findBlock(article, blockId);
  if (!block && mode !== 'insert') throw new Error('BLOCK_NOT_FOUND');

  const messages = [
    {
      role: 'system',
      content: [
        buildAgentSystemPrompt(article.blocks || [], styleContext),
        '你现在只需要返回一次 JSON 操作，不要输出解释。',
        '返回格式：{"op":"replace|insert|delete","block_id":"...","old":"...","new":"...","position":"after","type":"paragraph"}。',
        '如果是 replace，必须带 old 和 new。',
        '如果是 insert，必须带 block_id、position、type、new。',
        '如果是 delete，必须带 block_id 和 old。',
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        article_title: article.title,
        block,
        instruction,
        mode,
        style_summary: styleContext.summary || '',
        style_samples: (styleContext.samples || []).map((sample) => sample.content || sample.preview || ''),
      }),
    },
  ];

  const reply = await completeChat(messages, {
    responseFormat: { type: 'json_object' },
    config: llmConfig || undefined,
  });
  const parsed = safeJsonParse(reply.content);
  if (!parsed?.op) throw new Error('操作结果解析失败');
  return parsed;
}

async function executeTool(name, args, context) {
  if (name === 'search_knowledge') {
    return searchKnowledge(args.query, { topK: args.topK || 5 });
  }

  if (name === 'get_style_samples') {
    const pack = await collectStyleSamples({
      article: context.article,
      userInput: context.userInput,
      styleSource: { mode: context.styleMode, fileIds: context.styleFileIds },
      query: args.topic,
      limit: Math.max(Number(args.k || 6), 4),
    });
    return pack;
  }

  if (name === 'get_outline') {
    return {
      outline: [
        { id: 'b_outline_1', type: 'heading', content: `# ${args.topic}` },
        { id: 'b_outline_2', type: 'paragraph', content: `围绕“${args.topic}”展开背景、问题和结论。` },
      ],
    };
  }

  if (name === 'draft_block') {
    return {
      operation: await generateOperation(
        context.article,
        args.block_id,
        args.instruction,
        buildStylePromptContext(context),
        'replace',
        context.llmConfig
      ),
    };
  }

  if (name === 'expand_block') {
    return {
      operation: await generateOperation(
        context.article,
        args.block_id,
        '扩写这段内容，补足论证和细节。',
        buildStylePromptContext(context),
        'replace',
        context.llmConfig
      ),
    };
  }

  if (name === 'shrink_block') {
    return {
      operation: await generateOperation(
        context.article,
        args.block_id,
        '精简这段内容，保留核心信息。',
        buildStylePromptContext(context),
        'replace',
        context.llmConfig
      ),
    };
  }

  if (name === 'polish_style') {
    return {
      operation: await generateOperation(
        context.article,
        args.block_id,
        args.instruction || '按当前风格要求润色这段内容。',
        buildStylePromptContext(context),
        'replace',
        context.llmConfig
      ),
    };
  }

  if (name === 'insert_block') {
    return {
      operation: {
        op: 'insert',
        block_id: args.block_id,
        position: 'after',
        type: args.type || 'paragraph',
        new: args.content,
      },
    };
  }

  if (name === 'delete_block') {
    const block = findBlock(context.article, args.block_id);
    return {
      operation: {
        op: 'delete',
        block_id: args.block_id,
        old: block?.content || '',
      },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function prepareInitialStyleContext(context) {
  const pack = await collectStyleSamples({
    article: context.article,
    userInput: context.userInput,
    styleSource: { mode: context.styleMode, fileIds: context.styleFileIds },
    query: context.article?.title || context.userInput,
    limit: DEFAULT_STYLE_SAMPLE_LIMIT,
  });

  context.styleSamples = pack.samples;
  context.styleCitations = pack.citations;
  context.citations = mergeCitations(context.citations, pack.citations);
  context.styleProfile = await analyzeStyleSamples(context.styleSamples, context.styleMode);
}

async function runAgent({ userInput, article, styleSource, llmConfig = null }, onStream) {
  const normalizedStyleSource = normalizeStyleSource(styleSource);
  if (normalizedStyleSource.mode === 'manual' && normalizedStyleSource.fileIds.length === 0) {
    throw new Error('手动风格来源至少选择 1 篇文章');
  }
  const context = {
    article,
    userInput,
    styleMode: normalizedStyleSource.mode,
    styleFileIds: normalizedStyleSource.fileIds,
    styleSamples: [],
    styleCitations: [],
    styleProfile: '',
    citations: [],
    operations: [],
    llmConfig,
  };

  if (onStream) onStream({ type: 'thinking', text: '正在整理风格样本并分析创作请求…' });
  await prepareInitialStyleContext(context);

  const history = [
    { role: 'system', content: '' },
    {
      role: 'user',
      content: JSON.stringify({
        user_input: userInput,
        article_title: article.title,
        style_source: {
          mode: context.styleMode,
          file_ids: context.styleFileIds,
          preloaded_samples: context.styleSamples.length,
        },
      }),
    },
  ];
  updateSystemPrompt(history, context);

  for (let round = 0; round < 4; round += 1) {
    const reply = await completeChat(history, { tools: TOOLS, config: llmConfig || undefined });

    if (reply.tool_calls?.length) {
      history.push({
        role: 'assistant',
        content: reply.content || '',
        tool_calls: reply.tool_calls,
      });

      for (const call of reply.tool_calls) {
        const args = safeJsonParse(call.function.arguments) || {};
        if (onStream) onStream({ type: 'tool_call', name: call.function.name, args });
        const result = await executeTool(call.function.name, args, context);

        if (result.samples?.length) {
          await refreshStyleContext(context, result.samples);
          updateSystemPrompt(history, context);
        }
        if (result.citations?.length) {
          context.citations = mergeCitations(context.citations, result.citations);
        }
        if (result.operation) {
          context.operations.push(result.operation);
        }

        if (onStream) onStream({ type: 'tool_result', name: call.function.name, data: result });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    const parsed = safeJsonParse(reply.content);
    if (parsed?.operations || parsed?.citations) {
      return {
        operations: parsed.operations || context.operations,
        citations: mergeCitations(context.citations, parsed.citations || []),
      };
    }

    return {
      operations: context.operations,
      citations: context.citations,
      text: reply.content || '',
    };
  }

  return {
    operations: context.operations,
    citations: context.citations,
  };
}

module.exports = {
  TOOLS,
  runAgent,
};
