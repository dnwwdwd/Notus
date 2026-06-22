const WRITE_ACTION_PATTERNS = [
  /写|撰写|起草|生成|创建|新建|重写|改写|润色|扩写|缩写|续写|仿写/,
  /整理成|写成|保存为|做成|产出|输出/,
];

const WRITE_TARGET_PATTERNS = [
  /文章|笔记|文档|文件|草稿|大纲|提纲|报告|方案|邮件|博客|README|Markdown|md/i,
  /当前文章|当前文档|这篇文章|这篇文档|本文|全文/,
];

const EXPLICIT_FILE_WRITE_PATTERNS = [
  /新建.+(笔记|文章|文档|文件|草稿|Markdown|md)/i,
  /创建.+(笔记|文章|文档|文件|草稿|Markdown|md)/i,
  /保存为.+(笔记|文章|文档|文件|草稿|Markdown|md)/i,
  /生成.+(笔记|文章|文档|文件|草稿|Markdown|md)/i,
];

const READ_ONLY_PATTERNS = [
  /^(什么|为什么|怎么|如何|是否|能否|请问|哪些|有哪些)/,
  /(解释|分析|查找|搜索|对比|列出|告诉我|说明).*(是什么|为什么|如何|哪些|有哪些)?/,
  /(总结一下|概括一下|归纳一下|帮我看看|评价一下)/,
];

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function isCurrentDocumentWrite(value) {
  return /(当前|这篇|本文|全文).*(重写|改写|润色|扩写|缩写|续写|整理成|写成)/.test(value)
    || /(重写|改写|润色|扩写|缩写|续写).*(当前|这篇|本文|全文)/.test(value);
}

export function classifyKnowledgeTaskIntent(query = '') {
  const normalized = String(query || '').trim();
  if (!normalized) return { route: 'chat', reason: 'empty_query' };

  const explicitFileWrite = matchesAny(normalized, EXPLICIT_FILE_WRITE_PATTERNS);
  const hasWriteAction = matchesAny(normalized, WRITE_ACTION_PATTERNS);
  const hasWriteTarget = matchesAny(normalized, WRITE_TARGET_PATTERNS);
  const currentDocumentWrite = isCurrentDocumentWrite(normalized);
  const readOnly = matchesAny(normalized, READ_ONLY_PATTERNS);

  if (explicitFileWrite) {
    return { route: 'loop', reason: 'explicit_file_write' };
  }
  if (currentDocumentWrite) {
    return { route: 'loop', reason: 'current_document_write' };
  }
  if (hasWriteAction && hasWriteTarget && !readOnly) {
    return { route: 'loop', reason: 'write_action_and_target' };
  }
  if (hasWriteAction && hasWriteTarget && readOnly) {
    return { route: 'chat', reason: 'read_only_expression_wins' };
  }
  return { route: 'chat', reason: readOnly ? 'read_only_expression' : 'no_write_intent' };
}

export function shouldAuthorizeCurrentFile(query = '') {
  const normalized = String(query || '').trim();
  return isCurrentDocumentWrite(normalized)
    || /(修改|重写|改写|润色|扩写|缩写|续写).*(当前|这篇|本文|全文|文档|文章)/.test(normalized);
}
