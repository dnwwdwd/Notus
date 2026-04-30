// All LLM prompt templates

function normalizeKnowledgeContext(input) {
  if (Array.isArray(input)) {
    return {
      chunks: input,
      sections: [],
      sufficiency: input.length > 0,
      stats: {},
    };
  }
  return {
    chunks: Array.isArray(input?.chunks) ? input.chunks : [],
    sections: Array.isArray(input?.sections) ? input.sections : [],
    sufficiency: Boolean(input?.sufficiency),
    stats: input?.stats || {},
  };
}

function formatKnowledgeSections(sections = []) {
  return sections
    .map((section, index) => {
      const quotes = (section.quotes || [])
        .map((quote, quoteIndex) => `  - 摘录 ${quoteIndex + 1}（L${quote.line_start || '?'}-${quote.line_end || '?'}）：${quote.content || quote.preview || ''}`)
        .join('\n');
      return [
        `[证据组 ${index + 1}] 《${section.file_title}》 ${section.heading_path || '正文'}`,
        `  - 文件：${section.file_path || ''}`,
        quotes,
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function formatKnowledgeChunks(chunks = []) {
  return chunks
    .map((chunk, index) => {
      const imageContext = chunk.image_id
        ? `\n关联图片：${chunk.image_caption || chunk.image_alt_text || chunk.image_url || '无说明'}`
        : '';
      return `[片段 ${index + 1}] 《${chunk.file_title}》 ${chunk.heading_path || '正文'}\n${chunk.content}${imageContext}`;
    })
    .join('\n\n');
}

function formatStyleSamples(styleSamples = []) {
  return styleSamples
    .map((sample, index) => `[风格样本 ${index + 1}] 《${sample.file_title || sample.file || '未命名笔记'}》 ${sample.heading_path || '正文'}\n${sample.content || sample.preview || ''}`)
    .join('\n\n');
}

function buildKnowledgeQAPrompt(query, input, options = {}) {
  const context = normalizeKnowledgeContext(input);
  const history = Array.isArray(options.history) ? options.history : [];
  const effectiveQuery = String(options.effectiveQuery || query || '');
  const memorySummary = String(options.memorySummary || '').trim();
  const sectionText = context.sections.length > 0
    ? formatKnowledgeSections(context.sections)
    : '暂无按章节整理后的证据组。';
  const chunkText = context.chunks.length > 0
    ? formatKnowledgeChunks(context.chunks)
    : '暂无原始检索片段。';

  return [
    {
      role: 'system',
      content: [
        '你是用户私人知识库的中文问答助手。',
        '只能根据提供的证据回答，不得补充证据里没有的事实。',
        '如果证据不足、信息冲突或无法确认，就直接说不知道，或明确说明笔记里没有足够依据。',
        '回答风格保持自然、直接、克制、务实，像一个正常的 AI 助手在和用户对话。',
        '不要固定套用“结论 / 整理 / 证据”之类的模板，不要每次都机械分段贴标题。',
        '优先用流畅的自然语言回答；只有在确实更清楚时，才使用简短列表。',
        '不要大段复述检索原文，不要为了显得完整而凑结构。',
        '如果给出了“更早对话摘要”，那只是会话记忆，不是事实来源，不能压过当前证据。',
      ].join('\n'),
    },
    ...(memorySummary ? [{
      role: 'system',
      content: `更早对话摘要（仅用于理解上下文，不是事实依据）：\n${memorySummary}`,
    }] : []),
    ...history.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || ''),
    })),
    {
      role: 'user',
      content: [
        `用户当前问题：${query}`,
        effectiveQuery && effectiveQuery !== query ? `用于检索的扩展问题：${effectiveQuery}` : '',
        '',
        `证据充分性：${context.sufficiency ? '相对充分' : '不足，需要保守回答'}`,
        `检索统计：chunks=${context.stats.chunk_count || context.chunks.length}，sections=${context.stats.section_count || context.sections.length}，files=${context.stats.file_count || 0}，best_score=${context.stats.best_score || 0}`,
        '',
        '按章节整理后的证据组：',
        sectionText,
        '',
        '原始检索片段：',
        chunkText,
      ].filter(Boolean).join('\n'),
    },
  ];
}

function buildCanvasIntentPrompt(userInput, article) {
  const title = article?.title || '未命名文章';
  return [
    {
      role: 'system',
      content: '判断用户输入更适合知识库问答还是画布编辑。只输出 JSON，格式为 {"intent":"knowledge|canvas","confidence":0到1}。',
    },
    {
      role: 'user',
      content: `当前文章：${title}\n用户输入：${userInput}`,
    },
  ];
}

function buildAgentSystemPrompt(blocks, options = {}) {
  const blockList = (blocks || [])
    .map((block, index) => `<block id="${block.id}" ref="@b${index + 1}" type="${block.type}">${block.content}</block>`)
    .join('\n');

  const factContextText = options.factContextText
    ? `\n\n事实参考（只能把这里当作事实来源）：\n${options.factContextText}`
    : '';
  const styleContextText = options.styleSamplesText
    ? `\n\n风格参考（只能学习表达方式，不能当事实来源）：\n${options.styleSamplesText}`
    : '';

  return `你是用户的 AI 写作助手，帮助创作和改进笔记文章。
当前文章的所有块如下：
${blockList}${factContextText}${styleContextText}

你有以下工具可用：
- search_knowledge(query) — 搜索用户知识库中的事实资料
- get_style_samples(topic) — 获取同主题写作风格样本
- get_outline(topic) — 生成文章大纲
- draft_block(block_id, instruction) — 为指定块起草内容
- expand_block(block_id) — 展开扩充指定块
- shrink_block(block_id) — 压缩精简指定块
- polish_style(block_id, style_ref) — 按风格润色指定块
- insert_block(after_block_id, type, content) — 在指定块后插入新块
- delete_block(block_id) — 删除指定块

规则：
- 事实只能来自“事实参考”或 search_knowledge 的结果。
- 风格只能来自“风格参考”或 get_style_samples 的结果。
- 不要把风格样本当作事实依据。
- 用户在输入里会用 @b1、@b2 这种块引用；你调用工具或输出 operation 时，必须把它转换成对应的真实 block_id。
- 如果用户明确点名了某个 @bN，只能修改这些被点名的块，不能顺带改动其他块。
- 每次修改必须包含 old 字段（被替换的原始内容），用于乐观锁校验。`;
}

function buildOutlinePrompt(topic, input = {}) {
  const currentDocument = input.currentDocument || null;
  const sections = Array.isArray(input.sections) ? input.sections : (Array.isArray(input) ? input : []);
  const styleSamples = Array.isArray(input.styleSamples) ? input.styleSamples : [];
  const references = sections.length > 0
    ? formatKnowledgeSections(sections)
    : '暂无可用参考，请根据主题生成一个结构清晰、可继续扩写的 Markdown 大纲。';
  const currentDocText = currentDocument
    ? [
      `当前打开文档：${currentDocument.title || '未命名文档'}`,
      currentDocument.summary ? `摘要：${currentDocument.summary}` : '',
      currentDocument.outline ? `现有结构：${currentDocument.outline}` : '',
    ].filter(Boolean).join('\n')
    : '当前没有指定打开文档。';
  const styleText = styleSamples.length > 0 ? formatStyleSamples(styleSamples) : '暂无额外风格样本。';

  return [
    {
      role: 'system',
      content: [
        '你是用户的中文写作助手。',
        '生成大纲时要优先继承当前打开文档的主题、结构和上下文，再补充相关笔记中的事实。',
        '风格目标是“像用户本人，但更稳、更清晰”。',
        '只输出 JSON，格式为 {"blocks":[{"type":"heading|paragraph","content":"..."}]}。',
        '第一块必须是一级标题，使用 Markdown heading 语法。',
        '后续块以二级标题和简洁段落为主，总块数控制在 4 到 8 个之间。',
        '如果参考资料不足，不要乱编具体事实，用更稳妥的结构性表达。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `创作主题：${topic}`,
        '',
        currentDocText,
        '',
        '事实参考：',
        references,
        '',
        '风格参考：',
        styleText,
      ].join('\n'),
    },
  ];
}

function buildDraftPrompt(blockId, content, instruction, context) {
  return [
    {
      role: 'system',
      content: buildAgentSystemPrompt(context.blocks, {
        factContextText: context.factContextText,
        styleSamplesText: context.styleSamplesText,
      }),
    },
    {
      role: 'user',
      content: `请对 block id="${blockId}" 执行以下操作：${instruction}\n\n当前内容：\n${content}`,
    },
  ];
}

function buildPolishPrompt(blockId, content, styleRef) {
  return [
    {
      role: 'system',
      content: '你是文字润色专家，擅长保留原意的同时提升表达质量。根据提供的风格参考调整语言风格，但保持核心观点不变。',
    },
    {
      role: 'user',
      content: `风格参考：\n${styleRef}\n\n请按上述风格润色以下内容（block id="${blockId}"）：\n${content}`,
    },
  ];
}

module.exports = {
  buildKnowledgeQAPrompt,
  buildOutlinePrompt,
  buildCanvasIntentPrompt,
  buildAgentSystemPrompt,
  buildDraftPrompt,
  buildPolishPrompt,
  formatStyleSamples,
};
