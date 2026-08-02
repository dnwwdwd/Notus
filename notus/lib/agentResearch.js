const crypto = require('crypto');
const { getDb } = require('./db');
const { completeChat } = require('./llm');
const { recordRunUsage } = require('./agentControlPlane');
const { listOperationSetsBySession } = require('./canvasOperationSets');

const RESEARCH_LIMIT = 5;
const AGENT_TASK_RECEIPTS_ENABLED = false;

function isAgentTaskReceiptsEnabled() {
  return AGENT_TASK_RECEIPTS_ENABLED;
}
const INITIAL_QUERY_COUNT = 3;
const FALLBACK_QUERY_COUNT = 2;
const KNOWLEDGE_EVIDENCE_SCORE = 0.018;

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function textHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((key) => url.searchParams.delete(key));
    return url.toString();
  } catch {
    return raw;
  }
}

function normalizePath(value = '') {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function uniqueStrings(values = [], limit = RESEARCH_LIMIT) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function extractKeywords(value = '') {
  const text = String(value || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[“”"'`~!@#$%^&*()_+=\[\]{}|\\:;,.，。！？?、<>]/g, ' ')
    .replace(/(?:请|帮我|一下|一下子|关于|怎么|如何|能否|可以|想要|需要|介绍|查询|搜索|查找|资料|信息)/g, ' ');
  const matches = text.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z][a-zA-Z0-9_-]{1,}/g) || [];
  return uniqueStrings(matches, 8);
}

function ruleBasedQueries(query = '') {
  const original = String(query || '').replace(/\s+/g, ' ').trim();
  const keywords = extractKeywords(original);
  const subject = keywords.slice(0, 4).join(' ') || original;
  const candidates = [
    original,
    `${subject} 功能 实现 使用说明`,
    `${subject} 配置 集成 文档`,
    `${subject} 项目 架构 README`,
    `${subject} 常见问题 示例`,
  ];
  const result = uniqueStrings(candidates, RESEARCH_LIMIT);
  let index = 1;
  while (result.length < RESEARCH_LIMIT) {
    const fallback = `${original || '用户任务'} 相关资料 ${index}`;
    if (!result.some((item) => item.toLocaleLowerCase() === fallback.toLocaleLowerCase())) result.push(fallback);
    index += 1;
  }
  return {
    initial_queries: result.slice(0, INITIAL_QUERY_COUNT),
    fallback_queries: result.slice(INITIAL_QUERY_COUNT, INITIAL_QUERY_COUNT + FALLBACK_QUERY_COUNT),
    planner: 'rule_fallback',
    planner_failed: false,
  };
}

function normalizeQueryPlan(raw, originalQuery, fallback) {
  const original = String(originalQuery || '').replace(/\s+/g, ' ').trim();
  const values = uniqueStrings([
    original,
    ...(Array.isArray(raw?.initial_queries) ? raw.initial_queries : []),
    ...(Array.isArray(raw?.fallback_queries) ? raw.fallback_queries : []),
    ...fallback.initial_queries,
    ...fallback.fallback_queries,
  ], RESEARCH_LIMIT);
  let index = 1;
  while (values.length < RESEARCH_LIMIT) {
    const value = `${original || '用户任务'} 相关资料 ${index}`;
    if (!values.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) values.push(value);
    index += 1;
  }
  return {
    initial_queries: values.slice(0, INITIAL_QUERY_COUNT),
    fallback_queries: values.slice(INITIAL_QUERY_COUNT, INITIAL_QUERY_COUNT + FALLBACK_QUERY_COUNT),
  };
}

async function buildAgentQueryPlan({ query, llmConfig = null, sessionId = null, runId = null } = {}) {
  const original = String(query || '').replace(/\s+/g, ' ').trim();
  const fallback = ruleBasedQueries(original);
  if (!original || !llmConfig?.llmApiKey || !llmConfig?.llmBaseUrl || !llmConfig?.llmModel) return fallback;

  const startedAt = Date.now();
  try {
    const reply = await completeChat([{
      role: 'user',
      content: [
        '你是检索查询规划器。把用户的原始任务改写为 5 个互不重复、可用于知识库和网页检索的短查询。',
        '必须返回 JSON：{"initial_queries":["...","...","..."],"fallback_queries":["...","..."]}。',
        'initial_queries 必须有 3 项，fallback_queries 必须有 2 项。不要解释，不要输出 Markdown。',
        `用户原始查询：${original}`,
      ].join('\n'),
    }], {
      responseFormat: { type: 'json_object' },
      taskType: 'agent_research_query_plan',
      temperature: 0.1,
      maxOutputTokens: 220,
      config: llmConfig,
    });
    const raw = safeJsonParse(reply?.message?.content, {});
    if (sessionId && reply?.usage) {
      recordRunUsage({
        sessionId,
        runId,
        sourceType: 'query_plan',
        provider: llmConfig?.llmProvider,
        model: llmConfig?.llmModel,
        usage: reply.usage,
        usageSource: 'provider',
      });
    }
    return {
      ...normalizeQueryPlan(raw, original, fallback),
      planner: 'llm',
      planner_failed: false,
      planner_duration_ms: Date.now() - startedAt,
    };
  } catch {
    return {
      ...fallback,
      planner_failed: true,
      planner_duration_ms: Date.now() - startedAt,
    };
  }
}

function getResearchState(sessionId) {
  const id = normalizePositiveInt(sessionId);
  const row = getDb().prepare('SELECT research_state_json FROM agent_sessions WHERE id = ?').get(id);
  const state = safeJsonParse(row?.research_state_json, {});
  return {
    version: 1,
    sources: {},
    ...(state && typeof state === 'object' ? state : {}),
    sources: state?.sources && typeof state.sources === 'object' ? state.sources : {},
  };
}

function saveResearchState(sessionId, state = {}) {
  const id = normalizePositiveInt(sessionId);
  getDb().prepare("UPDATE agent_sessions SET research_state_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify({ version: 1, sources: {}, ...state }), id);
}

function sanitizeErrorCode(error) {
  const code = String(error?.code || error?.error || '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  if (code) return code.slice(0, 96);
  if (error?.message) return 'RESEARCH_PROVIDER_FAILED';
  return '';
}

function summaryText(value = '', max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function insertResearchReceipt({
  sessionId,
  conversationId = null,
  sourceType,
  phase = '',
  query = '',
  sourceTitle = '',
  sourceRef = '',
  provider = '',
  status = 'success',
  resultCount = 0,
  durationMs = 0,
  contentHash = '',
  errorCode = '',
  summary = '',
  details = {},
} = {}) {
  const id = normalizePositiveInt(sessionId);
  if (!id || !sourceType) return null;
  const normalizedRef = /^https?:\/\//i.test(String(sourceRef || '')) ? normalizeUrl(sourceRef) : normalizePath(sourceRef);
  const result = getDb().prepare(`
    INSERT INTO agent_research_receipts (
      session_id, conversation_id, source_type, phase, query, source_title, source_ref,
      provider, status, result_count, duration_ms, content_hash, error_code, summary, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normalizePositiveInt(conversationId),
    String(sourceType),
    String(phase || ''),
    String(query || '').slice(0, 800),
    String(sourceTitle || '').slice(0, 500),
    normalizedRef.slice(0, 2000),
    String(provider || '').slice(0, 120),
    String(status || 'success').slice(0, 40),
    Math.max(0, Number(resultCount) || 0),
    Math.max(0, Number(durationMs) || 0),
    String(contentHash || '').slice(0, 128),
    String(errorCode || '').slice(0, 120),
    summaryText(summary, 400),
    JSON.stringify(details && typeof details === 'object' ? details : {})
  );
  return Number(result.lastInsertRowid);
}

function readResearchReceipts(sessionId, { limit = 100 } = {}) {
  const id = normalizePositiveInt(sessionId);
  if (!id) return [];
  return getDb().prepare(`
    SELECT * FROM agent_research_receipts
    WHERE session_id = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(id, Math.min(Math.max(Number(limit) || 100, 1), 300)).map((row) => ({
    id: Number(row.id),
    session_id: Number(row.session_id),
    conversation_id: normalizePositiveInt(row.conversation_id),
    source_type: row.source_type,
    phase: row.phase || '',
    query: row.query || '',
    source_title: row.source_title || '',
    source_ref: row.source_ref || '',
    provider: row.provider || '',
    status: row.status || '',
    result_count: Number(row.result_count || 0),
    duration_ms: Number(row.duration_ms || 0),
    content_hash: row.content_hash || '',
    error_code: row.error_code || '',
    summary: row.summary || '',
    details: safeJsonParse(row.details_json, {}),
    created_at: row.created_at || '',
  }));
}

function sanitizeResearchReceipts(sessionId, options = {}) {
  return readResearchReceipts(sessionId, options).map((receipt) => ({
    id: receipt.id,
    source_type: receipt.source_type,
    phase: receipt.phase,
    query: receipt.query,
    title: receipt.source_title,
    ref: receipt.source_ref,
    provider: receipt.provider,
    status: receipt.status,
    result_count: receipt.result_count,
    duration_ms: receipt.duration_ms,
    error_code: receipt.error_code,
    summary: receipt.summary,
    created_at: receipt.created_at,
  }));
}

function resultIdentity(result = {}, sourceType) {
  const ref = sourceType === 'web'
    ? normalizeUrl(result.url || result.source_ref || '')
    : normalizePath(result.file_path || result.path || result.source_ref || '');
  if (ref) return `${sourceType}:ref:${ref}`;
  return `${sourceType}:content:${textHash([result.title || result.file_title || '', result.content || '', result.snippet || ''].join('\n'))}`;
}

function mergeResults(entries = [], sourceType) {
  const seen = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const item = { ...entry };
    const key = resultIdentity(item, sourceType);
    const current = seen.get(key);
    if (current) {
      current.matched_queries = uniqueStrings([...(current.matched_queries || []), ...(item.matched_queries || [])], RESEARCH_LIMIT);
      continue;
    }
    item.matched_queries = uniqueStrings(item.matched_queries || [], RESEARCH_LIMIT);
    seen.set(key, item);
  }
  return [...seen.values()];
}

function wordsIn(value = '') {
  return uniqueStrings(extractKeywords(value).filter((item) => item.length >= 2), 8);
}

function knowledgeHasEvidence(item = {}, query = '') {
  const haystack = `${item.file_title || item.title || ''} ${item.file_path || item.path || ''}`.toLocaleLowerCase();
  const titleOrPathHit = wordsIn(query).some((word) => haystack.includes(word.toLocaleLowerCase()));
  return titleOrPathHit
    || /(?:^|[_-])fts(?:[_-]|$)/i.test(String(item.source || item.retrieval_source || ''))
    || Number(item.score || 0) >= KNOWLEDGE_EVIDENCE_SCORE;
}

function webHasEvidence(item = {}, query = '') {
  const expectedUrl = normalizeUrl(query);
  const actualUrl = normalizeUrl(item.url || item.source_ref || '');
  if (/^https?:\/\//i.test(expectedUrl) && expectedUrl === actualUrl) return true;
  const haystack = `${item.title || ''} ${item.content || ''} ${item.snippet || ''}`.toLocaleLowerCase();
  const words = wordsIn(query);
  const hitCount = words.filter((word) => haystack.includes(word.toLocaleLowerCase())).length;
  return hitCount >= Math.min(2, words.length) && words.length >= 2;
}

function makeQueryRecord({ query, phase, status, resultCount = 0, durationMs = 0, errorCode = '', cached = false } = {}) {
  return {
    query: String(query || ''),
    phase: phase === 'fallback' ? 'fallback' : 'initial',
    status: String(status || 'success'),
    result_count: Math.max(0, Number(resultCount) || 0),
    duration_ms: Math.max(0, Number(durationMs) || 0),
    error_code: String(errorCode || ''),
    cached: Boolean(cached),
  };
}

function buildBudget(records = [], state = {}) {
  const used = new Set((Array.isArray(records) ? records : []).map((record) => String(record.query || '').toLocaleLowerCase()).filter(Boolean)).size;
  return {
    limit: RESEARCH_LIMIT,
    used,
    remaining: Math.max(0, RESEARCH_LIMIT - used),
    phase: state?.fallback_executed ? 'fallback_complete' : state?.initial_executed ? 'initial_complete' : 'pending',
    cache_hit: Boolean(state?.completed),
  };
}

function projectResults(results = [], sourceType) {
  return (Array.isArray(results) ? results : []).map((item) => {
    if (sourceType === 'knowledge') {
      return {
        file_title: item.file_title || item.title || '',
        file_path: item.file_path || item.path || '',
        heading_path: item.heading_path || '',
        content: String(item.content || ''),
        score: Number(item.score || 0),
        line_start: item.line_start || null,
        line_end: item.line_end || null,
        source: item.source || '',
        matched_queries: item.matched_queries || [],
      };
    }
    return {
      title: item.title || '',
      url: item.url || '',
      content: String(item.content || ''),
      snippet: item.snippet || '',
      publishedAt: item.publishedAt || null,
      matched_queries: item.matched_queries || [],
    };
  });
}

function recordQueryAndResultReceipts({ session, sourceType, query, phase, result, provider = '' } = {}) {
  const items = Array.isArray(result?.results) ? result.results : [];
  const queryStatus = result?.error ? 'error' : items.length > 0 ? 'success' : 'empty';
  const errorCode = result?.error ? sanitizeErrorCode(result.error) : '';
  insertResearchReceipt({
    sessionId: session.id,
    conversationId: session.conversation_id,
    sourceType,
    phase,
    query,
    provider,
    status: queryStatus,
    resultCount: items.length,
    durationMs: result?.durationMs,
    errorCode,
    summary: result?.error ? (result.error.message || result.error.code || '检索服务不可用') : items.length > 0 ? `返回 ${items.length} 条结果` : '没有补充结果',
    details: { kind: 'query' },
  });
  items.forEach((item) => {
    const ref = sourceType === 'web' ? item.url : item.file_path || item.path;
    const title = sourceType === 'web' ? item.title : item.file_title || item.title;
    insertResearchReceipt({
      sessionId: session.id,
      conversationId: session.conversation_id,
      sourceType,
      phase,
      query,
      sourceTitle: title,
      sourceRef: ref,
      provider,
      status: 'success',
      resultCount: 1,
      durationMs: result?.durationMs,
      contentHash: textHash(item.content || item.snippet || ''),
      summary: summaryText(item.snippet || item.content || title, 260),
      details: { kind: 'result' },
    });
  });
}

async function executePlannedResearch({ session, runId = null, sourceType, query, llmConfig, executeQuery, evidence } = {}) {
  const requestedQuery = String(query || '').replace(/\s+/g, ' ').trim();
  if (!requestedQuery) return { error: 'QUERY_REQUIRED', message: '检索需要 query 参数', results: [] };
  const state = getResearchState(session.id);
  const previous = state.sources?.[sourceType];
  if (previous?.completed) {
    const records = (previous.query_records || []).map((record) => ({ ...record, cached: true }));
    const providerError = records.length > 0 && records.every((record) => record.status === 'error')
      ? records.find((record) => record.error_code)?.error_code || 'RESEARCH_PROVIDER_FAILED'
      : null;
    return {
      query: requestedQuery,
      query_plan: previous.query_plan,
      query_records: records,
      budget: buildBudget(previous.query_records, previous),
      results: projectResults(previous.results, sourceType),
      cache_hit: true,
      provider_error: providerError,
      message: providerError
        ? '已复用本次任务的检索失败回执。'
        : previous.had_evidence ? '已复用本次任务的检索结果。' : '已复用本次任务的空检索结果；没有补充结果。',
    };
  }

  const queryPlan = await buildAgentQueryPlan({ query: requestedQuery, llmConfig, sessionId: session.id, runId });
  const sourceState = {
    original_query: requestedQuery,
    query_plan: {
      initial_queries: queryPlan.initial_queries,
      fallback_queries: queryPlan.fallback_queries,
      planner: queryPlan.planner,
      planner_failed: Boolean(queryPlan.planner_failed),
    },
    query_records: [],
    results: [],
    initial_executed: false,
    fallback_executed: false,
    completed: false,
    had_evidence: false,
  };

  const runBatch = async (queries, phase) => {
    for (const plannedQuery of queries) {
      const startedAt = Date.now();
      let execution;
      try {
        execution = await executeQuery(plannedQuery);
      } catch (error) {
        execution = { error, results: [], durationMs: Date.now() - startedAt };
      }
      const durationMs = Math.max(0, Number(execution?.durationMs) || Date.now() - startedAt);
      const rows = Array.isArray(execution?.results) ? execution.results : [];
      const decorated = rows.map((row) => ({ ...row, matched_queries: [plannedQuery] }));
      sourceState.results = mergeResults([...sourceState.results, ...decorated], sourceType);
      const record = makeQueryRecord({
        query: plannedQuery,
        phase,
        status: execution?.error ? 'error' : rows.length > 0 ? 'success' : 'empty',
        resultCount: rows.length,
        durationMs,
        errorCode: execution?.error ? sanitizeErrorCode(execution.error) : '',
      });
      sourceState.query_records.push(record);
      recordQueryAndResultReceipts({
        session,
        sourceType,
        query: plannedQuery,
        phase,
        result: { ...execution, durationMs },
        provider: execution?.provider || '',
      });
    }
  };

  await runBatch(queryPlan.initial_queries, 'initial');
  sourceState.initial_executed = true;
  const hasEvidence = () => sourceState.results.some((item) => {
    const queries = Array.isArray(item.matched_queries) && item.matched_queries.length > 0
      ? item.matched_queries
      : [requestedQuery];
    return queries.some((matchedQuery) => evidence(item, matchedQuery));
  });
  sourceState.had_evidence = hasEvidence();
  if (!sourceState.had_evidence) {
    await runBatch(queryPlan.fallback_queries, 'fallback');
    sourceState.fallback_executed = true;
    sourceState.had_evidence = hasEvidence();
  }
  sourceState.completed = true;
  state.sources[sourceType] = sourceState;
  saveResearchState(session.id, state);
  const allProviderRequestsFailed = sourceState.query_records.length > 0
    && sourceState.query_records.every((record) => record.status === 'error');
  const providerError = allProviderRequestsFailed
    ? sourceState.query_records.find((record) => record.error_code)?.error_code || 'RESEARCH_PROVIDER_FAILED'
    : '';

  return {
    query: requestedQuery,
    query_plan: sourceState.query_plan,
    query_records: sourceState.query_records,
    budget: buildBudget(sourceState.query_records, sourceState),
    results: projectResults(sourceState.results, sourceType),
    cache_hit: false,
    provider_error: providerError || null,
    message: providerError
      ? '检索服务本轮未能返回结果，已记录失败原因。'
      : sourceState.had_evidence ? '已完成本次任务的批量检索。' : '已完成 5 个查询，没有补充结果。',
  };
}

function registerParsedInputSources({ sessionId, conversationId, parsedAttachments = [], attachments = [] } = {}) {
  const session = { id: normalizePositiveInt(sessionId), conversation_id: normalizePositiveInt(conversationId) };
  if (!session.id) return [];
  const attachmentBySource = new Map((Array.isArray(attachments) ? attachments : []).map((item) => [String(item?.source || ''), item]));
  return (Array.isArray(parsedAttachments) ? parsedAttachments : [])
    .filter((item) => String(item?.type || '') === 'webpage')
    .map((item) => {
      const source = normalizeUrl(item.source || '');
      const sourceAttachment = attachmentBySource.get(String(item?.source || '')) || {};
      const parseStatus = String(item?.status || 'error');
      const success = parseStatus === 'success' || parseStatus === 'partial';
      insertResearchReceipt({
        sessionId: session.id,
        conversationId: session.conversation_id,
        sourceType: 'explicit_url',
        phase: 'input',
        sourceTitle: sourceAttachment.metadata?.title || source,
        sourceRef: source,
        status: success ? parseStatus : 'error',
        resultCount: success ? 1 : 0,
        contentHash: success ? textHash(sourceAttachment.text || '') : '',
        errorCode: success ? '' : (item.errorCode || 'URL_FETCH_FAILED'),
        summary: success
          ? (item.duplicate ? '已读取此前导入的链接材料。' : `已读取链接材料，提取 ${Number(item.textLength || 0)} 字。`)
          : (item.warning || '链接读取失败。'),
        details: { explicit: true, duplicate: Boolean(item.duplicate), text_length: Number(item.textLength || 0) },
      });
      return source;
    }).filter(Boolean);
}

function recordToolReceipt(session, toolName, result = {}) {
  if (!session?.id || result?.error) return null;
  if (toolName === 'read_file' && result.file_path) {
    return insertResearchReceipt({
      sessionId: session.id,
      conversationId: session.conversation_id,
      sourceType: 'file',
      phase: 'tool',
      sourceTitle: result.title || result.file_path,
      sourceRef: result.file_path,
      status: 'success',
      resultCount: 1,
      contentHash: result.hash || textHash(result.content || ''),
      summary: `已读取 ${String(result.content || '').length} 字。`,
      details: { tool_name: toolName },
    });
  }
  return null;
}

function recordWriteReceipt(session, operationSet = {}, status = '') {
  if (!session?.id || !operationSet?.id) return null;
  const patches = Array.isArray(operationSet.patches) ? operationSet.patches : [];
  return patches.map((patch) => insertResearchReceipt({
    sessionId: session.id,
    conversationId: session.conversation_id,
    sourceType: 'file_write',
    phase: 'write',
    sourceTitle: patch.file_path || patch.new_path || patch.old_path || '文件变更',
    sourceRef: patch.file_path || patch.new_path || patch.old_path || '',
    status: status || operationSet.status || 'preview',
    resultCount: 1,
    contentHash: textHash(patch.new || patch.draft_content || ''),
    summary: `文件变更状态：${status || operationSet.status || 'preview'}`,
    details: { operation_set_id: operationSet.id, change_type: patch.change_type || '' },
  }));
}

function buildResearchSummary(sessionId) {
  const receipts = readResearchReceipts(sessionId, { limit: 160 });
  const sourceRows = receipts.filter((item) => ['explicit_url', 'web', 'knowledge', 'file'].includes(item.source_type));
  const seen = new Set();
  const sources = [];
  for (const item of sourceRows) {
    const key = `${item.source_type}:${item.source_ref || item.query || item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.source_type !== 'explicit_url' && item.details?.kind === 'query' && !item.source_ref) continue;
    sources.push({
      type: item.source_type,
      title: item.source_title || (item.source_type === 'knowledge' ? '知识库检索' : item.source_type === 'web' ? '联网搜索' : '读取文件'),
      ref: item.source_ref || '',
      status: item.status,
      summary: item.summary,
      error_code: item.error_code || '',
    });
    if (sources.length >= 8) break;
  }
  ['knowledge', 'web'].forEach((sourceType) => {
    if (sources.some((item) => item.type === sourceType)) return;
    const queryReceipts = receipts.filter((item) => item.source_type === sourceType && item.details?.kind === 'query');
    const latest = queryReceipts[queryReceipts.length - 1];
    if (!latest) return;
    sources.push({
      type: sourceType,
      title: sourceType === 'knowledge' ? '知识库检索' : '联网搜索',
      ref: '',
      status: latest.status,
      summary: latest.status === 'empty' ? '没有补充结果。' : latest.summary,
      error_code: latest.error_code || '',
    });
  });
  const queries = receipts
    .filter((item) => ['knowledge', 'web'].includes(item.source_type) && item.details?.kind === 'query')
    .map((item) => ({ source_type: item.source_type, query: item.query, phase: item.phase, status: item.status, result_count: item.result_count }))
    .slice(0, 12);
  return { enabled: isAgentTaskReceiptsEnabled(), sources, queries };
}

function buildWriteSummary(sessionId) {
  const sets = listOperationSetsBySession(normalizePositiveInt(sessionId));
  const changes = [];
  const seen = new Set();
  for (const set of sets) {
    const patches = Array.isArray(set.patches) ? set.patches : [];
    for (const patch of patches) {
      const path = String(patch.file_path || patch.new_path || patch.old_path || '').trim();
      const key = `${set.id}:${path}:${patch.change_type || ''}`;
      if (!path || seen.has(key)) continue;
      seen.add(key);
      changes.push({
        path,
        status: String(patch.status || set.status || 'pending'),
        change_type: patch.change_type || (set.mode === 'create_file' ? 'create' : 'modify'),
        operation_set_id: Number(set.id),
      });
    }
  }
  return { enabled: isAgentTaskReceiptsEnabled(), changes: changes.slice(0, 12) };
}

function formatResearchReceiptsForPrompt(sessionId) {
  const receipts = readResearchReceipts(sessionId, { limit: 80 });
  const explicitSuccess = receipts.filter((item) => item.source_type === 'explicit_url' && item.status === 'success');
  if (explicitSuccess.length === 0) return '';
  return [
    '## 确定性来源状态',
    '以下是服务端已经成功读取的用户显式链接。它们不是搜索引擎结果，后续联网搜索为空不能推翻这些成功状态：',
    ...explicitSuccess.map((item) => `- 已读取：${item.source_ref}${item.source_title && item.source_title !== item.source_ref ? `（${item.source_title}）` : ''}`),
    '回答时不得把上述链接表述为“未找到、未读到、仓库不存在”。如果联网搜索没有新增内容，只能说“没有补充结果”。',
  ].join('\n');
}

function correctConflictingSourceClaims(text = '', sessionId) {
  const summary = buildResearchSummary(sessionId);
  const hasExplicitSuccess = summary.sources.some((item) => item.type === 'explicit_url' && item.status === 'success');
  if (!hasExplicitSuccess) return { text: String(text || ''), corrected: false };
  const pattern = /(?:[^。！？\n]*(?:仓库|README|链接|网页|项目|资料|搜索)[^。！？\n]*(?:未找到|没有找到|没找到|未读到|未读取|没搜索到)[^。！？\n]*|[^。！？\n]*(?:未找到|没有找到|没找到|未读到|未读取|没搜索到)[^。！？\n]*(?:仓库|README|链接|网页|项目|资料|搜索)[^。！？\n]*)[。！？]?/gi;
  const original = String(text || '');
  const next = original.replace(pattern, '已读取用户提供的链接材料；后续联网搜索没有补充结果。');
  if (next === original) return { text: original, corrected: false };
  insertResearchReceipt({
    sessionId,
    sourceType: 'source_correction',
    phase: 'finalize',
    status: 'corrected',
    summary: '已用成功的显式链接来源状态修正冲突结论。',
    details: { kind: 'deterministic_source_correction' },
  });
  return { text: next, corrected: true };
}

function getTaskActivity(sessionId) {
  const id = normalizePositiveInt(sessionId);
  const receipts = sanitizeResearchReceipts(id, { limit: 160 });
  const logs = getDb().prepare(`
    SELECT tool_name, status, loop_index, duration_ms, created_at
    FROM agent_run_logs WHERE session_id = ? AND tool_name IS NOT NULL
    ORDER BY id ASC
  `).all(id).map((row) => ({
    tool_name: row.tool_name,
    status: row.status,
    loop_index: Number(row.loop_index || 0),
    duration_ms: Number(row.duration_ms || 0),
    created_at: row.created_at || '',
  }));
  const executed = new Set(logs.map((item) => item.tool_name));
  return {
    research_receipts: receipts,
    tool_records: logs,
    tool_status: ['search_knowledge', 'web_search', 'read_file'].map((tool_name) => ({
      tool_name,
      status: executed.has(tool_name) ? 'executed' : 'not_executed',
    })),
  };
}

module.exports = {
  RESEARCH_LIMIT,
  KNOWLEDGE_EVIDENCE_SCORE,
  buildAgentQueryPlan,
  executePlannedResearch,
  knowledgeHasEvidence,
  webHasEvidence,
  getResearchState,
  saveResearchState,
  insertResearchReceipt,
  readResearchReceipts,
  sanitizeResearchReceipts,
  registerParsedInputSources,
  recordToolReceipt,
  recordWriteReceipt,
  buildResearchSummary,
  buildWriteSummary,
  isAgentTaskReceiptsEnabled,
  formatResearchReceiptsForPrompt,
  correctConflictingSourceClaims,
  getTaskActivity,
  normalizeUrl,
  normalizePath,
};
