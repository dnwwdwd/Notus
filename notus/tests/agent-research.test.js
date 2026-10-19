const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-research-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.LOG_DIR = path.join(tempRoot, 'logs');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');

  [
    '../lib/db',
    '../lib/config',
    '../lib/conversations',
    '../lib/agentSession',
    '../lib/agentResearch',
    '../lib/canvasOperationSets',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const { createConversation } = require('../lib/conversations');
  const { createSession, getSession } = require('../lib/agentSession');
  const {
    buildResearchSummary,
    correctConflictingSourceClaims,
    executePlannedResearch,
    getTaskActivity,
    knowledgeHasEvidence,
    readResearchReceipts,
    recordMcpWebEvidence,
    registerParsedInputSources,
    webHasEvidence,
  } = require('../lib/agentResearch');

  const conversation = createConversation({ kind: 'canvas', title: 'Agent 检索回归' });
  const knowledgeSession = createSession({
    goal: '用户任务：查询 Notus Agent 检索策略',
    conversationId: conversation.id,
  });
  const knowledge = getSession(knowledgeSession.sessionId);
  const knowledgeQueries = [];
  const firstPass = await executePlannedResearch({
    session: knowledge,
    sourceType: 'knowledge',
    query: 'Notus Agent 检索策略',
    evidence: knowledgeHasEvidence,
    executeQuery: async (query) => {
      knowledgeQueries.push(query);
      return {
        results: [{
          file_title: '无关笔记',
          file_path: 'archive/other.md',
          content: '不匹配的内容',
          score: 0.001,
          source: 'vec',
        }],
      };
    },
  });
  assert.strictEqual(knowledgeQueries.length, 5, '初轮无有效证据时必须精确补到 5 个查询');
  assert.strictEqual(firstPass.query_plan.initial_queries.length, 3);
  assert.strictEqual(firstPass.query_plan.fallback_queries.length, 2);
  assert.strictEqual(firstPass.query_records[0].query, 'Notus Agent 检索策略', '原始查询必须是首项');
  assert.strictEqual(firstPass.budget.used, 5);

  const cached = await executePlannedResearch({
    session: getSession(knowledgeSession.sessionId),
    sourceType: 'knowledge',
    query: 'Notus Agent 检索策略',
    evidence: knowledgeHasEvidence,
    executeQuery: async () => {
      throw new Error('缓存命中不应继续请求 Provider');
    },
  });
  assert.strictEqual(cached.cache_hit, true);
  const changedQueries = [];
  const changed = await executePlannedResearch({ session: getSession(knowledgeSession.sessionId), sourceType: 'knowledge', query: '支付聚合平台费率', evidence: knowledgeHasEvidence, executeQuery: async (query) => { changedQueries.push(query); return { results: [] }; } });
  assert.equal(changed.cache_hit, false);
  assert.equal(changedQueries[0], '支付聚合平台费率');
  assert.equal(changedQueries.length, 5);
  assert.strictEqual(knowledgeQueries.length, 5, '相同查询不产生额外 Provider 请求');

  // 两篇实际不同的文章必须在首次/缓存投影及模型回执中保留各自 ID。
  const identitySession = createSession({goal: '核对两篇 Notus 文章', conversationId: conversation.id});
  const identityResults = [
    {file_id: 9907892, file_path: 'Notus/欢迎使用.md', file_title: '欢迎使用', content: '正文 A', score: 1},
    {file_id: 9567188, file_path: 'Notus/前瞻.md', file_title: '前瞻', content: '正文 B', score: 1},
  ];
  const identityInput = {session: getSession(identitySession.sessionId), sourceType: 'knowledge', query: 'Notus', evidence: knowledgeHasEvidence};
  const liveIdentity = await executePlannedResearch({...identityInput, executeQuery: async () => ({results: identityResults})});
  const cachedIdentity = await executePlannedResearch({...identityInput, executeQuery: async () => {throw Error('缓存不得重新查询');}});
  const {buildToolResultReceipt} = require('../lib/agentToolResultStore');
  for (const result of [liveIdentity,cachedIdentity]) {
    assert.deepStrictEqual(result.results.map(item=>item.file_id), [9907892,9567188]);
    assert.deepStrictEqual(buildToolResultReceipt({toolName:'search_knowledge',result}).file_refs, identityResults.map(({file_id,file_path})=>({file_id,file_path})));
  }
  assert.strictEqual(cachedIdentity.cache_hit,true);

  const webSession = createSession({
    goal: '用户任务：联网查询 Notus Agent 检索策略',
    conversationId: conversation.id,
    webSearchEnabled: true,
  });
  const webQueries = [];
  const web = await executePlannedResearch({
    session: getSession(webSession.sessionId),
    sourceType: 'web',
    query: 'Notus Agent 检索策略',
    evidence: webHasEvidence,
    executeQuery: async (query) => {
      webQueries.push(query);
      return { results: [] };
    },
  });
  assert.strictEqual(webQueries.length, 5, '联网来源必须独立遵守 5 词上限');
  assert.strictEqual(web.budget.used, 5);

  registerParsedInputSources({
    sessionId: webSession.sessionId,
    conversationId: conversation.id,
    parsedAttachments: [{
      source: 'https://github.com/dnwwdwd/Notus#readme',
      type: 'webpage',
      status: 'success',
      textLength: 420,
    }],
    attachments: [{
      source: 'https://github.com/dnwwdwd/Notus#readme',
      metadata: { title: 'Notus README' },
      text: '# Notus README',
    }],
  });
  const summary = buildResearchSummary(webSession.sessionId);
  assert.ok(summary.sources.some((item) => item.type === 'explicit_url' && item.status === 'success' && item.ref === 'https://github.com/dnwwdwd/Notus'), '显式 URL 成功回执必须保留规范化链接');
  const correction = correctConflictingSourceClaims('这个 GitHub 仓库未找到。', webSession.sessionId);
  assert.strictEqual(correction.corrected, true);
  assert.ok(correction.text.includes('已读取用户提供的链接材料'));

  const activity = getTaskActivity(webSession.sessionId);
  const webQueryReceipts = activity.research_receipts.filter((item) => item.source_type === 'web' && item.query);
  assert.strictEqual(webQueryReceipts.length, 5, '追问必须能读取真实的五条查询回执');
  assert.strictEqual(activity.tool_status.find((item) => item.tool_name === 'read_file').status, 'not_executed');

  // M6：MCP Markdown 回退只信任明确的搜索/抓取动词，且 URL 必须与实质正文同现。
  const mcpEvidenceSession = createSession({ goal: '用户任务：联网搜索 MCP 证据口径', conversationId: conversation.id });
  const mcpReceipts = (query) => readResearchReceipts(mcpEvidenceSession.sessionId)
    .filter((item) => item.phase === 'mcp' && item.source_ref && (!query || item.query === query));

  // webhook 工具即使返回带 URL 的 Markdown，也不触发回退证据。
  recordMcpWebEvidence({
    session: getSession(mcpEvidenceSession.sessionId),
    toolName: 'ci_webhook',
    description: '发送 CI 构建通知',
    result: { content: [{ type: 'text', text: '构建结果已发布，详情与日志说明见 https://example.com/build/123 页面。' }] },
    query: 'mcp webhook 检索',
  });
  assert.equal(mcpReceipts('mcp webhook 检索').length, 0, 'webhook 工具的引用链接不得计入联网证据');

  // 正常 JSON 命中路径不受影响：按 URL 去重并保留标题。
  recordMcpWebEvidence({
    session: getSession(mcpEvidenceSession.sessionId),
    toolName: 'web_search',
    result: { results: [
      { url: 'https://a.example/one', title: '来源一', content: '正文一' },
      { url: 'https://a.example/one', title: '重复来源', content: '正文一' },
      { url: 'https://a.example/two', title: '来源二', content: '正文二' },
    ] },
    query: 'mcp json 检索',
  });
  const jsonReceipts = mcpReceipts('mcp json 检索');
  assert.equal(jsonReceipts.length, 2, 'JSON 路径仍按 URL 去重并保留结果');
  assert.ok(jsonReceipts.every((item) => item.source_title), 'JSON 路径必须保留来源标题');

  // 同一段正文含多个 URL：只保留一条证据，其余 URL 合并进同一条 content。
  recordMcpWebEvidence({
    session: getSession(mcpEvidenceSession.sessionId),
    toolName: 'web_search',
    result: { content: [{ type: 'text', text: '以下是相关报道的正文说明：https://b.example/news 与 https://c.example/news 均报道了同一事件的最新进展与影响分析。' }] },
    query: 'mcp markdown 检索',
  });
  const mergedReceipts = mcpReceipts('mcp markdown 检索');
  assert.equal(mergedReceipts.length, 1, '同段多 URL 只保留一条证据');
  assert.equal(mergedReceipts[0].source_ref, 'https://b.example/news');
  assert.ok(mergedReceipts[0].summary.includes('https://c.example/news'), '其余 URL 合并进同一条证据内容');

  // 纯链接列表（URL 无正文同现）与非搜索动词工具的 Markdown 都不产生回退证据。
  recordMcpWebEvidence({
    session: getSession(mcpEvidenceSession.sessionId),
    toolName: 'web_search',
    result: { content: [{ type: 'text', text: 'https://d.example/a\nhttps://d.example/b\nhttps://d.example/c' }] },
    query: 'mcp markdown 检索',
  });
  recordMcpWebEvidence({
    session: getSession(mcpEvidenceSession.sessionId),
    toolName: 'list_pages',
    description: '列出已保存的网页与互联网页面存档',
    result: { content: [{ type: 'text', text: '页面存档的说明文字足够长，见 https://e.example/page。' }] },
    query: 'mcp markdown 检索',
  });
  assert.equal(mcpReceipts('mcp markdown 检索').length, 1, '纯链接列表与非抓取类工具不得产生回退证据');

  console.log('agent research tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
