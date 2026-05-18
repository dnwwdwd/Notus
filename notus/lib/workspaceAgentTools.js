const { retrieveKnowledgeContext } = require('./retrieval');
const { retrieveWorkspaceDocuments, summarizeDocumentsForClient } = require('./workspaceDocuments');
const { getConversation } = require('./conversations');
const { getFileById, getFileByPath, sha256 } = require('./files');
const { getStyleContext } = require('./style');
const {
  computeArticleHash,
  createOperationSet,
} = require('./canvasOperationSets');
const {
  DEFAULT_SCOPES,
  isScopeUnrestricted,
  normalizeScope,
  resolveCombinedScopeFileIds,
  resolveScopeFileIds,
} = require('./workspaceScope');

function ok(payload = {}) {
  return { success: true, ...payload };
}

function fail(error, hint, options = {}) {
  return {
    success: false,
    error,
    hint,
    recoverable: options.recoverable !== false,
    ...(options.extra || {}),
  };
}

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function getToolConversation(conversationId) {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return {
      error: fail(
        'CONVERSATION_NOT_FOUND',
        '会话不存在。请重新打开会话后再执行工具。',
        { recoverable: false }
      ),
    };
  }
  return { conversation };
}

function fileAllowedByScope(fileId, scope, context = {}) {
  const normalizedFileId = normalizePositiveInt(fileId);
  if (!normalizedFileId) return false;
  const normalizedScope = normalizeScope(scope, DEFAULT_SCOPES.read_scope);
  if (isScopeUnrestricted(normalizedScope)) return true;
  return resolveScopeFileIds(normalizedScope, context).includes(normalizedFileId);
}

function fileAllowedByWriteScope(fileId, scope, context = {}) {
  const normalizedFileId = normalizePositiveInt(fileId);
  if (!normalizedFileId) return false;
  const normalizedScope = normalizeScope(scope, DEFAULT_SCOPES.write_scope);
  if (normalizedScope.type === 'all') return true;
  if (normalizedScope.type === 'auto') return false;
  return resolveScopeFileIds(normalizedScope, context).includes(normalizedFileId);
}

async function searchKnowledge(args = {}, context = {}) {
  const { conversation, error } = getToolConversation(context.conversationId);
  if (error) return error;
  const query = String(args.query || '').trim();
  if (!query) {
    return fail('QUERY_REQUIRED', 'search_knowledge 需要 query 参数。');
  }

  const scopeResolution = resolveCombinedScopeFileIds(
    conversation.retrieval_scope || DEFAULT_SCOPES.retrieval_scope,
    conversation.read_scope || DEFAULT_SCOPES.read_scope,
    { activeFileId: context.activeFileId || conversation.file_id }
  );
  const knowledgeContext = await retrieveKnowledgeContext(query, {
    topK: Number(args.topK || args.top_k || 5),
    activeFileId: context.activeFileId || conversation.file_id,
    fileIds: scopeResolution.fileIds,
    restrictToFileIds: scopeResolution.restrictToFileIds,
  });
  const documentContext = await retrieveWorkspaceDocuments(query, {
    knowledgeContext,
    maxDocuments: Number(args.maxDocuments || 5),
    activeFileId: context.activeFileId || conversation.file_id,
    fileIds: scopeResolution.fileIds,
    restrictToFileIds: scopeResolution.restrictToFileIds,
  });

  return ok({
    documents: documentContext.documents || [],
    document_summaries: documentContext.document_summaries || summarizeDocumentsForClient(documentContext.documents || []),
    document_stats: documentContext.document_stats || {},
    chunks: documentContext.chunks || [],
    sections: documentContext.sections || [],
    stats: documentContext.stats || {},
    hint: (documentContext.documents || []).length === 0
      ? '当前范围内没有找到相关文档。可以提示用户扩大范围或换一个关键词。'
      : '',
  });
}

function readFile(args = {}, context = {}) {
  const { conversation, error } = getToolConversation(context.conversationId);
  if (error) return error;
  const fileId = normalizePositiveInt(args.file_id || args.fileId);
  const filePath = String(args.path || '').trim();
  if (!fileId && !filePath) {
    return fail('FILE_TARGET_REQUIRED', 'read_file 需要 file_id 或 path 参数。');
  }
  const file = fileId ? getFileById(fileId) : getFileByPath(filePath);
  if (!file) {
    return fail('FILE_NOT_FOUND', '目标 Markdown 文件不存在，可能已被移动或删除。');
  }
  if (!fileAllowedByScope(file.id, conversation.read_scope || DEFAULT_SCOPES.read_scope, {
    activeFileId: context.activeFileId || conversation.file_id,
  })) {
    return fail('READ_SCOPE_FORBIDDEN', '当前读取范围不允许读取这个文件。', { recoverable: false });
  }
  return ok({
    file: {
      id: file.id,
      stable_id: file.stable_id || null,
      path: file.path,
      title: file.title,
      hash: sha256(file.content || ''),
      token_count: file.token_count || 0,
      heading_outline: file.heading_outline || [],
      content: file.content || '',
    },
  });
}

async function getStyleContextTool(args = {}, context = {}) {
  const { conversation, error } = getToolConversation(context.conversationId);
  if (error) return error;
  const topic = String(args.topic || context.articleTitle || conversation.title || '').trim();
  const styleScope = conversation.style_scope || DEFAULT_SCOPES.style_scope;
  const styleFileIds = isScopeUnrestricted(styleScope)
    ? []
    : resolveScopeFileIds(styleScope, { activeFileId: context.activeFileId || conversation.file_id });
  const styleContext = await getStyleContext(topic, {
    articleTitle: context.articleTitle || topic,
    activeFileId: context.activeFileId || conversation.file_id,
    styleFileIds,
  });
  return ok({ style_context: styleContext });
}

function askUser(args = {}) {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  if (questions.length === 0) {
    return fail('QUESTION_REQUIRED', 'ask_user 需要至少一个问题。');
  }
  return ok({
    type: 'await_user_choice',
    questions: questions.slice(0, 3),
  });
}

function previewEditArticle(args = {}, context = {}) {
  const { conversation, error } = getToolConversation(context.conversationId);
  if (error) return error;
  const article = args.article || context.article;
  const operations = Array.isArray(args.operations)
    ? args.operations
    : args.operation
      ? [args.operation]
      : [];
  if (!article?.blocks || operations.length === 0) {
    return fail('INVALID_PREVIEW_REQUEST', 'preview_edit_article 需要 article.blocks 和 operation/operations。');
  }

  const fileId = normalizePositiveInt(article.file_id || article.fileId || context.activeFileId || conversation.file_id);
  if (!fileAllowedByWriteScope(fileId, conversation.write_scope || DEFAULT_SCOPES.write_scope, {
    activeFileId: context.activeFileId || conversation.file_id,
  })) {
    return fail('WRITE_SCOPE_FORBIDDEN', '当前写入范围不允许为这个文件生成修改预览。', { recoverable: false });
  }

  const operationSet = createOperationSet({
    conversationId: conversation.id,
    fileId,
    articleHash: computeArticleHash(article),
    mode: operations.length > 1 ? 'multiple' : 'single',
    operations,
    status: 'pending',
  });

  return ok({
    operation_set: operationSet,
    preview_patch_files: [{
      file_id: fileId,
      path: article.path || '',
      article_hash: operationSet.article_hash,
      operations,
      requires_confirmation: true,
    }],
  });
}

async function executeWorkspaceTool(toolName, args = {}, context = {}) {
  try {
    switch (toolName) {
      case 'search_knowledge':
        return await searchKnowledge(args, context);
      case 'read_file':
        return readFile(args, context);
      case 'get_style_context':
        return await getStyleContextTool(args, context);
      case 'ask_user':
        return askUser(args, context);
      case 'preview_edit_article':
        return previewEditArticle(args, context);
      default:
        return fail('UNKNOWN_TOOL', `未知工具：${toolName}`, { recoverable: false });
    }
  } catch (error) {
    return fail(
      'TOOL_EXECUTION_FAILED',
      error?.message || '工具执行失败。可以换一种更明确的请求，或稍后重试。',
      { extra: { detail: error?.message || String(error) } }
    );
  }
}

module.exports = {
  executeWorkspaceTool,
  fail,
  ok,
};
