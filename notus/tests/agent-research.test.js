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
    query: '换个关键词也不能绕过预算',
    evidence: knowledgeHasEvidence,
    executeQuery: async () => {
      throw new Error('缓存命中不应继续请求 Provider');
    },
  });
  assert.strictEqual(cached.cache_hit, true);
  assert.strictEqual(knowledgeQueries.length, 5, '重复或换词调用不能产生额外 Provider 请求');

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

  console.log('agent research tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
