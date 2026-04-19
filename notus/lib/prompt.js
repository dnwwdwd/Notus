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

function buildAgentSystemPrompt(blocks, styleSamples) {
  const blockList = blocks
    .map((b) => `<block id="${b.id}" type="${b.type}">${b.content}</block>`)
    .join('\n');

  const style = styleSamples
    ? `\n\n参考写作风格（用户已有笔记片段）：\n${styleSamples}`
    : '';

  return `你是用户的AI写作助手，帮助创作和改进笔记文章。
当前文章的所有块如下：
${blockList}${style}

你有以下工具可用：
- search_knowledge(query) — 搜索用户知识库
- get_style_samples(topic) — 获取同主题写作风格样本
- get_outline(topic) — 生成文章大纲
- draft_block(block_id, instruction) — 为指定块起草内容
- expand_block(block_id) — 展开扩充指定块
- shrink_block(block_id) — 压缩精简指定块
- polish_style(block_id, style_ref) — 按风格润色指定块
- insert_block(after_block_id, type, content) — 在指定块后插入新块
- delete_block(block_id) — 删除指定块

每次修改必须包含 old 字段（被替换的原始内容），用于乐观锁校验。`;
}

function buildDraftPrompt(blockId, content, instruction, context) {
  return [
    {
      role: 'system',
      content: buildAgentSystemPrompt(context.blocks, context.styleSamples),
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
      content: `你是文字润色专家，擅长保留原意的同时提升表达质量。根据提供的风格参考调整语言风格，但保持核心观点不变。`,
    },
    {
      role: 'user',
      content: `风格参考：\n${styleRef}\n\n请按上述风格润色以下内容（block id="${blockId}"）：\n${content}`,
    },
  ];
}

module.exports = {
  buildKnowledgeQAPrompt,
  buildCanvasIntentPrompt,
  buildAgentSystemPrompt,
  buildDraftPrompt,
  buildPolishPrompt,
};
