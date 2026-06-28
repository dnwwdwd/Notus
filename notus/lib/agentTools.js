const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { hybridSearch } = require('./retrieval');
const { createFile, getFileByPath, writeMarkdownFile, sha256, extractTitle } = require('./files');
const { getConversation } = require('./conversations');
const { splitEditorVisibleMarkdown } = require('./markdownMeta');
const { articleFromMarkdown } = require('../utils/markdownBlocks');
const { triggerIncrementalIndex } = require('./indexer');
const {
  computeArticleHash,
  createOperationSet,
  deriveOperationSetStatus,
  getOperationSetById,
  normalizePatchStates,
  normalizePatchStatus,
  updateOperationSet,
} = require('./canvasOperationSets');
const {
  checkAndIncrementToolCount,
  getSession,
  normalizeAgentPath,
  resolveInsideNotes,
  summarizeToolResult,
  trackCreatedFile,
  validateWrite,
} = require('./agentSession');
const { resolveWebSearchConfig } = require('./searchProviderConfigs');
const { webSearch } = require('./webSearch');
const { saveWebSearchContext } = require('./webSearchContextStore');
const {
  createInteraction,
} = require('./conversationInteractions');

const ANALYZE_FOLDER_MAX_FILES = 200;

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties,
      required,
    },
  };
}

function webSearchToolDefinition() {
  return tool('web_search', '在互联网上搜索实时信息，获取最新网页内容作为参考。仅在用户打开联网搜索时可用；适合新闻、价格、近期事实、最新版本、外部资料核验等问题。同一任务可用不同关键词重复调用，但不要重复搜索相同关键词。', {
    query: { type: 'string', description: '搜索关键词，建议简洁具体。' },
  }, ['query']);
}

function buildToolDefinitions(session = {}) {
  const definitions = [
    tool('search_knowledge', '在用户的笔记知识库中检索相关内容。需要了解笔记事实时调用。', {
      query: { type: 'string', description: '检索关键词或问题' },
      scope_paths: { type: 'array', items: { type: 'string' }, description: '可选，限定检索目录或文件路径' },
      top_k: { type: 'integer', default: 5, description: '返回结果数，最大 10' },
    }, ['query']),
    tool('read_file', '读取任意 Markdown 笔记全文。读取不受写入授权范围限制。', {
      path: { type: 'string', description: '相对 notes 根目录的 Markdown 文件路径' },
    }, ['path']),
    tool('create_note', '在授权范围内新建 Markdown 笔记。新建后会记录到当前任务并支持回滚。', {
      path: { type: 'string', description: '新笔记路径，例如 drafts/article.md' },
      title: { type: 'string', description: '可选标题' },
      content: { type: 'string', description: 'Markdown 正文' },
    }, ['path', 'content']),
    tool('preview_patch_files', '为已有文件生成修改预览。必须作为该轮唯一工具调用，用户确认后才写入。', {
      patches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old: { type: 'string', description: '要替换的原文，必须来自 read_file 或 search_knowledge 结果' },
            new: { type: 'string', description: '替换后的新文本' },
          },
          required: ['file_path', 'old', 'new'],
        },
      },
    }, ['patches']),
    tool('preview_canvas_blocks', '为创作页当前文章生成块级修改预览。用户明确使用 @b1、@b2、@b3 等块引用时优先调用；它直接按块生成 replace/delete 操作，比文件级 patch 更准确、更快。必须作为该轮唯一工具调用，用户确认后才写入。', {
      file_path: { type: 'string', description: '可选，当前 Markdown 文件路径；不传则使用当前创作会话绑定的文件。' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            block_ref: { type: 'string', description: '块引用，例如 @b1、b2，或真实 block_id。' },
            op: { type: 'string', enum: ['replace', 'delete'], default: 'replace' },
            old: { type: 'string', description: '可选，当前块原文，用于校验。' },
            new: { type: 'string', description: '替换后的块内容；delete 时可为空。' },
          },
          required: ['block_ref'],
        },
      },
    }, ['edits']),
    tool('ask_question_card', '生成一张提问卡片，暂停当前 Agent 任务并等待用户回答。适合 Agent 自己发现关键信息不足时主动提问，也适合用户明确要求“生成提问卡片/出几道问题/先问我几个问题”时调用。必须作为该轮唯一工具调用。', {
      title: { type: 'string', description: '卡片标题，默认“提问卡片”。' },
      intro: { type: 'string', description: '展示在助手消息里的简短说明。' },
      submit_label: { type: 'string', description: '提交按钮文案，例如“继续执行”。' },
      questions: {
        type: 'array',
        description: '1 到 3 个问题。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '稳定问题 ID，只能包含字母、数字、下划线或短横线。' },
            label: { type: 'string', description: '问题文案。' },
            type: { type: 'string', enum: ['single_select', 'text_input'], default: 'text_input' },
            required: { type: 'boolean', default: true },
            options: {
              type: 'array',
              description: 'single_select 的选项，最多 5 个。',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['id', 'label'],
              },
            },
            allow_custom: { type: 'boolean', default: true },
            custom_placeholder: { type: 'string' },
          },
          required: ['id', 'label'],
        },
      },
    }, ['questions']),
    tool('analyze_folder', '分析目录下的 Markdown 文件结构，返回文件路径、标题和可选内容预览。', {
      folder_path: { type: 'string', description: '目录路径，空字符串表示根目录' },
      include_content_preview: { type: 'boolean', default: false },
    }, ['folder_path']),
    tool('check_links', '检查内部链接，返回孤立笔记和断链。', {
      scope_path: { type: 'string', description: '检查范围，空字符串表示全库' },
    }, ['scope_path']),
  ];
  const profile = String(session?.tool_profile || '').trim();
  const readOnlyNames = new Set(['search_knowledge', 'read_file', 'analyze_folder', 'check_links', 'ask_question_card']);
  const scopedDefinitions = profile === 'read_only'
    ? definitions.filter((item) => readOnlyNames.has(item.name))
    : definitions;

  if (session?.web_search_enabled) {
    const config = resolveWebSearchConfig(session.web_search_provider || '');
    if (config.enabled && !config.missing_api_key) {
      scopedDefinitions.push(webSearchToolDefinition());
    }
  }
  return scopedDefinitions;
}

function listFilesUnderScope(scopePaths = []) {
  const db = getDb();
  const scopes = (Array.isArray(scopePaths) ? scopePaths : []).map((item) => {
    try { return normalizeAgentPath(item, { allowRoot: true }); } catch { return null; }
  }).filter((item) => item !== null);
  if (scopes.length === 0) return [];
  const rows = db.prepare('SELECT id, path, title FROM files').all();
  return rows.filter((row) => scopes.some((scope) => !scope || row.path === scope || row.path.startsWith(`${scope}/`)));
}

async function executeSearchKnowledge({ query, scope_paths: scopePaths = [], top_k: topK = 5 } = {}, sessionId) {
  const q = String(query || '').trim();
  if (!q) return { error: 'QUERY_REQUIRED', message: 'search_knowledge 需要 query' };
  const counter = checkAndIncrementToolCount(sessionId, 'search_knowledge');
  if (!counter.allowed) return { error: 'SEARCH_LIMIT_REACHED', message: '知识库检索已达本次任务上限' };
  const session = getSession(sessionId);
  const hasScopeRequest = Array.isArray(scopePaths) && scopePaths.map((item) => String(item || '').trim()).filter(Boolean).length > 0;
  const scopedFiles = listFilesUnderScope(scopePaths);
  const fileIds = scopedFiles.length > 0 ? scopedFiles.map((file) => Number(file.id)) : [];
  const limit = session.search_knowledge_limit;
  const remaining = limit === null ? '不限' : Math.max(0, Number(limit) - Number(counter.count));
  if (hasScopeRequest && fileIds.length === 0) {
    return {
      call_index: counter.count,
      remaining_calls: remaining,
      results: [],
      scoped: true,
      message: 'scope_paths 没有匹配到可检索文件',
    };
  }
  const chunks = await hybridSearch(q, {
    topK: Math.min(Math.max(1, Number(topK) || 5), 10),
    fileIds,
  });
  return {
    call_index: counter.count,
    remaining_calls: remaining,
    results: chunks.map((chunk) => ({
      file_title: chunk.file_title,
      file_path: chunk.file_path,
      heading_path: chunk.heading_path || '',
      content: String(chunk.content || '').length > 800 ? `${String(chunk.content || '').slice(0, 800)}…[已截断，如需完整内容请用 read_file]` : String(chunk.content || ''),
      score: Math.round(Number(chunk.score || 0) * 100) / 100,
      line_start: chunk.line_start || null,
      line_end: chunk.line_end || null,
    })),
  };
}

async function executeWebSearch({ query } = {}, sessionId) {
  const q = String(query || '').trim();
  if (!q) return { success: false, message: 'web_search 需要 query 参数。', results: [] };
  const session = getSession(sessionId);
  if (!session.web_search_enabled) {
    return { success: false, message: '本次任务未启用联网搜索。', results: [] };
  }
  const counter = checkAndIncrementToolCount(sessionId, 'web_search');
  if (!counter.allowed) return { success: false, message: '联网搜索已达本次任务上限。', results: [] };
  const config = resolveWebSearchConfig(session.web_search_provider || '');
  if (!config.enabled) {
    return { success: false, message: '联网搜索未在设置中启用。', results: [] };
  }
  if (config.missing_api_key) {
    return { success: false, message: `${config.provider_name || config.provider} 需要先配置 API Key。`, results: [] };
  }
  try {
    const response = await webSearch(q, {
      provider: config.provider,
      apiKey: config.api_key,
      mode: session.web_search_mode || config.mode,
      maxResults: session.web_search_count || config.max_results,
    });
    const contextMessageId = saveWebSearchContext(session.conversation_id, {
      ...response,
      sessionId: session.id,
      toolUseId: '',
    });
  if (!response.results.length) {
      return {
        success: false,
        query: q,
        provider: response.provider,
        durationMs: response.durationMs,
        results: [],
        context_message_id: contextMessageId,
        message: `搜索"${q}"未返回结果，请尝试换用其他关键词。`,
      };
    }
    return {
      success: true,
      query: q,
      provider: response.provider,
      durationMs: response.durationMs,
      results: response.results.map((item) => ({
        title: item.title,
        url: item.url,
        content: String(item.content || '').slice(0, 4000),
        snippet: item.snippet || '',
        publishedAt: item.publishedAt || null,
      })),
      context_message_id: contextMessageId,
    };
  } catch (error) {
    return {
      success: false,
      query: q,
      provider: config.provider,
      message: error?.message || '搜索服务暂时不可用，请稍后重试。',
      results: [],
    };
  }
}

function normalizeQuestionId(value = '', index = 0) {
  const normalized = String(value || '').trim().replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || `question_${index + 1}`;
}

function normalizeQuestionCardQuestions(questions = []) {
  const used = new Set();
  return (Array.isArray(questions) ? questions : []).slice(0, 3).map((question, index) => {
    let id = normalizeQuestionId(question?.id || question?.slot, index);
    while (used.has(id)) id = `${id}_${index + 1}`;
    used.add(id);
    const type = String(question?.type || '').trim() === 'single_select' ? 'single_select' : 'text_input';
    const options = (Array.isArray(question?.options) ? question.options : [])
      .slice(0, 5)
      .map((option, optionIndex) => ({
        id: normalizeQuestionId(option?.id || option?.value, optionIndex),
        label: String(option?.label || option?.text || option?.id || '').trim(),
        description: String(option?.description || option?.hint || '').trim(),
      }))
      .filter((option) => option.id && option.label);
    return {
      id,
      slot: id,
      label: String(question?.label || question?.question || question?.title || id).trim(),
      type: type === 'single_select' && options.length > 0 ? 'single_select' : 'text_input',
      required: question?.required === false ? false : true,
      options,
      allow_custom: question?.allow_custom === false ? false : true,
      custom_placeholder: String(question?.custom_placeholder || question?.placeholder || '补充你的答案').trim(),
      recommended_option_ids: Array.isArray(question?.recommended_option_ids)
        ? question.recommended_option_ids.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 3)
        : [],
    };
  }).filter((question) => question.label);
}

function buildPendingQuestionCardResponse(payload = {}) {
  const missingSlots = (Array.isArray(payload.questions) ? payload.questions : [])
    .filter((question) => question?.required !== false)
    .map((question) => question.id)
    .filter(Boolean);
  return {
    answers: {},
    missing_slots: missingSlots,
    resolution_status: missingSlots.length > 0 ? 'failed' : 'resolved',
  };
}

function executeAskQuestionCard({
  title = '',
  intro = '',
  submit_label: submitLabel = '',
  questions = [],
} = {}, sessionId) {
  const session = getSession(sessionId);
  if (!session.conversation_id) {
    return { error: 'CONVERSATION_REQUIRED', message: 'ask_question_card 需要当前任务绑定 conversation_id' };
  }
  const normalizedQuestions = normalizeQuestionCardQuestions(questions);
  if (normalizedQuestions.length === 0) {
    return { error: 'QUESTIONS_REQUIRED', message: 'ask_question_card 需要 1 到 3 个有效问题' };
  }
  const payload = {
    title: String(title || '提问卡片').trim(),
    kicker: 'Agent 需要你确认',
    submit_label: String(submitLabel || '继续执行').trim(),
    footer_hint: `${normalizedQuestions.length} 个问题`,
    collapsed_summary: '提问卡片待回答',
    original_user_input: String(session.goal || '').trim(),
    clarify_intro: String(intro || '我先生成一张提问卡片，确认后继续执行。').trim(),
    clarify_reason: 'agent_question_card',
    agent_session_id: session.id,
    questions: normalizedQuestions,
  };
  const interaction = createInteraction({
    conversationId: session.conversation_id,
    kind: 'clarify_card',
    source: 'agent_loop',
    status: 'pending',
    reasonCode: 'agent_question_card',
    articleHash: '',
    payload,
    response: buildPendingQuestionCardResponse(payload),
  });
  return {
    question_card_requested: true,
    interaction_id: interaction.id,
    interaction,
    question_count: normalizedQuestions.length,
  };
}

function executeReadFile({ path: filePath } = {}) {
  let normalized;
  try { normalized = normalizeAgentPath(filePath, { ensureMarkdown: true }); } catch (error) { return { error: 'INVALID_PATH', message: error.message }; }
  const file = getFileByPath(normalized);
  if (!file) return { error: 'FILE_NOT_FOUND', file_path: normalized };
  return {
    file_path: file.path,
    title: file.title,
    hash: sha256(file.content || ''),
    content: file.content || '',
  };
}

function buildAgentFrontmatterContent(title = '', content = '') {
  const cleanTitle = String(title || '').trim();
  const body = String(content || '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const titleLine = cleanTitle ? `title: ${JSON.stringify(cleanTitle)}` : '';
  const frontmatter = ['---', 'created_by: notus_agent', titleLine, '---'].filter(Boolean).join('\n');
  return `${frontmatter}\n\n${body}`;
}

async function executeCreateNote({ path: filePath, content = '', title = '' } = {}, sessionId, notesDir = getEffectiveConfig().notesDir) {
  const session = getSession(sessionId);
  let normalized;
  try { normalized = normalizeAgentPath(filePath, { ensureMarkdown: true }); } catch (error) { return { error: 'INVALID_PATH', message: error.message }; }
  const check = validateWrite(session.session_token, normalized, 'create');
  if (!check.valid) return { error: 'PERMISSION_DENIED', reason: check.reason, path: normalized };
  const target = resolveInsideNotes(notesDir, normalized);
  if (fs.existsSync(target.absolutePath)) return { error: 'FILE_ALREADY_EXISTS', path: normalized };
  const finalContent = buildAgentFrontmatterContent(title, content);
  const file = createFile(normalized, finalContent);
  const finalHash = sha256(file.content || finalContent);
  trackCreatedFile(sessionId, file.path, finalHash);
  triggerIncrementalIndex(file.path).catch((error) => console.warn('[AgentLoop] 增量索引失败（非致命）:', file.path, error.message));
  return { path: file.path, title: file.title, created: true, hash: finalHash };
}

function normalizePatch(patch = {}) {
  const filePath = normalizeAgentPath(patch.file_path || patch.path, { ensureMarkdown: true });
  return {
    ...(patch || {}),
    file_path: filePath,
    old: String(patch.old ?? ''),
    new: String(patch.new ?? ''),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStoredPatches(patches = []) {
  return normalizePatchStates((Array.isArray(patches) ? patches : []).map((patch) => normalizePatch(patch)));
}

function patchConflict(reason, patch) {
  return {
    success: false,
    conflict: true,
    conflicting_files: [{ path: patch?.file_path || '', reason }],
  };
}

function replaceUnique(source = '', target = '', replacement = '', emptyReason = 'EMPTY_TARGET') {
  const current = String(source || '');
  const from = String(target ?? '');
  const to = String(replacement ?? '');
  if (from === '') {
    if (current !== '') return { ok: false, reason: emptyReason };
    return { ok: true, next: to };
  }
  const first = current.indexOf(from);
  if (first < 0) return { ok: false, reason: 'TEXT_NOT_FOUND' };
  if (current.indexOf(from, first + from.length) >= 0) return { ok: false, reason: 'TEXT_NOT_UNIQUE' };
  return {
    ok: true,
    next: `${current.slice(0, first)}${to}${current.slice(first + from.length)}`,
  };
}

function resolvePatchIndex(patches = [], { patchIndex = null, filePath = '' } = {}) {
  const numericIndex = Number(patchIndex);
  if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < patches.length) return numericIndex;
  if (filePath) {
    const normalizedPath = normalizeAgentPath(filePath, { ensureMarkdown: true });
    return patches.findIndex((patch) => patch.file_path === normalizedPath);
  }
  return -1;
}

function savePatchStates(set, patches) {
  const status = deriveOperationSetStatus(patches);
  return updateOperationSet(set.id, { patches, status });
}

async function applyPreviewPatchFile(operationSetId, sessionId, {
  patchIndex = null,
  filePath = '',
  force = false,
  auto = false,
} = {}) {
  const set = getOperationSetById(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  const patches = normalizeStoredPatches(set.patches);
  const index = resolvePatchIndex(patches, { patchIndex, filePath });
  if (index < 0) return { success: false, error: 'PATCH_NOT_FOUND' };
  const patch = patches[index];
  const status = normalizePatchStatus(patch.status);
  if (['applied', 'auto_applied'].includes(status)) {
    return { success: true, applied: true, changed_files: [], operation_set: set, patch_index: index };
  }
  if (!['pending', 'failed'].includes(status)) return { success: false, error: 'PATCH_NOT_PENDING', patch_status: status };

  const file = getFileByPath(patch.file_path);
  if (!file) return patchConflict('FILE_NOT_FOUND', patch);
  const replacement = replaceUnique(file.content || '', patch.old, patch.new, 'OLD_REQUIRED');
  if (!replacement.ok && !force) return patchConflict(replacement.reason === 'TEXT_NOT_FOUND' ? 'OLD_NOT_FOUND' : replacement.reason, patch);
  if (!replacement.ok) return patchConflict(replacement.reason, patch);

  writeMarkdownFile(patch.file_path, replacement.next);
  patches[index] = {
    ...patch,
    status: auto ? 'auto_applied' : 'applied',
    handled_at: nowIso(),
    error: '',
  };
  const operationSet = savePatchStates(set, patches);
  triggerIncrementalIndex(patch.file_path).catch((error) => console.warn('[AgentLoop] 增量索引失败（非致命）:', patch.file_path, error.message));
  return { success: true, applied: true, changed_files: [patch.file_path], operation_set: operationSet, patch_index: index };
}

async function rollbackPreviewPatchFile(operationSetId, sessionId, {
  patchIndex = null,
  filePath = '',
  force = false,
} = {}) {
  const set = getOperationSetById(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  const patches = normalizeStoredPatches(set.patches);
  const index = resolvePatchIndex(patches, { patchIndex, filePath });
  if (index < 0) return { success: false, error: 'PATCH_NOT_FOUND' };
  const patch = patches[index];
  const status = normalizePatchStatus(patch.status);
  if (['rolled_back', 'discarded'].includes(status)) {
    return { success: true, rolled_back: true, changed_files: [], operation_set: set, patch_index: index };
  }
  if (status === 'pending' || status === 'failed') {
    patches[index] = { ...patch, status: 'rolled_back', handled_at: nowIso(), error: '' };
    const operationSet = savePatchStates(set, patches);
    return { success: true, rolled_back: true, changed_files: [], operation_set: operationSet, patch_index: index };
  }

  const file = getFileByPath(patch.file_path);
  if (!file) return patchConflict('FILE_NOT_FOUND', patch);
  const replacement = replaceUnique(file.content || '', patch.new, patch.old, 'NEW_NOT_FOUND');
  if (!replacement.ok && !force) return patchConflict(replacement.reason === 'TEXT_NOT_FOUND' ? 'NEW_NOT_FOUND' : replacement.reason, patch);
  if (!replacement.ok) return patchConflict(replacement.reason, patch);

  writeMarkdownFile(patch.file_path, replacement.next);
  patches[index] = { ...patch, status: 'rolled_back', handled_at: nowIso(), error: '' };
  const operationSet = savePatchStates(set, patches);
  triggerIncrementalIndex(patch.file_path).catch((error) => console.warn('[AgentLoop] 增量索引失败（非致命）:', patch.file_path, error.message));
  return { success: true, rolled_back: true, changed_files: [patch.file_path], operation_set: operationSet, patch_index: index };
}

async function discardPreviewPatchFile(operationSetId, sessionId, {
  patchIndex = null,
  filePath = '',
} = {}) {
  const set = getOperationSetById(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  const patches = normalizeStoredPatches(set.patches);
  const index = resolvePatchIndex(patches, { patchIndex, filePath });
  if (index < 0) return { success: false, error: 'PATCH_NOT_FOUND' };
  const patch = patches[index];
  const status = normalizePatchStatus(patch.status);
  if (status !== 'pending' && status !== 'failed') return { success: true, discarded: false, changed_files: [], operation_set: set, patch_index: index };
  patches[index] = { ...patch, status: 'discarded', handled_at: nowIso(), error: '' };
  const operationSet = savePatchStates(set, patches);
  return { success: true, discarded: true, changed_files: [], operation_set: operationSet, patch_index: index };
}

async function discardPendingPreviewPatches(operationSetId, sessionId) {
  const set = getOperationSetById(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  const patches = normalizeStoredPatches(set.patches);
  let discarded = 0;
  const nextPatches = patches.map((patch) => {
    const status = normalizePatchStatus(patch.status);
    if (status !== 'pending' && status !== 'failed') return patch;
    discarded += 1;
    return { ...patch, status: 'discarded', handled_at: nowIso(), error: '' };
  });
  const operationSet = savePatchStates(set, nextPatches);
  return { success: true, discarded_count: discarded, operation_set: operationSet };
}

function findUniqueIndex(source = '', target = '') {
  if (!target) return -1;
  const first = source.indexOf(target);
  if (first < 0) return -1;
  return source.indexOf(target, first + target.length) < 0 ? first : -2;
}

function buildCollapsedWhitespaceIndex(value = '') {
  const source = String(value || '');
  let normalized = '';
  const map = [];
  let previousWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) {
      if (!previousWhitespace) {
        normalized += ' ';
        map.push(index);
        previousWhitespace = true;
      }
    } else {
      normalized += char;
      map.push(index);
      previousWhitespace = false;
    }
  }
  return { source, normalized, map };
}

function alignPatchOldText(currentContent = '', oldText = '') {
  const current = String(currentContent || '');
  const old = String(oldText ?? '');
  if (!old) return { ok: true, old: '', strategy: 'empty' };
  if (current.includes(old)) return { ok: true, old, strategy: 'exact' };

  const trimmed = old.trim();
  if (trimmed) {
    const trimmedIndex = findUniqueIndex(current, trimmed);
    if (trimmedIndex >= 0) {
      return { ok: true, old: current.slice(trimmedIndex, trimmedIndex + trimmed.length), strategy: 'trimmed' };
    }
  }

  const currentIndex = buildCollapsedWhitespaceIndex(current);
  const oldCollapsed = buildCollapsedWhitespaceIndex(old).normalized.trim();
  if (!oldCollapsed) return { ok: false, reason: 'EMPTY_OLD_AFTER_NORMALIZE' };
  const collapsedIndex = findUniqueIndex(currentIndex.normalized, oldCollapsed);
  if (collapsedIndex >= 0) {
    const endCollapsedIndex = collapsedIndex + oldCollapsed.length - 1;
    const start = currentIndex.map[collapsedIndex];
    const end = currentIndex.map[endCollapsedIndex] + 1;
    return { ok: true, old: currentIndex.source.slice(start, end), strategy: 'collapsed_whitespace' };
  }
  if (collapsedIndex === -2) {
    return { ok: false, reason: 'OLD_MATCH_NOT_UNIQUE', message: 'old 文本在当前文件中出现多处近似匹配，请扩大 old 范围后重试。' };
  }
  return { ok: false, reason: 'OLD_NOT_FOUND', message: 'old 文本没有在当前文件中找到唯一匹配，请先 read_file 读取精确原文后重试。' };
}

async function executePreviewPatchFiles({ patches = [] } = {}, sessionId) {
  const session = getSession(sessionId);
  const normalized = (Array.isArray(patches) ? patches : []).map((patch) => {
    try { return normalizePatch(patch); } catch { return null; }
  }).filter(Boolean);
  if (normalized.length === 0) return { error: 'PATCHES_REQUIRED', message: 'preview_patch_files 需要 patches' };
  for (const patch of normalized) {
    const check = validateWrite(session.session_token, patch.file_path, 'modify');
    if (!check.valid) return { error: 'PERMISSION_DENIED', reason: check.reason, path: patch.file_path };
    const file = getFileByPath(patch.file_path);
    if (!file) return { error: 'FILE_NOT_FOUND', path: patch.file_path };
    const current = String(file.content || '');
    if (patch.old === '' && current !== '') return { error: 'OLD_REQUIRED', path: patch.file_path, message: '非空文件必须提供可二次校验的 old 文本' };
    const aligned = alignPatchOldText(current, patch.old);
    if (!aligned.ok) {
      return {
        error: 'OLD_NOT_FOUND',
        path: patch.file_path,
        reason: aligned.reason,
        message: aligned.message || 'old 文本没有在当前文件中找到唯一匹配',
      };
    }
    patch.old = aligned.old;
  }
  const operationSet = createOperationSet({
    conversationId: session.conversation_id,
    agentSessionId: session.id,
    articleHash: sha256(JSON.stringify(normalized)),
    mode: normalized.length > 1 ? 'multiple_files' : 'single_file',
    operations: [],
    patches: normalized,
    status: 'pending',
  });
  return { operation_set_id: operationSet.id, patch_count: normalized.length, patches: normalized.map((patch) => ({ file_path: patch.file_path })) };
}

function normalizeCanvasBlockRef(ref = '') {
  const value = String(ref || '').trim();
  const match = value.match(/^@?b(\d+)$/i);
  if (match) return { index: Number(match[1]) - 1, blockId: '' };
  return { index: null, blockId: value };
}

function getSessionFilePath(session = {}, explicitPath = '') {
  if (explicitPath) return normalizeAgentPath(explicitPath, { ensureMarkdown: true });
  const conversation = session.conversation_id ? getConversation(session.conversation_id) : null;
  const fileId = Number(conversation?.file_id || 0);
  if (!fileId) throw new Error('当前会话没有绑定文件，请提供 file_path');
  const db = getDb();
  const row = db.prepare('SELECT path FROM files WHERE id = ?').get(fileId);
  if (!row?.path) throw new Error('当前会话绑定文件不存在');
  return normalizeAgentPath(row.path, { ensureMarkdown: true });
}

async function loadCanvasArticle(file) {
  const { visibleContent } = splitEditorVisibleMarkdown(file.content || '');
  return articleFromMarkdown({
    id: `article_${file.id}`,
    file_id: file.id,
    title: file.title,
    markdown: visibleContent || '',
  });
}

async function executePreviewCanvasBlocks({ file_path: filePath = '', edits = [] } = {}, sessionId) {
  const session = getSession(sessionId);
  let normalizedPath;
  try {
    normalizedPath = getSessionFilePath(session, filePath);
  } catch (error) {
    return { error: 'FILE_PATH_REQUIRED', message: error.message };
  }

  const check = validateWrite(session.session_token, normalizedPath, 'modify');
  if (!check.valid) return { error: 'PERMISSION_DENIED', reason: check.reason, path: normalizedPath };
  const file = getFileByPath(normalizedPath);
  if (!file) return { error: 'FILE_NOT_FOUND', path: normalizedPath };
  const article = await loadCanvasArticle(file);
  const blocks = Array.isArray(article.blocks) ? article.blocks : [];
  const queue = Array.isArray(edits) ? edits : [];
  if (queue.length === 0) return { error: 'EDITS_REQUIRED', message: 'preview_canvas_blocks 需要 edits' };

  const operations = [];
  for (const edit of queue) {
    const ref = normalizeCanvasBlockRef(edit?.block_ref || edit?.block_id || edit?.ref);
    const block = Number.isInteger(ref.index)
      ? blocks[ref.index]
      : blocks.find((item) => String(item.id) === String(ref.blockId));
    if (!block) {
      return {
        error: 'BLOCK_NOT_FOUND',
        block_ref: edit?.block_ref || edit?.block_id || '',
        message: '没有找到对应文本块，请使用 @b1、@b2 这类当前文章块编号。',
      };
    }
    const op = String(edit?.op || 'replace').trim().toLowerCase() === 'delete' ? 'delete' : 'replace';
    const expectedOld = String(edit?.old || '').trim();
    const current = String(block.content || '');
    if (expectedOld && current.trim() !== expectedOld) {
      return {
        error: 'OLD_MISMATCH',
        block_ref: edit?.block_ref || edit?.block_id || '',
        message: '块内容已变化，请基于当前块原文重新生成预览。',
      };
    }
    operations.push({
      op,
      block_id: block.id,
      old: current,
      new: op === 'delete' ? '' : String(edit?.new || ''),
      type: block.type || 'paragraph',
    });
  }

  const conversation = session.conversation_id ? getConversation(session.conversation_id) : null;
  const operationSet = createOperationSet({
    conversationId: session.conversation_id,
    agentSessionId: session.id,
    fileId: file.id || conversation?.file_id || null,
    articleHash: computeArticleHash(article),
    mode: operations.length > 1 ? 'multiple' : 'single',
    operations,
    patches: [],
    status: 'pending',
  });
  return {
    operation_set_id: operationSet.id,
    operation_count: operations.length,
    file_path: file.path,
    block_refs: operations.map((operation) => operation.block_id),
  };
}

async function applyPreviewWithConflictCheck(operationSetId, sessionId, { force = false, approvalMode = '', auto = false } = {}) {
  const set = getOperationSetById(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  const patches = normalizeStoredPatches(set.patches);
  if (patches.length === 0) return { success: false, error: 'PATCHES_REQUIRED' };
  const changed = [];
  let latestSet = set;
  for (let index = 0; index < patches.length; index += 1) {
    const patch = patches[index];
    const status = normalizePatchStatus(patch.status);
    if (status !== 'pending' && status !== 'failed') continue;
    const result = await applyPreviewPatchFile(operationSetId, sessionId, {
      patchIndex: index,
      force,
      auto: auto || approvalMode === 'auto_confirm' || approvalMode === 'auto_apply',
    });
    if (!result.success) return result;
    latestSet = result.operation_set || latestSet;
    changed.push(...(Array.isArray(result.changed_files) ? result.changed_files : []));
  }
  return { success: true, applied: true, changed_files: changed, operation_set: latestSet };
}

function listMarkdownFiles(absPath, notesDir) {
  const results = [];
  if (!fs.existsSync(absPath)) return results;
  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    if (/\.md$/i.test(absPath)) results.push(absPath);
    return results;
  }
  if (!stat.isDirectory()) return results;
  fs.readdirSync(absPath, { withFileTypes: true }).forEach((entry) => {
    if (entry.name.startsWith('.')) return;
    const next = path.join(absPath, entry.name);
    if (entry.isDirectory()) results.push(...listMarkdownFiles(next, notesDir));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) results.push(next);
  });
  return results;
}

function executeAnalyzeFolder({ folder_path: folderPath = '', include_content_preview: includePreview = false } = {}, sessionId, notesDir = getEffectiveConfig().notesDir) {
  let target;
  try { target = resolveInsideNotes(notesDir, folderPath, { allowRoot: true }); } catch (error) { return { error: 'INVALID_PATH', message: error.message }; }
  if (!fs.existsSync(target.absolutePath)) return { error: 'FOLDER_NOT_FOUND', path: target.relativePath };
  const all = listMarkdownFiles(target.absolutePath, notesDir);
  const truncated = all.length > ANALYZE_FOLDER_MAX_FILES;
  const selected = truncated ? all.slice(0, ANALYZE_FOLDER_MAX_FILES) : all;
  const files = selected.map((absPath) => {
    const relPath = path.relative(path.resolve(notesDir), absPath).replace(/\\/g, '/');
    const content = fs.readFileSync(absPath, 'utf8');
    const item = { path: relPath, title: extractTitle(relPath, content) };
    if (includePreview) item.preview = content.slice(0, 160);
    return item;
  });
  return { folder_path: target.relativePath, file_count: files.length, total_count: all.length, truncated, truncate_limit: ANALYZE_FOLDER_MAX_FILES, files };
}

function normalizeLinkTarget(rawTarget = '', currentPath = '') {
  const rawClean = String(rawTarget || '').split('|')[0].split('#')[0].split('?')[0].trim();
  let clean = rawClean;
  try { clean = decodeURIComponent(rawClean); } catch {}
  if (!clean || /^https?:\/\//i.test(clean) || clean.startsWith('mailto:')) return null;
  if (/\.[a-z0-9]+$/i.test(clean) && !/\.md$/i.test(clean)) return null;
  const baseDir = path.posix.dirname(currentPath);
  const withExt = /\.md$/i.test(clean) ? clean : `${clean}.md`;
  const resolved = clean.startsWith('/') ? withExt.replace(/^\/+/, '') : path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, withExt));
  if (!resolved || resolved === '.' || resolved.startsWith('../')) return null;
  return resolved;
}

function extractInternalLinks(content = '', currentPath = '') {
  const links = [];
  const wikiRe = /\[\[([^\]]+)\]\]/g;
  let match = wikiRe.exec(content);
  while (match) {
    const target = normalizeLinkTarget(match[1], currentPath);
    if (target) links.push(target);
    match = wikiRe.exec(content);
  }
  const mdRe = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  match = mdRe.exec(content);
  while (match) {
    const target = normalizeLinkTarget(match[1], currentPath);
    if (target) links.push(target);
    match = mdRe.exec(content);
  }
  return [...new Set(links)];
}

function executeCheckLinks({ scope_path: scopePath = '' } = {}, sessionId, notesDir = getEffectiveConfig().notesDir) {
  let scope;
  try { scope = resolveInsideNotes(notesDir, scopePath, { allowRoot: true }); } catch (error) { return { error: 'INVALID_PATH', message: error.message }; }
  const files = listMarkdownFiles(scope.absolutePath, notesDir).map((absPath) => {
    const relPath = path.relative(path.resolve(notesDir), absPath).replace(/\\/g, '/');
    const content = fs.readFileSync(absPath, 'utf8');
    return { path: relPath, title: extractTitle(relPath, content), content };
  });
  const existing = new Set(files.map((file) => file.path));
  const incoming = new Map(files.map((file) => [file.path, 0]));
  const outgoing = new Map();
  const brokenLinks = [];
  files.forEach((file) => {
    const links = extractInternalLinks(file.content, file.path);
    outgoing.set(file.path, links);
    links.forEach((target) => {
      if (existing.has(target)) incoming.set(target, Number(incoming.get(target) || 0) + 1);
      else brokenLinks.push({ from: file.path, target });
    });
  });
  const orphans = files
    .filter((file) => Number(incoming.get(file.path) || 0) === 0 && (outgoing.get(file.path) || []).length === 0)
    .map((file) => ({ path: file.path, title: file.title }));
  return { orphan_count: orphans.length, orphans, broken_count: brokenLinks.length, broken_links: brokenLinks };
}

function validateToolUseBlock(toolUseBlocks = []) {
  const blocks = Array.isArray(toolUseBlocks) ? toolUseBlocks : [];
  const preview = blocks.find((block) => ['preview_patch_files', 'preview_canvas_blocks', 'ask_question_card'].includes(block.name));
  if (preview && blocks.length > 1) {
    return { error: true, errorToolUseId: preview.id, message: `${preview.name} 必须是该轮的唯一工具调用，请在下一轮单独调用它。` };
  }
  return { error: false };
}

function extractTargetPaths(toolUse = {}) {
  const input = toolUse.input || {};
  if (toolUse.name === 'create_note') return [input.path].filter(Boolean);
  if (toolUse.name === 'preview_patch_files') return (Array.isArray(input.patches) ? input.patches : []).map((patch) => patch.file_path || patch.path).filter(Boolean);
  if (toolUse.name === 'preview_canvas_blocks') return [input.file_path].filter(Boolean);
  return [];
}

function summarizeInput(toolUse = {}) {
  const input = toolUse.input || {};
  if (toolUse.name === 'search_knowledge') return input.query || '';
  if (toolUse.name === 'web_search') return input.query || '';
  if (toolUse.name === 'read_file') return input.path || '';
  if (toolUse.name === 'create_note') return input.path || '';
  if (toolUse.name === 'preview_patch_files') return `${Array.isArray(input.patches) ? input.patches.length : 0} 个文件修改`; 
  if (toolUse.name === 'preview_canvas_blocks') return `${Array.isArray(input.edits) ? input.edits.length : 0} 个块级修改`;
  if (toolUse.name === 'ask_question_card') return `${Array.isArray(input.questions) ? input.questions.length : 0} 个问题`;
  if (toolUse.name === 'analyze_folder') return input.folder_path || '根目录';
  if (toolUse.name === 'check_links') return input.scope_path || '全库';
  return toolUse.name || '';
}

async function executeToolSafely(toolUse = {}, session, notesDir = getEffectiveConfig().notesDir) {
  try {
    if (['create_note', 'preview_patch_files', 'preview_canvas_blocks'].includes(toolUse.name)) {
      const paths = extractTargetPaths(toolUse);
      for (const targetPath of paths) {
        const operation = toolUse.name === 'create_note' ? 'create' : 'modify';
        const check = validateWrite(session.session_token, targetPath, operation);
        if (!check.valid) return { error: 'PERMISSION_DENIED', path: targetPath, reason: check.reason };
      }
    }
    const executor = TOOL_EXECUTORS[toolUse.name];
    if (!executor) return { error: 'UNKNOWN_TOOL', tool_name: toolUse.name };
    return await executor(toolUse.input || {}, session.id, notesDir);
  } catch (error) {
    return { error: 'TOOL_EXECUTION_ERROR', message: error.message };
  }
}

const TOOL_EXECUTORS = {
  search_knowledge: executeSearchKnowledge,
  web_search: executeWebSearch,
  read_file: executeReadFile,
  create_note: executeCreateNote,
  preview_patch_files: executePreviewPatchFiles,
  preview_canvas_blocks: executePreviewCanvasBlocks,
  ask_question_card: executeAskQuestionCard,
  analyze_folder: executeAnalyzeFolder,
  check_links: executeCheckLinks,
};

module.exports = {
  buildToolDefinitions,
  validateToolUseBlock,
  extractTargetPaths,
  summarizeInput,
  summarizeToolResult,
  executeToolSafely,
  executeSearchKnowledge,
  executeWebSearch,
  executeReadFile,
  executeCreateNote,
  executePreviewPatchFiles,
  executePreviewCanvasBlocks,
  executeAskQuestionCard,
  executeAnalyzeFolder,
  executeCheckLinks,
  applyPreviewWithConflictCheck,
  applyPreviewPatchFile,
  rollbackPreviewPatchFile,
  discardPreviewPatchFile,
  discardPendingPreviewPatches,
  alignPatchOldText,
  TOOL_EXECUTORS,
};
