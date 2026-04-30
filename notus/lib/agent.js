const { hybridSearch, retrieveKnowledgeContext } = require('./retrieval');
const { completeChat } = require('./llm');
const { buildAgentSystemPrompt, formatStyleSamples } = require('./prompt');
const {
  buildHistorySummary,
  sanitizeKnowledgeChunks,
  sanitizeKnowledgeSections,
  sanitizeStyleSamples,
} = require('./contextCompaction');
const {
  sumUsageRecords,
  trimTextToTokenBudget,
} = require('./llmBudget');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '搜索知识库中的相关内容',
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
      description: '获取相近主题的风格样本',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' }, k: { type: 'integer', default: 3 } },
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
      description: '按风格润色一个块',
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

function resolveBlockReference(article, reference) {
  const normalized = String(reference || '').trim().toLowerCase();
  if (!normalized) return null;

  const direct = findBlock(article, reference);
  if (direct) return direct.id;

  const blocks = article?.blocks || [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const ordinal = index + 1;
    if (
      normalized === String(block.id).trim().toLowerCase()
      || normalized === `@b${ordinal}`
      || normalized === `b${ordinal}`
      || normalized === String(ordinal)
    ) {
      return block.id;
    }
  }

  return null;
}

function findMentionedBlockIds(article, userInput) {
  const matches = Array.from(String(userInput || '').matchAll(/@b(\d+)\b/gi));
  return matches.reduce((acc, match) => {
    const blockId = resolveBlockReference(article, `@b${match[1]}`);
    if (blockId && !acc.includes(blockId)) acc.push(blockId);
    return acc;
  }, []);
}

function assertBlockAllowed(context, blockId) {
  if (!Array.isArray(context.allowedBlockIds) || context.allowedBlockIds.length === 0) return blockId;
  if (!context.allowedBlockIds.includes(blockId)) {
    throw new Error('AI 只能修改 @ 指定的块，请重新选择目标段落');
  }
  return blockId;
}

function normalizeOperation(article, operation, context) {
  if (!operation || typeof operation !== 'object') throw new Error('操作结果解析失败');
  const normalized = { ...operation };
  const resolvedBlockId = resolveBlockReference(article, operation.block_id);
  if (!resolvedBlockId && operation.op !== 'insert') {
    throw new Error('BLOCK_NOT_FOUND');
  }
  if (resolvedBlockId) {
    normalized.block_id = assertBlockAllowed(context, resolvedBlockId);
  }
  if ((normalized.op === 'replace' || normalized.op === 'delete') && !normalized.old) {
    normalized.old = findBlock(article, normalized.block_id)?.content || '';
  }
  return normalized;
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

function formatFactSections(sections = []) {
  return sections
    .map((section, index) => {
      const quotes = (section.quotes || [])
        .map((quote, quoteIndex) => `  - 摘录 ${quoteIndex + 1}：${quote.content || quote.preview || ''}`)
        .join('\n');
      return `[事实 ${index + 1}] 《${section.file_title}》 ${section.heading_path || '正文'}\n${quotes}`;
    })
    .join('\n\n');
}

function dedupeChunks(chunks = []) {
  const byId = new Map();
  chunks.forEach((chunk) => {
    if (!chunk) return;
    const key = chunk.chunk_id
      || `${chunk.file_id || chunk.file_title || ''}:${chunk.heading_path || chunk.path || ''}:${chunk.preview || chunk.content || chunk.quote || ''}`;
    if (byId.has(key)) return;
    byId.set(key, chunk);
  });
  return [...byId.values()];
}

function extractSearchTerms(text = '') {
  const normalized = String(text || '').toLowerCase();
  const words = normalized.match(/[a-z0-9]{3,}/g) || [];
  const hanGroups = normalized.match(/[\u3400-\u9fff]{2,}/g) || [];
  return [...new Set([...words, ...hanGroups])];
}

function scoreBlockAgainstTerms(block, terms = []) {
  if (!block || !Array.isArray(terms) || terms.length === 0) return 0;
  const haystack = `${block.headingPath || ''}\n${block.content || ''}`.toLowerCase();
  return terms.reduce((score, term) => {
    if (!term || !haystack.includes(term)) return score;
    return score + (block.type === 'heading' ? 3 : 1);
  }, 0);
}

function buildArticleContextSummary(article, blocks = []) {
  const uniqueHeadingPaths = [...new Set(
    blocks
      .map((block) => String(block.headingPath || '').trim())
      .filter(Boolean)
  )].slice(0, 6);

  return [
    `当前文章标题：${article?.title || '未命名文章'}`,
    uniqueHeadingPaths.length > 0
      ? `相关标题路径：\n- ${uniqueHeadingPaths.join('\n- ')}`
      : '',
  ].filter(Boolean).join('\n');
}

function selectCanvasContextBlocks(article, userInput, allowedBlockIds = []) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  if (blocks.length === 0) {
    return {
      blocks: [],
      articleContextSummary: `当前文章标题：${article?.title || '未命名文章'}`,
    };
  }

  const indices = new Set();
  const allowedSet = new Set(Array.isArray(allowedBlockIds) ? allowedBlockIds : []);

  if (allowedSet.size > 0) {
    blocks.forEach((block, index) => {
      if (!allowedSet.has(block.id)) return;
      indices.add(index);
      if (index > 0) indices.add(index - 1);
      if (index < blocks.length - 1) indices.add(index + 1);
    });
  } else {
    const terms = extractSearchTerms(userInput);
    const ranked = blocks
      .map((block, index) => ({
        index,
        score: scoreBlockAgainstTerms(block, terms),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const topRanked = ranked
      .filter((item) => item.score > 0)
      .slice(0, 6);
    const fallback = topRanked.length > 0 ? topRanked : ranked.slice(0, 6);

    fallback.forEach((item) => {
      indices.add(item.index);
      if (item.index > 0) indices.add(item.index - 1);
      if (item.index < blocks.length - 1) indices.add(item.index + 1);
    });
  }

  const selectedIndices = [...indices].sort((a, b) => a - b);
  const boundedIndices = allowedSet.size > 0
    ? selectedIndices
    : selectedIndices.slice(0, 12);
  const selectedBlocks = boundedIndices
    .map((index) => blocks[index])
    .filter(Boolean)
    .map((block) => ({
      ...block,
      content: trimTextToTokenBudget(
        block.content || '',
        block.type === 'heading' ? 90 : 220
      ),
    }));

  return {
    blocks: selectedBlocks,
    articleContextSummary: buildArticleContextSummary(article, selectedBlocks),
  };
}

async function loadStyleSamples(topic, context) {
  if (context.styleMode === 'manual') {
    if (!Array.isArray(context.styleFileIds) || context.styleFileIds.length === 0) return [];
    return hybridSearch(topic, { topK: 6, fileIds: context.styleFileIds });
  }

  const preferred = context.activeFileId
    ? await hybridSearch(topic, { topK: 3, fileIds: [context.activeFileId], vecThreshold: 0.2 })
    : [];
  const supplemental = await hybridSearch(topic, { topK: 4 });
  return dedupeChunks([...preferred, ...supplemental]).slice(0, 6);
}

async function generateOperation(article, blockId, instruction, context, mode = 'replace', llmConfig = null) {
  const block = findBlock(article, blockId);
  if (!block && mode !== 'insert') throw new Error('BLOCK_NOT_FOUND');

  const messages = [
    {
      role: 'system',
      content: [
        '你是 Markdown 文章协作助手。',
        '只输出 JSON，不要输出解释。',
        '返回格式：{"op":"replace|insert|delete","block_id":"...","old":"...","new":"...","position":"after","type":"paragraph"}。',
        '如果是 replace，必须带 old 和 new。',
        '如果是 insert，必须带 block_id、position、type、new。',
        '如果是 delete，必须带 block_id 和 old。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        article_title: article.title,
        block: block ? {
          ...block,
          content: trimTextToTokenBudget(block.content || '', 700),
        } : null,
        instruction,
        mode,
        fact_sections: context.factSections || [],
        style_samples: (context.styleSamples || []).map((sample) => sample.content || sample.preview || ''),
      }),
    },
  ];

  const reply = await completeChat(messages, {
    config: llmConfig || undefined,
    temperature: 0.45,
    taskType: 'operation_json',
  });
  if (reply.usage) context.telemetry.usages.push(reply.usage);
  if (reply.budget) context.telemetry.budgets.push(reply.budget);
  if (reply.compacted) context.telemetry.compacted = true;
  const parsed = safeJsonParse(reply.message?.content);
  if (!parsed?.op) throw new Error('操作结果解析失败');
  return normalizeOperation(article, parsed, { allowedBlockIds: [] });
}

async function executeTool(name, args, context) {
  if (name === 'search_knowledge') {
    const result = await retrieveKnowledgeContext(args.query, {
      topK: args.topK || 5,
      activeFileId: context.activeFileId,
      fileIds: context.factFileIds,
      restrictToFileIds: context.restrictFactSearch,
    });
    const chunks = sanitizeKnowledgeChunks(result.chunks || [], {
      chunkLimit: 3,
      chunkTokenBudget: 160,
    });
    return { chunks };
  }

  if (name === 'get_style_samples') {
    const samples = sanitizeStyleSamples(await loadStyleSamples(args.topic, context), {
      limit: 3,
      contentTokenBudget: 140,
    });
    return { samples };
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
    const blockId = assertBlockAllowed(context, resolveBlockReference(context.article, args.block_id));
    if (!blockId) throw new Error('BLOCK_NOT_FOUND');
    return {
      operation: normalizeOperation(
        context.article,
        await generateOperation(context.article, blockId, args.instruction, context, 'replace', context.llmConfig),
        context
      ),
    };
  }

  if (name === 'expand_block') {
    const blockId = assertBlockAllowed(context, resolveBlockReference(context.article, args.block_id));
    if (!blockId) throw new Error('BLOCK_NOT_FOUND');
    return {
      operation: normalizeOperation(
        context.article,
        await generateOperation(context.article, blockId, '扩写这段内容，补足论证和细节。', context, 'replace', context.llmConfig),
        context
      ),
    };
  }

  if (name === 'shrink_block') {
    const blockId = assertBlockAllowed(context, resolveBlockReference(context.article, args.block_id));
    if (!blockId) throw new Error('BLOCK_NOT_FOUND');
    return {
      operation: normalizeOperation(
        context.article,
        await generateOperation(context.article, blockId, '精简这段内容，保留核心信息。', context, 'replace', context.llmConfig),
        context
      ),
    };
  }

  if (name === 'polish_style') {
    const blockId = assertBlockAllowed(context, resolveBlockReference(context.article, args.block_id));
    if (!blockId) throw new Error('BLOCK_NOT_FOUND');
    return {
      operation: normalizeOperation(
        context.article,
        await generateOperation(context.article, blockId, args.instruction || '按已有风格润色这段内容。', context, 'replace', context.llmConfig),
        context
      ),
    };
  }

  if (name === 'insert_block') {
    const blockId = assertBlockAllowed(context, resolveBlockReference(context.article, args.block_id));
    if (!blockId) throw new Error('BLOCK_NOT_FOUND');
    return {
      operation: {
        op: 'insert',
        block_id: blockId,
        position: 'after',
        type: args.type || 'paragraph',
        new: args.content,
      },
    };
  }

  if (name === 'delete_block') {
    const blockId = assertBlockAllowed(context, resolveBlockReference(context.article, args.block_id));
    if (!blockId) throw new Error('BLOCK_NOT_FOUND');
    const block = findBlock(context.article, blockId);
    return {
      operation: {
        op: 'delete',
        block_id: blockId,
        old: block?.content || '',
      },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function runAgent({
  userInput,
  article,
  conversationHistory = [],
  activeFileId = null,
  referenceMode = 'auto',
  factFileIds = [],
  styleMode = 'auto',
  styleFileIds = [],
  llmConfig = null,
}, onStream) {
  const allowedBlockIds = findMentionedBlockIds(article, userInput);
  const { recentHistory, memorySummary } = buildHistorySummary(conversationHistory, {
    keepRecentMessages: 4,
    maxOlderTurns: 4,
    userTokenBudget: 64,
    assistantTokenBudget: 96,
  });
  const factContext = await retrieveKnowledgeContext(userInput, {
    topK: 5,
    activeFileId,
    fileIds: Array.isArray(factFileIds) ? factFileIds : [],
    restrictToFileIds: referenceMode === 'manual',
  });
  const preloadedStyleSamples = await loadStyleSamples(article?.title || userInput, {
    activeFileId,
    styleMode,
    styleFileIds: Array.isArray(styleFileIds) ? styleFileIds : [],
  });
  const selectedCanvasContext = selectCanvasContextBlocks(article, userInput, allowedBlockIds);
  const compactFactSections = sanitizeKnowledgeSections(factContext.sections, {
    sectionLimit: 3,
    quoteLimit: 2,
    quoteTokenBudget: 110,
  });
  const compactStyleSamples = sanitizeStyleSamples(preloadedStyleSamples, {
    limit: 4,
    contentTokenBudget: 160,
  });
  const context = {
    article,
    promptBlocks: selectedCanvasContext.blocks,
    articleContextSummary: selectedCanvasContext.articleContextSummary,
    activeFileId,
    factFileIds: Array.isArray(factFileIds)
      ? factFileIds.map((item) => Number(item)).filter((item) => Number.isFinite(item))
      : [],
    restrictFactSearch: referenceMode === 'manual',
    factSections: compactFactSections,
    factContextText: formatFactSections(compactFactSections),
    styleMode,
    styleSamples: compactStyleSamples,
    styleSamplesText: formatStyleSamples(compactStyleSamples),
    styleFileIds: Array.isArray(styleFileIds)
      ? styleFileIds.map((item) => Number(item)).filter((item) => Number.isFinite(item))
      : [],
    citations: factContext.chunks ? [...factContext.chunks] : [],
    operations: [],
    llmConfig,
    allowedBlockIds,
    telemetry: {
      usages: [],
      budgets: [],
      compacted: false,
    },
  };

  const allowedBlockNotes = allowedBlockIds.length > 0
    ? `用户明确提到了这些块：${allowedBlockIds.map((id) => {
      const blockIndex = (article.blocks || []).findIndex((block) => block.id === id);
      return `@b${blockIndex + 1} -> ${id}`;
    }).join('，')}。你只能修改这些块，不能改动其他块。`
    : '';

  const initialMessages = [
    {
      role: 'system',
      content: [
        context.articleContextSummary,
        memorySummary ? `更早对话摘要（仅用于延续写作上下文，不是事实来源）：\n${memorySummary}` : '',
        buildAgentSystemPrompt(context.promptBlocks || article.blocks || [], {
          factContextText: context.factContextText,
          styleSamplesText: context.styleSamplesText,
        }),
        allowedBlockNotes,
        '你可以调用工具。最终必须只输出 JSON：{"operations":[...],"citations":[...]}。',
      ].filter(Boolean).join('\n\n'),
    },
    ...recentHistory
      .filter((message) => message?.role === 'user' || message?.role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: String(message.content || ''),
      })),
    {
      role: 'user',
      content: JSON.stringify({
        user_input: userInput,
        article_title: article.title,
        fact_reference_mode: referenceMode,
        style_mode: styleMode,
      }),
    },
  ];

  const history = [...initialMessages];
  if (onStream) onStream({ type: 'thinking', text: '正在分析你的创作请求…' });

  for (let round = 0; round < 4; round += 1) {
    const reply = await completeChat(history, {
      tools: TOOLS,
      config: llmConfig || undefined,
      temperature: 0.45,
      taskType: 'canvas_agent',
    });
    if (reply.usage) context.telemetry.usages.push(reply.usage);
    if (reply.budget) context.telemetry.budgets.push(reply.budget);
    if (reply.compacted) context.telemetry.compacted = true;

    if (reply.message?.tool_calls?.length) {
      history.push({
        role: 'assistant',
        content: reply.message?.content || '',
        tool_calls: reply.message.tool_calls,
      });

      for (const call of reply.message.tool_calls) {
        const args = safeJsonParse(call.function.arguments) || {};
        if (onStream) onStream({ type: 'tool_call', name: call.function.name, args });
        const result = await executeTool(call.function.name, args, context);
        if (result.samples) {
          context.styleSamples = result.samples;
          context.styleSamplesText = formatStyleSamples(result.samples);
        }
        if (result.chunks) context.citations.push(...result.chunks);
        if (result.operation) context.operations.push(result.operation);
        if (onStream) onStream({ type: 'tool_result', name: call.function.name, data: result });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    const parsed = safeJsonParse(reply.message?.content);
    if (parsed?.operations || parsed?.citations) {
      return {
        operations: Array.isArray(parsed.operations)
          ? parsed.operations.map((operation) => normalizeOperation(article, operation, context))
          : context.operations,
        citations: dedupeChunks(parsed.citations || context.citations),
        usage: sumUsageRecords(context.telemetry.usages),
        budget: context.telemetry.budgets[context.telemetry.budgets.length - 1] || null,
        compacted: context.telemetry.compacted,
      };
    }

    return {
      operations: context.operations,
      citations: dedupeChunks(context.citations),
      text: reply.message?.content || '',
      usage: sumUsageRecords(context.telemetry.usages),
      budget: context.telemetry.budgets[context.telemetry.budgets.length - 1] || null,
      compacted: context.telemetry.compacted,
    };
  }

  return {
    operations: context.operations,
    citations: dedupeChunks(context.citations),
    usage: sumUsageRecords(context.telemetry.usages),
    budget: context.telemetry.budgets[context.telemetry.budgets.length - 1] || null,
    compacted: context.telemetry.compacted,
  };
}

module.exports = {
  TOOLS,
  runAgent,
};
