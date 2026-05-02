const { completeChat } = require('./llm');
const { sha256 } = require('./files');
const { buildCanvasQueryPlanPrompt } = require('./prompt');
const { trimTextToTokenBudget } = require('./llmBudget');

const PLANNER_VERSION = 'canvas-intent-v5';
const HELPER_CACHE_TTL_MS = 3 * 60 * 1000;
const MAX_TARGET_CANDIDATES = 6;
const MAX_SOURCE_CANDIDATES = 6;
const HELPER_CACHE = new Map();

const ALLOWED_OPERATION_KINDS = [
  'rewrite',
  'polish',
  'expand',
  'shrink',
  'merge',
  'reorder',
  'delete',
  'insert',
  'analyze',
  'discuss',
];

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function normalizeOperationKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (ALLOWED_OPERATION_KINDS.includes(normalized)) return normalized;
  return 'rewrite';
}

function normalizeScopeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['single', 'multiple', 'global', 'none'].includes(normalized)) return normalized;
  return 'none';
}

function normalizePrimaryIntent(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'analyze') return 'analyze';
  if (normalized === 'edit') return 'edit';
  if (normalized === 'discuss' || normalized === 'text') return 'text';
  return 'text';
}

function normalizeRiskLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['low', 'medium', 'high'].includes(normalized)) return normalized;
  return 'low';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function blockLabel(index) {
  return `@b${index + 1}`;
}

function getBlockHeadingPath(block = {}) {
  return String(block.headingPath || block.heading_path || '').trim();
}

function getBlockText(block = {}) {
  return String(block.content || '').trim();
}

function findBlockByOrdinal(article, ordinal) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  const index = Number(ordinal) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) return null;
  return blocks[index];
}

function normalizeTargetRefs(targetRefs = [], article) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  const ids = [];
  (Array.isArray(targetRefs) ? targetRefs : []).forEach((ref) => {
    const normalized = String(ref || '').trim().toLowerCase();
    if (!normalized) return;
    const block = blocks.find((item, index) => {
      return normalized === String(item.id || '').trim().toLowerCase()
        || normalized === `@b${index + 1}`
        || normalized === `b${index + 1}`
        || normalized === String(index + 1);
    });
    if (block && !ids.includes(block.id)) ids.push(block.id);
  });
  return ids;
}

function parseExplicitMentionIds(article, userInput) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  const byId = [];
  const addByOrdinal = (ordinal) => {
    const block = findBlockByOrdinal(article, ordinal);
    if (block && !byId.includes(block.id)) byId.push(block.id);
  };

  const text = String(userInput || '');
  const rangeMatches = Array.from(text.matchAll(/@b(\d+)\s*-\s*(?:@?b)?(\d+)/gi));
  rangeMatches.forEach((match) => {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    for (let index = from; index <= to; index += 1) addByOrdinal(index);
  });

  const singleMatches = Array.from(text.matchAll(/@b(\d+)\b/gi));
  singleMatches.forEach((match) => addByOrdinal(Number(match[1])));

  const ordinalMatches = Array.from(text.matchAll(/第\s*(\d+)\s*(段|块)/g));
  ordinalMatches.forEach((match) => addByOrdinal(Number(match[1])));

  if (/开头|前面第一段|第一段|第一块/.test(text)) {
    const first = blocks[0];
    if (first && !byId.includes(first.id)) byId.push(first.id);
  }
  if (/结尾|最后一段|最后一块|末尾/.test(text)) {
    const last = blocks[blocks.length - 1];
    if (last && !byId.includes(last.id)) byId.push(last.id);
  }

  return byId;
}

function isGlobalPhrase(input = '') {
  return /全文|整篇|整文|全篇|通篇|整篇文章|整篇内容|整个文章|整篇都/.test(String(input || ''));
}

function extractSearchTerms(text = '') {
  const normalized = String(text || '').toLowerCase();
  const words = normalized.match(/[a-z0-9]{3,}/g) || [];
  const hanGroups = normalized.match(/[\u3400-\u9fff]{2,}/g) || [];
  return unique([...words, ...hanGroups]);
}

function scoreBlockByTerms(block, terms = []) {
  if (!block || !Array.isArray(terms) || terms.length === 0) return 0;
  const headingPath = getBlockHeadingPath(block).toLowerCase();
  const content = getBlockText(block).toLowerCase();
  return terms.reduce((score, term) => {
    if (!term) return score;
    if (headingPath.includes(term)) score += 5;
    if (content.includes(term)) score += 3;
    return score;
  }, 0);
}

function detectPromptInjectionSignals(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  const hits = [];
  if (/忽略.*规则|忽略.*提示|ignore .*instruction/i.test(normalized)) hits.push('ignore_rules');
  if (/直接替换全文|必须替换全文|不要提问|立即覆盖|system prompt/i.test(normalized)) hits.push('force_full_replace');
  if (/只输出|必须输出|不能输出解释/.test(normalized)) hits.push('output_control');
  return unique(hits);
}

function buildNeighborPreview(block) {
  return trimTextToTokenBudget(getBlockText(block), 28, ' …').replace(/\s+/g, ' ').trim();
}

function buildCandidatePreview(block) {
  return trimTextToTokenBudget(getBlockText(block), 56, ' …').replace(/\s+/g, ' ').trim() || '空白块';
}

function buildArticleHash(article = {}) {
  const payload = {
    title: article?.title || '',
    file_id: article?.file_id || article?.fileId || null,
    blocks: Array.isArray(article?.blocks)
      ? article.blocks.map((block) => ({
        id: block.id,
        type: block.type,
        content: block.content || '',
      }))
      : [],
  };
  return sha256(JSON.stringify(payload));
}

function buildHistoryDigest(history = []) {
  return sha256(JSON.stringify((Array.isArray(history) ? history : []).slice(-8).map((item) => ({
    id: item?.id || null,
    role: item?.role || '',
    content: String(item?.content || '').slice(0, 600),
    meta: item?.meta || null,
  }))));
}

function getHelperCacheKey({ articleHash, historyDigest, userInputDigest, mode }) {
  return `${mode}:${articleHash}:${historyDigest}:${userInputDigest}:${PLANNER_VERSION}`;
}

function getCachedHelperResult(key) {
  const hit = HELPER_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.createdAt > HELPER_CACHE_TTL_MS) {
    HELPER_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function setCachedHelperResult(key, value) {
  HELPER_CACHE.set(key, {
    createdAt: Date.now(),
    value,
  });
}

function extractRecentCanvasContext(history = []) {
  const items = Array.isArray(history) ? history : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role !== 'assistant') continue;
    const meta = item?.meta && typeof item.meta === 'object' ? item.meta : {};
    const targetBlockIds = Array.isArray(meta.target_block_ids)
      ? meta.target_block_ids.filter(Boolean)
      : [];
    const scopeMode = normalizeScopeMode(meta.scope_mode || '');
    const operationKind = meta.operation_kind
      ? normalizeOperationKind(meta.operation_kind)
      : '';
    const lastFocusSummary = trimTextToTokenBudget(
      meta.last_focus_summary || item.content || '',
      80,
      ' …'
    );

    if (targetBlockIds.length === 0 && !lastFocusSummary && scopeMode === 'none' && !operationKind) {
      continue;
    }

    return {
      target_block_ids: targetBlockIds,
      scope_mode: scopeMode,
      canvas_mode: String(meta.canvas_mode || '').trim() || 'edit',
      operation_kind: operationKind,
      last_focus_summary: lastFocusSummary,
      decision_summary: String(meta.decision_summary || '').trim(),
      source_content_type: String(meta.source_content_type || '').trim(),
      correction_state: meta.correction_state && typeof meta.correction_state === 'object'
        ? meta.correction_state
        : null,
    };
  }
  return null;
}

function detectCorrectionState(userInput = '', metaState = null) {
  const next = metaState && typeof metaState === 'object' ? { ...metaState } : {};
  const text = String(userInput || '');
  if (/不是聊天|不要聊天|别聊天|不要继续聊|直接改文档/.test(text)) {
    next.wrong_intent = 'text';
    next.preferred_primary_intent = 'edit';
  }
  if (/继续讨论|先讨论|先别改文档|不要直接改文档/.test(text)) {
    next.wrong_intent = 'edit';
    next.preferred_primary_intent = 'text';
  }
  if (/不是这段|不是这一段|目标不对|改的不是这段/.test(text)) {
    next.wrong_target = true;
  }
  if (/来源不对|内容来源不对|不是上一条|不是上面的内容|不是刚才那段/.test(text)) {
    next.wrong_source = true;
  }
  if (/写入方式不对|不是替换|不是追加|不要替换|不要覆盖|不要追加/.test(text)) {
    next.wrong_write_action = true;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function extractRecentCorrectionState(history = [], articleHash = '') {
  const items = Array.isArray(history) ? history : [];
  const merged = {};
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role !== 'user' && item?.role !== 'assistant') continue;
    const meta = item?.meta && typeof item.meta === 'object' ? item.meta : {};
    if (articleHash && meta.article_hash && String(meta.article_hash) !== String(articleHash)) continue;
    const next = detectCorrectionState(item.content || '', meta.correction_state);
    if (!next) continue;
    Object.assign(merged, next);
    if (merged.preferred_primary_intent || merged.wrong_target || merged.wrong_source || merged.wrong_write_action) {
      break;
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function needsCarryPreviousTarget(userInput = '') {
  return /这段|这一段|刚才那段|上面那段|继续改|继续润|继续写|再润一下|再改一下|延续刚才|接着改/.test(String(userInput || ''));
}

function needsCarryPreviousSummary(userInput = '') {
  return /按刚才(?:的)?建议改|按上面(?:的)?问题改|按刚才(?:的)?问题改|根据刚才(?:的)?建议改|照着刚才(?:的)?建议改/.test(String(userInput || ''));
}

function shouldCarryPreviousOperation(userInput = '', inferredOperationKind = 'rewrite') {
  if (inferredOperationKind !== 'rewrite') return false;
  return /继续改|继续写|延续刚才|接着改|按刚才(?:的)?建议改|按上面(?:的)?问题改|按刚才(?:的)?问题改/.test(String(userInput || ''));
}

function inferIntentCandidates(userInput = '', options = {}) {
  const text = String(userInput || '').trim();
  const scores = { edit: 0, text: 0, analyze: 0 };
  const reasons = { edit: [], text: [], analyze: [] };
  const pushReason = (kind, score, reason) => {
    scores[kind] += score;
    reasons[kind].push(reason);
  };

  if (!text) {
    pushReason('text', 2, 'empty_input');
  }

  if (/分析|评估|点评|检查|可读性|逻辑|结构|完整性|风格一致性|哪里有问题/.test(text)) {
    pushReason('analyze', 7, 'analysis_keyword');
  }
  if (/写到文档|写入文档|写进去|写到正文|写进正文|落到文档|落到正文|放到文档|放进文档|加入文档|写到文章里/.test(text)) {
    pushReason('edit', 9, 'write_to_document_keyword');
  }
  if (/改写|重写|润色|扩写|压缩|精简|删掉|删除|新增|插入|合并|交换顺序|调序|重排|统一.*语气|仿写|模仿|修改|改一下|改得|更简洁|更顺|继续改|接着改|继续润|再润一下|润一润|按刚才(?:的)?建议改|按上面(?:的)?问题改|按刚才(?:的)?问题改/.test(text)) {
    pushReason('edit', 6, 'edit_keyword');
  }
  if (/^改/.test(text)) {
    pushReason('edit', 3, 'rewrite_prefix');
  }
  if (/聊聊|讨论|怎么看|建议一下|是否合理|对不对|觉得.*怎么样|你觉得|帮我想想/.test(text)) {
    pushReason('text', 6, 'discussion_keyword');
  }
  if (Array.isArray(options.explicitTargets) && options.explicitTargets.length > 0) {
    pushReason('edit', 4, 'explicit_target');
  }
  if (options.globalPhrase) {
    pushReason('edit', 3, 'global_phrase');
  }
  if (options.requestedSourceType === 'draft_text') {
    pushReason('edit', 5, 'draft_source_reference');
  }
  if (options.correctionState?.preferred_primary_intent === 'edit') {
    pushReason('edit', 8, 'recent_user_correction');
  }
  if (options.correctionState?.preferred_primary_intent === 'text') {
    pushReason('text', 8, 'recent_user_correction');
  }
  if (options.correctionState?.preferred_primary_intent === 'analyze') {
    pushReason('analyze', 8, 'recent_user_correction');
  }

  return ['edit', 'text', 'analyze']
    .map((id) => ({
      id,
      score: scores[id],
      reasons: reasons[id],
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function resolvePrimaryIntent(intentCandidates = []) {
  const list = Array.isArray(intentCandidates) ? intentCandidates : [];
  const top = list[0] || { id: 'text', score: 0 };
  const second = list[1] || { id: 'text', score: 0 };
  const topScore = Number(top.score || 0);
  const secondScore = Number(second.score || 0);
  const total = list.reduce((sum, item) => sum + Number(item.score || 0), 0) || 1;
  const confidence = clamp(0.42 + ((topScore - secondScore) * 0.08) + (topScore / total * 0.2), 0.35, 0.98);
  return {
    primary_intent: normalizePrimaryIntent(top.id),
    confidence,
    ambiguous: topScore === 0 || (topScore - secondScore) <= 2,
  };
}

function inferOperationKind(userInput = '') {
  const text = String(userInput || '');
  if (/写到文档|写入文档|写进去|写到正文|落到文档|落到正文|放到文档|加入文档/.test(text)) return 'insert';
  if (/按刚才(?:的)?建议改|按上面(?:的)?问题改|按刚才(?:的)?问题改|继续改|接着改|延续刚才/.test(text)) return 'rewrite';
  if (/交换顺序|调整顺序|调序|重排|换一下顺序/.test(text)) return 'reorder';
  if (/合并|并成一段|合成一段/.test(text)) return 'merge';
  if (/删掉|删除|去掉/.test(text)) return 'delete';
  if (/插入|新增一段|补一段|加一段/.test(text)) return 'insert';
  if (/扩写|展开|补充论证|补充细节/.test(text)) return 'expand';
  if (/压缩|精简|缩短|更简洁|更短/.test(text)) return 'shrink';
  if (/润色|统一.*语气|仿写|模仿|风格|再润一下|润一润|继续润/.test(text)) return 'polish';
  if (/分析|评估|点评/.test(text)) return 'analyze';
  if (/聊聊|讨论|怎么看|建议/.test(text)) return 'discuss';
  return 'rewrite';
}

function inferOperationCandidates(userInput = '') {
  const operationKind = inferOperationKind(userInput);
  return unique([operationKind, operationKind === 'rewrite' ? 'polish' : '', operationKind === 'insert' ? 'rewrite' : '']).filter(Boolean);
}

function inferNeedsStyle(intent, operationKind, options = {}) {
  if (intent !== 'edit') return false;
  if (options.styleMode === 'manual') return true;
  return ['rewrite', 'polish', 'expand', 'shrink', 'merge'].includes(operationKind);
}

function inferNeedsKnowledge(userInput = '', options = {}) {
  if (options.referenceMode === 'manual' && Array.isArray(options.factFileIds) && options.factFileIds.length > 0) {
    return true;
  }
  return /根据知识库|根据笔记|结合笔记|引用|事实|资料|例子|论据|证据|补充事实/.test(String(userInput || ''));
}

function buildPlannerBlockPackage(article, blockId, score, reasons = []) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  const index = blocks.findIndex((item) => item.id === blockId);
  if (index < 0) return null;
  const block = blocks[index];
  return {
    block_id: block.id,
    ref: blockLabel(index),
    index: index + 1,
    type: block.type,
    heading_path: getBlockHeadingPath(block),
    preview: buildCandidatePreview(block),
    previous_preview: index > 0 ? buildNeighborPreview(blocks[index - 1]) : '',
    next_preview: index < blocks.length - 1 ? buildNeighborPreview(blocks[index + 1]) : '',
    score,
    reasons: unique(reasons),
  };
}

function buildTargetCandidates(article, userInput = '', options = {}) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  const text = String(userInput || '');
  const explicitTargets = Array.isArray(options.explicitTargets) ? options.explicitTargets : [];
  const recentTargetIds = Array.isArray(options.recentTargetIds) ? options.recentTargetIds : [];
  const carryTargets = Boolean(options.carryTargets);
  const correctionState = options.correctionState || null;
  const terms = extractSearchTerms(text);
  const candidatesById = new Map();
  const record = (blockId, score, reason) => {
    if (!blockId || !score) return;
    const current = candidatesById.get(blockId) || { score: 0, reasons: [] };
    current.score += score;
    current.reasons.push(reason);
    candidatesById.set(blockId, current);
  };

  explicitTargets.forEach((blockId) => record(blockId, 120, 'explicit_target'));
  if (carryTargets) {
    recentTargetIds.forEach((blockId) => record(blockId, 34, 'carry_previous_target'));
  }

  const namedMatch = String(text).match(/(?:改|写到|放到|加到)?\s*([\u3400-\u9fffA-Za-z0-9]{2,12})(?:那一段|这一段|那一块|这一块)/);
  const namedKeyword = namedMatch
    ? String(namedMatch[1] || '').replace(/^把/, '').replace(/^一下/, '').replace(/^这个/, '').trim()
    : '';

  blocks.forEach((block, index) => {
    const content = `${getBlockHeadingPath(block)}\n${getBlockText(block)}`;
    const lower = content.toLowerCase();
    const termScore = scoreBlockByTerms(block, terms);
    if (termScore > 0) record(block.id, termScore * 4, 'keyword_match');
    if (namedKeyword && content.includes(namedKeyword)) record(block.id, 46, 'named_block_match');
    if (/引言|前言|导语/.test(text) && /引言|前言|导语/.test(content)) record(block.id, 28, 'synonym_intro_match');
    if (/结尾|总结|结论|收尾/.test(text) && /结尾|总结|结论|收尾/.test(content)) record(block.id, 28, 'synonym_outro_match');
    if (/文首|开头|最前面/.test(text) && index === 0) record(block.id, 38, 'document_start_phrase');
    if (/文末|结尾|最后|末尾/.test(text) && index === blocks.length - 1) record(block.id, 38, 'document_end_phrase');
    if (correctionState?.wrong_target && recentTargetIds.includes(block.id)) record(block.id, -18, 'recent_target_corrected');
    if (detectPromptInjectionSignals(lower).length > 0) record(block.id, 1, 'prompt_injection_signal');
  });

  const sorted = [...candidatesById.entries()]
    .map(([blockId, item]) => buildPlannerBlockPackage(article, blockId, item.score, item.reasons))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_TARGET_CANDIDATES);

  const top = sorted[0] || null;
  const second = sorted[1] || null;
  const resolvedIds = explicitTargets.length > 0
    ? explicitTargets
    : top && (!second || top.score >= second.score + 22 || top.score >= 60)
      ? [top.block_id]
      : [];

  return {
    target_candidates: sorted,
    candidate_block_ids: sorted.map((item) => item.block_id),
    resolved_ids: unique(resolvedIds),
    target_confidence: top
      ? clamp(0.42 + ((top.score - Number(second?.score || 0)) * 0.01) + (top.score >= 60 ? 0.14 : 0), 0.35, 0.96)
      : 0.28,
    ambiguous: explicitTargets.length === 0 && sorted.length > 1 && (!top || top.score < Number(second?.score || 0) + 22),
  };
}

function countParagraphs(text = '') {
  return String(text || '')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .length;
}

function looksLikeSuggestionText(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return /^(\d+\.\s|-\s|•\s)/m.test(normalized)
    || /建议|可以先|优先|最好|问题在于|可以改成|可以补一个例子/.test(normalized);
}

function looksLikeDraftText(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (looksLikeSuggestionText(normalized)) return false;
  return normalized.length >= 48 && countParagraphs(normalized) >= 1 && /[。！？；]/.test(normalized);
}

function classifySourceContentType(message = {}) {
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  const content = String(message?.content || '').trim();
  if (!content) return 'general_chat';
  if (['draft_text', 'edit_suggestion', 'analysis_feedback', 'general_chat'].includes(meta.source_content_type)) {
    return meta.source_content_type;
  }
  if (meta.canvas_mode === 'analysis') return 'analysis_feedback';
  if (meta.canvas_mode === 'edit') return 'general_chat';
  if (looksLikeSuggestionText(content)) return 'edit_suggestion';
  if (meta.last_focus_summary && content.includes(meta.last_focus_summary)) return 'edit_suggestion';
  if (looksLikeDraftText(content)) return 'draft_text';
  return 'general_chat';
}

function inferSourceNeed(userInput = '') {
  const text = String(userInput || '');
  if (/把上面的内容写到文档中|把以上内容写到文档中|把刚才生成的内容写进去|把上一条回复写进去|把上面的内容写进去|写到文档中/.test(text)) {
    return {
      needed: true,
      requested_type: 'draft_text',
      stable_phrase: true,
    };
  }
  return {
    needed: false,
    requested_type: '',
    stable_phrase: false,
  };
}

function buildSourceCandidates(conversationHistory = [], options = {}) {
  const requestedType = String(options.requestedType || '').trim();
  const items = Array.isArray(conversationHistory) ? conversationHistory : [];
  const candidates = [];

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role !== 'assistant' && item?.role !== 'user') continue;
    const content = String(item?.content || '').trim();
    if (!content) continue;
    const sourceContentType = item.role === 'assistant'
      ? classifySourceContentType(item)
      : 'general_chat';
    const candidate = {
      id: `${item.role === 'assistant' ? 'assistant_message' : 'user_message'}:${Number(item.id) || index + 1}`,
      message_id: Number(item.id) || null,
      source_kind: item.role === 'assistant' ? 'assistant_message' : 'user_message',
      source_content_type: sourceContentType,
      content,
      label: item.role === 'assistant'
        ? (candidates.length === 0 ? '上一条助手回复' : `更早的助手回复 ${candidates.length + 1}`)
        : '最近一条用户消息',
      description: trimTextToTokenBudget(content, 32, '…'),
      source_turn_index: index,
      eligibility_reason: sourceContentType === requestedType
        ? `matches_${requestedType}`
        : sourceContentType === 'general_chat'
          ? 'general_chat_only'
          : `type_${sourceContentType}`,
      prompt_injection_flags: detectPromptInjectionSignals(content),
    };
    candidates.push(candidate);
    if (candidates.length >= MAX_SOURCE_CANDIDATES) break;
  }

  return candidates;
}

function buildSourceAnswer(candidate = null) {
  if (!candidate) return null;
  return {
    question_id: 'source_content_ref',
    slot: 'source_content_ref',
    value: candidate.id,
    label: candidate.label,
    source_message_id: candidate.message_id,
    source_kind: candidate.source_kind,
    source_content_snapshot: candidate.content,
    source_content_digest: sha256(String(candidate.content || '')),
    source_content_type: candidate.source_content_type || 'general_chat',
  };
}

function extractSourceReference(userInput = '', conversationHistory = [], options = {}) {
  const sourceNeed = inferSourceNeed(userInput);
  if (!sourceNeed.needed) {
    return {
      needed: false,
      stable: false,
      requested_type: '',
      answer: null,
      source_reference: null,
      candidates: [],
      source_content_type: '',
    };
  }

  const correctionState = options.correctionState || null;
  const candidates = buildSourceCandidates(conversationHistory, {
    requestedType: sourceNeed.requested_type,
  }).filter((candidate) => {
    if (correctionState?.wrong_source && candidate.eligibility_reason === 'general_chat_only') return false;
    return true;
  });

  const eligible = candidates.filter((candidate) => candidate.source_content_type === sourceNeed.requested_type);
  const chosen = eligible[0] || null;
  return {
    needed: true,
    stable: Boolean(chosen),
    requested_type: sourceNeed.requested_type,
    answer: chosen ? buildSourceAnswer(chosen) : null,
    source_reference: chosen
      ? {
        source_message_id: chosen.message_id,
        source_kind: chosen.source_kind,
        source_content_snapshot: chosen.content,
        source_content_digest: sha256(String(chosen.content || '')),
        source_content_type: chosen.source_content_type,
      }
      : null,
    candidates,
    source_content_type: chosen?.source_content_type || sourceNeed.requested_type,
  };
}

function buildBlockLocationAnswer(article, blockId, extra = {}) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  const index = blocks.findIndex((item) => item.id === blockId);
  if (index < 0) return null;
  return {
    question_id: 'target_location',
    slot: 'target_location',
    value: `block:${blockId}`,
    label: `第 ${index + 1} 段`,
    block_id: blockId,
    position_relation: extra.position_relation || '',
    relation_hint: extra.position_relation || '',
  };
}

function inferTargetPositionRelation(text = '') {
  const normalized = String(text || '');
  if (/替换|覆盖|写成这段|改成这段/.test(normalized)) return 'replace_anchor';
  if (/前面|前边|之前|前一段/.test(normalized)) return 'before_anchor';
  if (/文首|开头|最前面/.test(normalized)) return 'document_start';
  if (/文末|结尾|最后|末尾/.test(normalized)) return 'document_end';
  if (/后面|后边|之后|后一段/.test(normalized)) return 'after_anchor';
  return '';
}

function buildWriteModeAnswer(value, extra = {}) {
  if (!value) return null;
  const map = {
    append_new_blocks: '追加新段落',
    insert_before_target: '写到目标前面',
    replace_target: '替换目标段落',
  };
  return {
    question_id: 'write_mode',
    slot: 'write_mode',
    value,
    label: map[value] || value,
    write_action: extra.write_action || mapWriteModeToWriteAction(value),
    position_relation: extra.position_relation || mapWriteModeToPositionRelation(value),
  };
}

function mapWriteModeToWriteAction(writeMode = '') {
  if (!writeMode) return '';
  if (writeMode === 'replace_target') return 'rewrite_existing';
  if (writeMode === 'delete_target') return 'delete_existing';
  return 'insert_new_blocks';
}

function mapWriteModeToPositionRelation(writeMode = '') {
  if (!writeMode) return '';
  if (writeMode === 'replace_target') return 'replace_anchor';
  if (writeMode === 'insert_before_target') return 'before_anchor';
  return 'after_anchor';
}

function deriveLegacyWriteMode(targetLocation = null, writeModeValue = '') {
  const normalized = String(writeModeValue || '').trim();
  const hintedRelation = String(targetLocation?.position_relation || targetLocation?.relation_hint || '').trim();
  if (normalized === 'replace_target' || hintedRelation === 'replace_anchor') return 'replace_target';
  if (normalized === 'insert_before_target' || hintedRelation === 'before_anchor' || hintedRelation === 'document_start') return 'insert_before_target';
  if (normalized === 'append_new_blocks') return 'append_new_blocks';
  if (hintedRelation === 'after_anchor' || hintedRelation === 'document_end') return 'append_new_blocks';
  return '';
}

function inferWriteMode(userInput = '', options = {}) {
  const text = String(userInput || '');
  const hintedRelation = String(options.positionRelation || '').trim();
  if (/替换|覆盖|写成这段|改成这段/.test(text)) {
    return buildWriteModeAnswer('replace_target', {
      write_action: 'rewrite_existing',
      position_relation: 'replace_anchor',
    });
  }
  if (/前面|前边|之前/.test(text) || hintedRelation === 'before_anchor' || hintedRelation === 'document_start') {
    return buildWriteModeAnswer('insert_before_target', {
      write_action: 'insert_new_blocks',
      position_relation: hintedRelation === 'document_start' ? 'document_start' : 'before_anchor',
    });
  }
  if (/新段落|追加|后面|后边|之后|写进去|加进去|放进去|补进去|文末|结尾/.test(text) || hintedRelation === 'after_anchor' || hintedRelation === 'document_end') {
    return buildWriteModeAnswer('append_new_blocks', {
      write_action: 'insert_new_blocks',
      position_relation: hintedRelation || 'after_anchor',
    });
  }
  return null;
}

function inferTargetLocation(article, userInput = '', targetBlockIds = []) {
  const text = String(userInput || '');
  const relation = inferTargetPositionRelation(text);
  if (/文首|开头|最前面/.test(text)) {
    return {
      question_id: 'target_location',
      slot: 'target_location',
      value: 'document_start',
      label: '文首',
      position_relation: 'document_start',
      relation_hint: 'document_start',
    };
  }
  if (/文末|结尾|最后|末尾/.test(text)) {
    return {
      question_id: 'target_location',
      slot: 'target_location',
      value: 'document_end',
      label: '文末',
      position_relation: 'document_end',
      relation_hint: 'document_end',
    };
  }
  if (Array.isArray(targetBlockIds) && targetBlockIds.length === 1) {
    return buildBlockLocationAnswer(article, targetBlockIds[0], {
      position_relation: relation || 'after_anchor',
    });
  }
  return null;
}

function detectConflictingEditActions(userInput = '') {
  const text = String(userInput || '');
  const hits = [];
  if (/删掉|删除|去掉/.test(text)) hits.push('delete');
  if (/写到文档|写入文档|写进去|插入|新增|加一段|补一段/.test(text)) hits.push('insert');
  if (/改写|重写|润色|继续改|重排|调整/.test(text)) hits.push('rewrite');
  return unique(hits).length > 1 && /同时|一边|并且|又/.test(text);
}

function inferRiskLevel(plan = {}) {
  if (plan.primary_intent !== 'edit') return 'low';
  if (plan.operation_kind === 'delete') return 'high';
  if (plan.write_action === 'rewrite_existing' && plan.position_relation === 'replace_anchor') return 'high';
  if (plan.scope_mode === 'global' || plan.scope_mode === 'multiple') return 'high';
  if ((plan.target_block_ids || []).length > 1) return 'high';
  if (plan.operation_kind === 'insert' || plan.operation_kind === 'rewrite' || plan.operation_kind === 'polish' || plan.operation_kind === 'shrink' || plan.operation_kind === 'expand') {
    return 'medium';
  }
  return 'low';
}

function buildDecisionSummary(plan = {}) {
  const primaryIntent = normalizePrimaryIntent(plan.primary_intent || plan.intent);
  if (primaryIntent === 'text') {
    return '已按继续讨论理解，不会直接改文档。';
  }
  if (primaryIntent === 'analyze') {
    return '已按文章分析理解，不会直接改文档。';
  }

  const sourceLabel = plan.answer_slots?.source_content_ref?.label || plan.prefilled_answers?.source_content_ref?.label || '';
  const targetLabel = plan.answer_slots?.target_location?.label || plan.prefilled_answers?.target_location?.label || '';
  const writeMode = plan.answer_slots?.write_mode?.value || plan.write_mode || '';
  const location = targetLabel
    ? `${targetLabel}${
      writeMode === 'insert_before_target'
        ? '前'
        : writeMode === 'replace_target'
          ? ''
          : writeMode === 'append_new_blocks'
            ? '后'
            : ''
    }`
    : '';
  const writeLabel = writeMode === 'replace_target'
    ? '替换目标段落'
    : writeMode === 'insert_before_target'
      ? '写到目标前面'
      : writeMode
        ? '追加新段落'
        : '';

  const parts = [];
  if (sourceLabel) parts.push(sourceLabel);
  if (location) parts.push(location);
  if (writeLabel) parts.push(writeLabel);
  if (parts.length > 0) {
    return `已按${parts.join(' + ')}理解。`;
  }

  const targetIds = Array.isArray(plan.target_block_ids) ? plan.target_block_ids : [];
  if (targetIds.length === 1) return '已按单段编辑理解。';
  if (targetIds.length > 1) return '已按多段联合编辑理解。';
  return '已按当前文档编辑理解。';
}

function buildClarifyQuestion(reasonCode, missingSlots = []) {
  if (reasonCode === 'ambiguous_primary_intent') {
    return '我还不能稳定判断你这轮是想继续讨论，还是直接改文档，请先确认这次的主意图。';
  }
  if (reasonCode === 'ambiguous_content_reference') {
    return '我还不能稳定判断你说的“上面的内容”具体指哪一段，请先确认内容来源。';
  }
  if (reasonCode === 'ambiguous_target_block') {
    return '我已经理解你想继续编辑，但目标位置还不够确定，请补充要写到哪一段。';
  }
  if (reasonCode === 'ambiguous_position_relation') {
    return '我已经定位到目标段落，但还不能确定你是要写到前面、后面，还是直接替换。';
  }
  if (reasonCode === 'unsafe_high_risk_edit') {
    return '这次修改风险较高，我需要你再确认一下位置或写入方式，再继续生成预览。';
  }
  if (reasonCode === 'ai_arbitration_unavailable') {
    return '这次请求当前还不能稳定自动判断，我先保守一点，请你补充关键位置或操作方式。';
  }
  if (reasonCode === 'conflicting_edit_actions') {
    return '你的要求里同时出现了不同修改动作，我需要先确认这次到底是写入、替换，还是删除。';
  }
  if (missingSlots.includes('write_mode')) {
    return '我已经理解你要把现有内容写进文档，但还缺少写入方式。';
  }
  return '我已经理解你想继续编辑文档，但还缺少具体写入位置。';
}

function buildPlannerTargetPackages(targetCandidates = []) {
  return (Array.isArray(targetCandidates) ? targetCandidates : []).slice(0, MAX_TARGET_CANDIDATES).map((item) => ({
    ref: item.ref,
    block_id: item.block_id,
    index: item.index,
    type: item.type,
    heading_path: item.heading_path,
    preview: item.preview,
    previous_preview: item.previous_preview,
    next_preview: item.next_preview,
    score: item.score,
    reasons: item.reasons,
  }));
}

function buildPlannerSourcePackages(sourceCandidates = []) {
  return (Array.isArray(sourceCandidates) ? sourceCandidates : []).slice(0, MAX_SOURCE_CANDIDATES).map((item) => ({
    id: item.id,
    source_kind: item.source_kind,
    source_content_type: item.source_content_type,
    label: item.label,
    description: item.description,
    content: trimTextToTokenBudget(item.content || '', 96, ' …'),
    eligibility_reason: item.eligibility_reason,
    prompt_injection_flags: item.prompt_injection_flags || [],
  }));
}

function normalizeHelperResult(parsed = {}, article, mode) {
  const normalizedTargetIds = normalizeTargetRefs(parsed.target_refs || parsed.targetRefs || [], article);
  const primaryIntent = normalizePrimaryIntent(parsed.primary_intent || parsed.intent);
  return {
    primary_intent: primaryIntent,
    intent: primaryIntent,
    confidence: clamp(Number(parsed.confidence || 0.65) || 0.65, 0.3, 0.98),
    scope_mode: normalizeScopeMode(parsed.scope_mode),
    target_block_ids: normalizedTargetIds,
    candidate_block_ids: normalizedTargetIds,
    operation_kind: normalizeOperationKind(parsed.operation_kind),
    clarify_needed: Boolean(parsed.clarify_needed),
    clarify_reason: String(parsed.reason_code || parsed.clarify_reason || '').trim(),
    missing_slots: Array.isArray(parsed.missing_slots) ? parsed.missing_slots.filter(Boolean) : [],
    write_action: String(parsed.write_action || '').trim(),
    position_relation: String(parsed.position_relation || '').trim(),
    decision_summary: String(parsed.decision_summary || '').trim(),
    ai_arbitration_mode: mode,
  };
}

async function runHelperPlanner({
  mode,
  userInput,
  article,
  conversationHistory,
  llmConfig,
  intentCandidates = [],
  targetCandidates = [],
  sourceCandidates = [],
  correctionState = null,
  riskLevel = 'low',
  requestedSourceType = '',
  decisionPath = [],
  maxRetries = 1,
}) {
  const articleHash = buildArticleHash(article);
  const historyDigest = buildHistoryDigest(conversationHistory);
  const userInputDigest = sha256(String(userInput || ''));
  const cacheKey = getHelperCacheKey({
    articleHash,
    historyDigest,
    userInputDigest,
    mode,
  });
  const cached = getCachedHelperResult(cacheKey);
  if (cached) {
    return {
      ...cached,
      cache_hit: true,
      ai_arbitration_mode: `${mode}:cache_hit`,
      helper_used: true,
      usage: null,
      budget: null,
      compacted: false,
    };
  }

  const messages = buildCanvasQueryPlanPrompt(userInput, {
    mode,
    plannerVersion: PLANNER_VERSION,
    history: (Array.isArray(conversationHistory) ? conversationHistory : []).slice(-8),
    articleTitle: article?.title || '未命名文章',
    targetCandidates: buildPlannerTargetPackages(targetCandidates),
    sourceCandidates: buildPlannerSourcePackages(sourceCandidates),
    intentCandidates,
    correctionState,
    requestedSourceType,
    riskLevel,
    decisionPath,
  });

  try {
    const reply = await completeChat(messages, {
      responseFormat: { type: 'json_object' },
      taskType: mode === 'intent_arbiter' ? 'canvas_intent' : 'canvas_query_plan',
      temperature: 0.1,
      config: llmConfig || undefined,
      maxRetries,
    });
    const parsed = JSON.parse(reply.message?.content || '{}');
    const normalized = normalizeHelperResult(parsed, article, mode);
    const result = {
      ...normalized,
      helper_used: true,
      cache_hit: false,
      usage: reply.usage || null,
      budget: reply.budget || null,
      compacted: Boolean(reply.compacted),
    };
    setCachedHelperResult(cacheKey, {
      ...normalized,
      helper_used: true,
    });
    return result;
  } catch {
    return null;
  }
}

async function runRiskValidator(input = {}) {
  const result = await runHelperPlanner({
    ...input,
    mode: 'risk_validator',
    maxRetries: 0,
  });
  if (!result) return null;
  return {
    proceed: result.clarify_needed === false && result.confidence >= 0.72,
    confidence: result.confidence,
    clarify_reason: result.clarify_reason || (result.clarify_needed ? 'unsafe_high_risk_edit' : ''),
    missing_slots: result.missing_slots || [],
    ai_arbitration_mode: result.ai_arbitration_mode,
    usage: result.usage || null,
    budget: result.budget || null,
    compacted: Boolean(result.compacted),
  };
}

function buildPrimaryIntentAnswer(value) {
  const map = {
    edit: '直接改当前文档',
    draft_text: '先生成可写入内容',
    text: '继续讨论',
    analyze: '先做文章分析',
  };
  return {
    question_id: 'primary_intent',
    slot: 'primary_intent',
    value,
    label: map[value] || value,
  };
}

function buildFinalPlan(base = {}) {
  const answerSlots = base.answer_slots || {};
  const targetLocation = answerSlots.target_location || base.target_location || null;
  const writeModeAnswer = answerSlots.write_mode || null;
  const primaryIntent = normalizePrimaryIntent(base.primary_intent || base.intent);
  const legacyWriteMode = deriveLegacyWriteMode(targetLocation, base.write_mode || writeModeAnswer?.value || '');
  const writeAction = String(base.write_action || writeModeAnswer?.write_action || mapWriteModeToWriteAction(legacyWriteMode));
  const positionRelation = String(
    base.position_relation
      || writeModeAnswer?.position_relation
      || targetLocation?.position_relation
      || mapWriteModeToPositionRelation(legacyWriteMode)
  );
  const next = {
    ...base,
    intent: primaryIntent,
    primary_intent: primaryIntent,
    write_mode: legacyWriteMode,
    write_action: writeAction,
    position_relation: positionRelation,
    target_anchor: targetLocation
      ? {
        value: targetLocation.value,
        label: targetLocation.label,
        block_id: targetLocation.block_id || null,
      }
      : null,
    source_content_type: String(
      base.source_content_type
        || answerSlots.source_content_ref?.source_content_type
        || base.source_reference?.source_content_type
        || ''
    ),
  };
  next.risk_level = normalizeRiskLevel(base.risk_level || inferRiskLevel(next));
  next.decision_summary = String(base.decision_summary || buildDecisionSummary(next)).trim();
  next.action_candidates = Array.isArray(base.action_candidates) ? base.action_candidates : inferOperationCandidates(base.original_user_input || '');
  return next;
}

async function resolveCanvasRequest({
  userInput,
  article,
  conversationHistory = [],
  styleMode = 'auto',
  referenceMode = 'auto',
  factFileIds = [],
  llmConfig = null,
} = {}) {
  const articleHash = buildArticleHash(article);
  const decisionPath = [`planner:${PLANNER_VERSION}`];
  const correctionState = detectCorrectionState(userInput) || extractRecentCorrectionState(conversationHistory, articleHash);
  if (correctionState) decisionPath.push('correction_state:applied');

  const structuredClarifyCount = (Array.isArray(conversationHistory) ? conversationHistory : []).reduce((count, item) => {
    if (item?.role !== 'assistant') return count;
    const meta = item?.meta && typeof item.meta === 'object' ? item.meta : null;
    return meta?.interaction_kind === 'clarify_card' ? count + 1 : count;
  }, 0);

  const recentContext = extractRecentCanvasContext(conversationHistory);
  const followUpSummary = needsCarryPreviousSummary(userInput)
    ? String(recentContext?.last_focus_summary || '').trim()
    : '';
  const carryTargets = !correctionState?.wrong_target && (needsCarryPreviousTarget(userInput) || Boolean(followUpSummary));
  const explicitTargets = parseExplicitMentionIds(article, userInput);
  const recentTargetIds = carryTargets ? (recentContext?.target_block_ids || []) : [];

  const sourceRef = extractSourceReference(userInput, conversationHistory, {
    correctionState,
  });
  if (sourceRef.needed) decisionPath.push(`source_need:${sourceRef.requested_type}`);

  const intentCandidates = inferIntentCandidates(userInput, {
    explicitTargets,
    globalPhrase: isGlobalPhrase(userInput),
    requestedSourceType: sourceRef.requested_type,
    correctionState,
  });
  const { primary_intent: inferredIntent, confidence: inferredIntentConfidence, ambiguous: ambiguousIntent } = resolvePrimaryIntent(intentCandidates);
  let primaryIntent = inferredIntent;
  let intentConfidence = inferredIntentConfidence;
  decisionPath.push(`intent:${primaryIntent}`);

  const inferredOperationKind = inferOperationKind(userInput);
  const operationKind = shouldCarryPreviousOperation(userInput, inferredOperationKind)
    ? normalizeOperationKind(recentContext?.operation_kind || inferredOperationKind)
    : inferredOperationKind;

  const targetInfo = buildTargetCandidates(article, userInput, {
    explicitTargets,
    recentTargetIds,
    carryTargets,
    correctionState,
  });
  let targetBlockIds = unique([
    ...explicitTargets,
    ...recentTargetIds,
    ...targetInfo.resolved_ids,
  ]);
  let candidateBlockIds = unique(targetInfo.candidate_block_ids);
  let targetCandidates = targetInfo.target_candidates || [];
  let targetConfidence = targetInfo.target_confidence || 0.28;

  const scopeFromPhrase = isGlobalPhrase(userInput) ? 'global' : 'none';
  let scopeMode = scopeFromPhrase;
  if (scopeMode !== 'global') {
    if (targetBlockIds.length === 1) scopeMode = 'single';
    else if (targetBlockIds.length > 1) scopeMode = 'multiple';
    else scopeMode = 'none';
  }

  const answerSlots = {};
  if (sourceRef.answer) answerSlots.source_content_ref = sourceRef.answer;

  const inferredTargetLocation = inferTargetLocation(article, userInput, targetBlockIds);
  if (inferredTargetLocation) answerSlots.target_location = inferredTargetLocation;
  if (!answerSlots.target_location && sourceRef.needed && recentContext?.target_block_ids?.length === 1 && !correctionState?.wrong_target) {
    const previousTargetLocation = buildBlockLocationAnswer(article, recentContext.target_block_ids[0], {
      position_relation: 'after_anchor',
    });
    if (previousTargetLocation) {
      answerSlots.target_location = previousTargetLocation;
      targetBlockIds = unique([...targetBlockIds, recentContext.target_block_ids[0]]);
      candidateBlockIds = unique([...candidateBlockIds, recentContext.target_block_ids[0]]);
      if (scopeMode === 'none') scopeMode = 'single';
      decisionPath.push('target:carried_previous');
    }
  }

  const inferredWriteMode = inferWriteMode(userInput, {
    positionRelation: answerSlots.target_location?.position_relation || '',
  });
  if (inferredWriteMode) answerSlots.write_mode = inferredWriteMode;

  const basePlan = buildFinalPlan({
    original_user_input: String(userInput || '').trim(),
    intent: primaryIntent,
    primary_intent: primaryIntent,
    intent_confidence: intentConfidence,
    intent_candidates: intentCandidates,
    target_candidates: targetCandidates,
    target_confidence: targetConfidence,
    target_block_ids: targetBlockIds,
    candidate_block_ids: candidateBlockIds,
    operation_kind: operationKind,
    action_candidates: inferOperationCandidates(userInput),
    needs_style: inferNeedsStyle(primaryIntent, operationKind, { styleMode }),
    needs_knowledge: inferNeedsKnowledge(userInput, { referenceMode, factFileIds }),
    source_reference: sourceRef.source_reference,
    source_candidates: sourceRef.candidates,
    source_content_type: sourceRef.source_content_type,
    source_confidence: sourceRef.stable ? 0.92 : (sourceRef.needed ? 0.36 : 0),
    scope_mode: scopeMode,
    answer_slots: answerSlots,
    prefilled_answers: answerSlots,
    summary_instruction: followUpSummary,
    correction_state: correctionState || null,
    decision_path: decisionPath,
    ai_arbitration_mode: 'none',
    prompt_injection_flags: unique((targetCandidates || []).flatMap((item) => item.reasons.includes('prompt_injection_signal') ? ['target_candidate'] : []).concat(
      (sourceRef.candidates || []).flatMap((item) => item.prompt_injection_flags || [])
    )),
  });

  if (primaryIntent === 'analyze' && !correctionState?.preferred_primary_intent) {
    return buildFinalPlan({
      ...basePlan,
      clarify_needed: false,
      clarify_question: '',
      helper_used: false,
      missing_slots: [],
    });
  }

  if (primaryIntent === 'text' && !correctionState?.preferred_primary_intent) {
    return buildFinalPlan({
      ...basePlan,
      operation_kind: 'discuss',
      clarify_needed: false,
      clarify_question: '',
      helper_used: false,
      missing_slots: [],
    });
  }

  let clarifyReason = '';
  let missingSlots = [];
  let helper = null;
  let riskValidator = null;

  if (correctionState?.wrong_source) {
    clarifyReason = 'ambiguous_content_reference';
    missingSlots = ['source_content_ref'];
  } else if (correctionState?.wrong_target) {
    clarifyReason = 'ambiguous_target_block';
    missingSlots = ['target_location'];
  } else if (correctionState?.wrong_write_action) {
    clarifyReason = 'ambiguous_position_relation';
    missingSlots = ['write_mode'];
  } else if (detectConflictingEditActions(userInput)) {
    clarifyReason = 'conflicting_edit_actions';
  } else if (ambiguousIntent && primaryIntent !== 'analyze' && !sourceRef.needed) {
    clarifyReason = 'ambiguous_primary_intent';
    missingSlots = ['primary_intent'];
  } else if (sourceRef.needed) {
    if (!sourceRef.stable && !answerSlots.source_content_ref) {
      clarifyReason = 'ambiguous_content_reference';
      missingSlots = ['source_content_ref'];
    } else {
      if (!answerSlots.target_location) {
        clarifyReason = targetInfo.ambiguous || candidateBlockIds.length > 1
          ? 'ambiguous_target_block'
          : 'missing_target_location';
        missingSlots.push('target_location');
      }
      if (!answerSlots.write_mode) {
        if (!clarifyReason) clarifyReason = 'missing_write_mode';
        missingSlots.push('write_mode');
      }
    }
  } else if (primaryIntent === 'edit' && scopeMode === 'none' && !['discuss', 'analyze'].includes(operationKind)) {
    clarifyReason = targetInfo.ambiguous || candidateBlockIds.length > 1
      ? 'ambiguous_target_block'
      : 'missing_target_location';
    missingSlots = ['target_location'];
  }

  const planWithRisk = buildFinalPlan({
    ...basePlan,
    clarify_reason: clarifyReason,
    missing_slots: missingSlots,
  });
  const riskLevel = planWithRisk.risk_level;

  let helperMode = '';
  if (clarifyReason === 'ambiguous_primary_intent' || (primaryIntent === 'edit' && intentConfidence < 0.66)) {
    helperMode = 'intent_arbiter';
  } else if (
    ['ambiguous_content_reference', 'ambiguous_target_block', 'missing_target_location', 'ambiguous_position_relation'].includes(clarifyReason)
    || (
      riskLevel === 'high'
      && primaryIntent === 'edit'
      && scopeMode !== 'global'
      && targetCandidates.length > 0
      && targetConfidence < 0.82
    )
  ) {
    helperMode = 'target_resolver';
  }

  if (helperMode) {
    helper = await runHelperPlanner({
      mode: helperMode,
      userInput,
      article,
      conversationHistory,
      llmConfig,
      intentCandidates,
      targetCandidates,
      sourceCandidates: sourceRef.candidates,
      correctionState,
      riskLevel,
      requestedSourceType: sourceRef.requested_type,
      decisionPath,
      maxRetries: 1,
    });
  }

  if (helper) {
    decisionPath.push(`helper:${helper.ai_arbitration_mode || helperMode}`);
    if (helper.primary_intent) {
      primaryIntent = normalizePrimaryIntent(helper.primary_intent);
      intentConfidence = clamp(Number(helper.confidence || intentConfidence), 0.35, 0.98);
    }
    if (helper.target_block_ids.length > 0) {
      targetBlockIds = helper.target_block_ids;
      candidateBlockIds = unique([...candidateBlockIds, ...helper.candidate_block_ids, ...helper.target_block_ids]);
      targetCandidates = unique([...helper.target_block_ids, ...candidateBlockIds]).map((blockId) => {
        return targetCandidates.find((item) => item.block_id === blockId) || buildPlannerBlockPackage(article, blockId, 0, []);
      }).filter(Boolean);
      targetConfidence = clamp(Math.max(targetConfidence, helper.confidence || targetConfidence), 0.35, 0.98);
      if (!answerSlots.target_location && helper.target_block_ids.length === 1) {
        answerSlots.target_location = buildBlockLocationAnswer(article, helper.target_block_ids[0], {
          position_relation: helper.position_relation || inferTargetPositionRelation(userInput) || 'after_anchor',
        });
      }
      if (scopeMode === 'none' && helper.target_block_ids.length === 1) scopeMode = 'single';
    }
    if (!clarifyReason && helper.clarify_reason) clarifyReason = helper.clarify_reason;
    if (missingSlots.length === 0 && Array.isArray(helper.missing_slots) && helper.missing_slots.length > 0) {
      missingSlots = helper.missing_slots;
    }
  } else if (helperMode && riskLevel === 'high') {
    clarifyReason = 'ai_arbitration_unavailable';
    missingSlots = unique(missingSlots.length > 0 ? missingSlots : ['target_location']);
    decisionPath.push('helper:unavailable');
  }

  const nextPlan = buildFinalPlan({
    ...basePlan,
    intent: primaryIntent,
    primary_intent: primaryIntent,
    intent_confidence: intentConfidence,
    scope_mode: scopeMode,
    target_block_ids: targetBlockIds,
    candidate_block_ids: candidateBlockIds,
    target_candidates: targetCandidates,
    target_confidence: targetConfidence,
    answer_slots: answerSlots,
    prefilled_answers: answerSlots,
    clarify_reason: clarifyReason,
    missing_slots: missingSlots,
    ai_arbitration_mode: helper?.ai_arbitration_mode || helperMode || 'none',
    helper_used: Boolean(helper),
    helper_usage: helper?.usage || null,
    helper_budget: helper?.budget || null,
    helper_compacted: Boolean(helper?.compacted),
    decision_path: decisionPath,
  });

  if (nextPlan.primary_intent === 'text') {
    return buildFinalPlan({
      ...nextPlan,
      intent: 'text',
      operation_kind: 'discuss',
      clarify_needed: false,
      clarify_question: '',
      missing_slots: [],
      risk_level: 'low',
    });
  }

  if (nextPlan.primary_intent === 'analyze') {
    return buildFinalPlan({
      ...nextPlan,
      intent: 'analyze',
      operation_kind: 'analyze',
      clarify_needed: false,
      clarify_question: '',
      missing_slots: [],
      risk_level: 'low',
    });
  }

  if (!nextPlan.clarify_reason && nextPlan.risk_level === 'high' && nextPlan.helper_used && !nextPlan.helper_compacted) {
    riskValidator = await runRiskValidator({
      userInput,
      article,
      conversationHistory,
      llmConfig,
      intentCandidates,
      targetCandidates,
      sourceCandidates: sourceRef.candidates,
      correctionState,
      riskLevel: nextPlan.risk_level,
      requestedSourceType: sourceRef.requested_type,
      decisionPath: [...decisionPath, 'risk_validator:requested'],
    });
    if (riskValidator) {
      decisionPath.push(`risk_validator:${riskValidator.ai_arbitration_mode || 'ok'}`);
      if (!riskValidator.proceed) {
        clarifyReason = riskValidator.clarify_reason || 'unsafe_high_risk_edit';
        missingSlots = unique(riskValidator.missing_slots && riskValidator.missing_slots.length > 0
          ? riskValidator.missing_slots
          : ['target_location']);
      }
    } else {
      clarifyReason = 'ai_arbitration_unavailable';
      missingSlots = unique(missingSlots.length > 0 ? missingSlots : ['target_location']);
      decisionPath.push('risk_validator:unavailable');
    }
  }

  const finalPlan = buildFinalPlan({
    ...nextPlan,
    clarify_reason: clarifyReason,
    missing_slots: missingSlots,
    helper_usage: helper?.usage || riskValidator?.usage || null,
    helper_budget: helper?.budget || riskValidator?.budget || null,
    helper_compacted: Boolean(helper?.compacted || riskValidator?.compacted),
    ai_arbitration_mode: riskValidator?.ai_arbitration_mode
      ? `${nextPlan.ai_arbitration_mode}+${riskValidator.ai_arbitration_mode}`
      : nextPlan.ai_arbitration_mode,
    decision_path: decisionPath,
  });

  if (
    finalPlan.risk_level === 'high'
    && finalPlan.scope_mode !== 'global'
    && (finalPlan.helper_compacted || finalPlan.intent_confidence < 0.68 || finalPlan.target_confidence < 0.62)
    && !clarifyReason
  ) {
    clarifyReason = 'unsafe_high_risk_edit';
    missingSlots = unique(missingSlots.length > 0 ? missingSlots : ['target_location']);
  }

  if (clarifyReason || missingSlots.length > 0) {
    const normalizedMissingSlots = unique(missingSlots.length > 0 ? missingSlots : (
      clarifyReason === 'ambiguous_primary_intent'
        ? ['primary_intent']
        : clarifyReason === 'ambiguous_content_reference'
          ? ['source_content_ref']
          : clarifyReason === 'missing_write_mode' || clarifyReason === 'ambiguous_position_relation'
            ? ['write_mode']
            : ['target_location']
    ));
    return buildFinalPlan({
      ...finalPlan,
      clarify_needed: true,
      clarify_reason: clarifyReason || 'missing_target_location',
      clarify_question: buildClarifyQuestion(clarifyReason || 'missing_target_location', normalizedMissingSlots),
      clarify_render_mode: structuredClarifyCount >= 2 ? 'text' : 'card',
      missing_slots: normalizedMissingSlots,
      prefilled_answers: answerSlots,
      answer_slots: answerSlots,
      decision_summary: finalPlan.decision_summary,
    });
  }

  return buildFinalPlan({
    ...finalPlan,
    clarify_needed: false,
    clarify_question: '',
    missing_slots: [],
    prefilled_answers: answerSlots,
    answer_slots: answerSlots,
  });
}

module.exports = {
  resolveCanvasRequest,
};
