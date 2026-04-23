// All LLM prompt templates

function buildKnowledgeQAPrompt(query, chunks) {
  const context = chunks
    .map((c, i) => {
      const imageContext = c.image_id
        ? `\n关联图片：${c.image_caption || c.image_alt_text || c.image_url || '无说明'}`
        : '';
      return `[${i + 1}] 《${c.file_title}》 ${c.heading_path}\n${c.content}${imageContext}`;
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      content: `你是用户私人知识库的助手。只能基于提供的笔记片段回答问题，不要补充未出现在上下文中的事实。没有相关内容时，只回答“笔记中没有这方面的内容。”。回答要自然、简洁，并尽量引用原文。`,
    },
    {
      role: 'user',
      content: `以下是检索到的相关笔记片段：\n\n${context}\n\n用户问题：${query}`,
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

function normalizeStyleContext(styleContext = {}) {
  if (Array.isArray(styleContext)) {
    return {
      mode: 'auto',
      summary: '',
      samples: styleContext,
      citationCount: styleContext.length,
    };
  }

  return {
    mode: styleContext.mode === 'manual' ? 'manual' : 'auto',
    summary: String(styleContext.summary || '').trim(),
    samples: Array.isArray(styleContext.samples) ? styleContext.samples : [],
    citationCount: Number(styleContext.citationCount || 0),
  };
}

function formatStyleSamples(samples = []) {
  return samples.map((sample, index) => {
    const file = sample.file_title || sample.file || '未命名笔记';
    const heading = sample.heading_path || sample.path || '';
    const lines = sample.line_start && sample.line_end
      ? `L${sample.line_start}-${sample.line_end}`
      : '';
    const meta = [file, heading, lines].filter(Boolean).join(' · ');
    return `[样本 ${index + 1}] ${meta}\n${sample.content || sample.preview || sample.quote || ''}`;
  }).join('\n\n');
}

function buildStyleSection(styleContextInput) {
  const styleContext = normalizeStyleContext(styleContextInput);
  const { mode, summary, samples, citationCount } = styleContext;

  if (!summary && samples.length === 0) {
    return '\n\n当前没有可用风格样本。请按用户现有文章内容自然续写，不要凭空编造“用户惯用风格”。';
  }

  const modeInstruction = mode === 'manual'
    ? '当前是手动风格来源模式：只能从下方给出的样本中提炼写作风格，不要自行扩展到其他文章。'
    : '当前是自动风格来源模式：优先模仿下方样本的表达方式，但不要把样本中的事实内容直接搬到当前文章。';

  const summaryText = summary ? `\n\n风格画像：\n${summary}` : '';
  const sampleText = samples.length > 0 ? `\n\n风格样本：\n${formatStyleSamples(samples)}` : '';
  const sourceCountText = citationCount > 0 ? `\n当前已收集 ${citationCount} 个可追溯来源。` : '';

  return `

写作风格使用要求：
${modeInstruction}
这些样本只用于模仿表达方式，不是事实依据，也不是必须照抄的内容。
在生成或修改前，请先在内部识别并应用以下五个维度：
1. 句子节奏：偏短促还是偏舒展，长短句如何交替。
2. 人称与视角：更偏“我/我们”，还是偏客观观察。
3. 惯用修辞：是否常用对比、比喻、反问、递进、总结句。
4. 段落结构：习惯先抛结论、先讲背景，还是先举例再收束。
5. 词汇风格：偏口语、偏书面，还是偏技术说明。${sourceCountText}${summaryText}${sampleText}`;
}

function buildAgentSystemPrompt(blocks, styleContext = {}) {
  const blockList = blocks
    .map((b) => `<block id="${b.id}" type="${b.type}">${b.content}</block>`)
    .join('\n');

  return `你是用户的AI写作助手，帮助创作和改进笔记文章。
当前文章的所有块如下：
${blockList}${buildStyleSection(styleContext)}

你有以下工具可用：
- search_knowledge(query) — 搜索事实相关的知识片段，用于补充内容依据
- get_style_samples(query) — 获取更多可模仿的写作风格样本，不是用来查事实
- get_outline(topic) — 生成文章大纲
- draft_block(block_id, instruction) — 为指定块起草内容
- expand_block(block_id) — 展开扩充指定块
- shrink_block(block_id) — 压缩精简指定块
- polish_style(block_id, instruction) — 按当前风格要求润色指定块
- insert_block(block_id, type, content) — 在指定块后插入新块
- delete_block(block_id) — 删除指定块

每次修改必须包含 old 字段（被替换的原始内容），用于乐观锁校验。
如果你已经拿到了风格样本，请把风格体现在生成结果里，不要只在回答里口头描述风格。`;
}

function buildOutlinePrompt(topic, chunks = []) {
  const references = chunks.length > 0
    ? chunks
      .map((chunk, index) => `[${index + 1}] 《${chunk.file_title}》 ${chunk.heading_path || '正文'}\n${chunk.content}`)
      .join('\n\n')
    : '暂无可用参考，请根据主题生成一个结构清晰、可继续扩写的 Markdown 大纲。';

  return [
    {
      role: 'system',
      content: [
        '你是用户的中文写作助手。',
        '请根据主题和参考笔记生成一组适合画布编辑的文章块。',
        '只输出 JSON，格式为 {"blocks":[{"type":"heading|paragraph","content":"..."}]}。',
        '第一块必须是一级标题，使用 Markdown heading 语法。',
        '后续块以二级标题和简洁段落为主，总块数控制在 4 到 8 个之间。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `创作主题：${topic}\n\n参考资料：\n${references}`,
    },
  ];
}

function buildDraftPrompt(blockId, content, instruction, context) {
  return [
    {
      role: 'system',
      content: buildAgentSystemPrompt(context.blocks, context.styleContext || context.styleSamples),
    },
    {
      role: 'user',
      content: `请对 block id="${blockId}" 执行以下操作：${instruction}\n\n当前内容：\n${content}`,
    },
  ];
}

function buildPolishPrompt(blockId, content, styleRef, styleContext) {
  return [
    {
      role: 'system',
      content: [
        '你是文字润色专家，擅长保留原意的同时提升表达质量。',
        buildStyleSection(styleContext || { samples: styleRef ? [{ content: styleRef }] : [] }),
      ].join('\n\n'),
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
};
