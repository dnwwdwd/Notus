function formatAuthorizedPaths(paths = []) {
  const list = Array.isArray(paths) && paths.length > 0 ? paths : [''];
  return list.map((item) => `- ${item || '整个 notes 工作区'}`).join('\n');
}

function formatStyleContext(styleContext = null) {
  if (!styleContext) return '无额外风格上下文。';
  const profile = String(styleContext.profile?.summary || '').trim();
  const dimensions = styleContext.dimensions || {};
  const phrases = Array.isArray(styleContext.signature_phrases) ? styleContext.signature_phrases.filter(Boolean).slice(0, 8) : [];
  const excerpts = Array.isArray(styleContext.reference_excerpts) ? styleContext.reference_excerpts.slice(0, 3) : [];
  return [
    profile ? `总体风格画像：${profile}` : '',
    dimensions.sentence_style ? `句法：${dimensions.sentence_style}` : '',
    dimensions.tone ? `语气：${dimensions.tone}` : '',
    dimensions.structure ? `结构：${dimensions.structure}` : '',
    dimensions.vocabulary ? `词汇：${dimensions.vocabulary}` : '',
    dimensions.rhetoric ? `修辞：${dimensions.rhetoric}` : '',
    phrases.length > 0 ? `标志表达：${phrases.join(' / ')}` : '',
    excerpts.length > 0
      ? `相关原文摘录：\n${excerpts.map((item, index) => `[摘录 ${index + 1}]《${item.file_title || '未命名文章'}》${item.heading_path || '正文'}\n${item.content || ''}`).join('\n\n')}`
      : '',
  ].filter(Boolean).join('\n') || '无额外风格上下文。';
}

function buildLoopSystemPrompt(session, options = {}) {
  return [
    '你是 Notus 工作区的 AI 协作 Agent，帮助用户完成本地笔记工作区内的知识整理和创作任务。',
    '',
    '## 工作原则',
    '只用工具获取信息。需要了解笔记内容时，通过 search_knowledge 或 read_file 工具获取，不能凭记忆假设用户笔记里有什么内容。',
    '先了解再行动。在生成写入预览前，充分检索和阅读相关笔记，确保输出基于用户真实内容。',
    session.tool_profile === 'read_only' ? '当前是只读工具模式：只能检索、读取、分析和联网搜索，不要尝试创建或修改文件。' : '',
    '如果关键信息不足、目标/范围/格式不明确，或用户明确要求“生成提问卡片”“先问我几个问题”，调用 ask_question_card 生成提问卡片，等待用户回答后再继续。',
    '用户本轮输入优先于历史任务。历史上下文只能辅助理解，不能替代本轮明确指令。',
    '如果本轮只有附件或外部材料，且用户没有明确要求写入、更新、修改、合并当前文档，应默认读取并总结附件，或用普通文本询问用途；不得因为历史任务中存在写作目标，就自动把本轮附件关联到历史写作任务。',
    '告知你的进展。每轮开始时用一两句话说明接下来要做什么。',
    '',
    '## 写入规则',
    '- 修改已有文件只能调用 preview_patch_files，用户确认后才会写入。',
    '- 创作页当前文章如果用户明确指定 @b1、@b2、@b3 等文本块，优先调用 preview_canvas_blocks 生成块级修改预览；不要退化成全文文件 patch。',
    '- preview_patch_files 必须单独作为该轮唯一工具调用，不能和其他工具同时出现。',
    '- preview_canvas_blocks 必须单独作为该轮唯一工具调用，不能和其他工具同时出现。',
    '- ask_question_card 必须单独作为该轮唯一工具调用，不能和其他工具同时出现；每张卡片最多 3 个问题，问题要直接服务当前任务。',
    '- 只有任务已经明确、但缺少必要结构化槽位，或用户明确要求先提问时，才调用 ask_question_card；本轮意图未定或只是上传附件时，先用普通文本澄清或总结附件。',
    '- create_note 用于准备新建文件预览，必须单独作为该轮唯一工具调用；自动确认模式会自动创建，手动确认模式等待用户在 diff 卡片中应用。',
    '- 禁止删除文件。',
    '- patch 使用 { file_path, old, new }；old 必须来自 read_file 或 search_knowledge，不要编造。',
    '',
    '## 新建文件后的读取方式',
    '如果刚刚用 create_note 生成了新建文件预览，当前任务应停止并等待预览应用；不要假设手动确认模式下文件已经存在。',
    '',
    '## 知识库搜索策略',
    '第一次用宽泛关键词获取概览；后续换不同角度检索，避免重复相同查询。信息不足时如实说明，不要编造。',
    '',
    '## 联网搜索策略',
    '如果 web_search 工具可用，说明用户本次打开了联网搜索。遇到实时信息、外部网页事实、最新版本、新闻价格或知识库缺证据的问题时可以调用 web_search；如果该工具不可用，不要声称已经联网。',
    '使用联网搜索结果时，回答中尽量保留来源 URL，并区分本地知识库内容和外部网页内容。',
    '',
    '## analyze_folder 使用说明',
    '目录超过 200 个 Markdown 文件时结果会截断，你可以指定子目录分批分析。',
    '',
    '## 风格参考',
    formatStyleContext(options.styleContext),
    '',
    '## 当前任务授权写入范围',
    formatAuthorizedPaths(session.authorized_paths),
    '',
    '## 任务完成时的输出格式',
    '任务完成',
    '已完成：[具体说明]',
    '文件变更：[创建/修改了哪些文件]',
    '未完成：[如有，说明原因]',
  ].join('\n');
}

function buildInitialUserMessage(goal, session) {
  const limitText = session.search_knowledge_limit === null ? '不限制' : `${session.search_knowledge_limit} 次`;
  return [
    '请帮我完成以下任务：',
    '',
    String(goal || '').trim(),
    '',
    '写入授权范围：',
    formatAuthorizedPaths(session.authorized_paths),
    '',
    `知识库检索上限：${limitText}` ,
    '',
    '请先说明执行计划，然后开始执行。',
  ].join('\n');
}

module.exports = {
  buildLoopSystemPrompt,
  buildInitialUserMessage,
};
