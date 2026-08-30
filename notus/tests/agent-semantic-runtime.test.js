const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-semantic-runtime-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');
  process.env.NOTUS_AGENT_RUNTIME_MODE = 'enforced';

  const { getAgentRuntimeMode } = require('../lib/agentRuntimeMode');
  assert.strictEqual(getAgentRuntimeMode({}), 'legacy');
  const { clarificationIntent, compileIntent, deterministicIntent } = require('../lib/agentSemanticRuntime');
  const { requiredToolNames } = require('../lib/agentToolProfile');
  const { getSearchCapabilityLimitation, sanitizeOutboundSearchQuery } = require('../lib/agentSearchMission');
  const skillDiscovery = deterministicIntent('帮我找生成应用 icon 的 Skill', { webSearchEnabled: true });
  assert.strictEqual(skillDiscovery.task_kind, 'skill_discovery');
  assert.strictEqual(skillDiscovery.source_policy.web, 'required');
  assert.strictEqual(skillDiscovery.source_policy.knowledge, 'forbidden');
  assert.strictEqual(skillDiscovery.source_policy.local_skills, 'forbidden');
  assert.ok(skillDiscovery.forbidden_actions.includes('skill_install'));
  const mixedSkillIntent = deterministicIntent('帮我找一个 Skill 然后安装', { webSearchEnabled: true });
  assert.strictEqual(mixedSkillIntent.needs_clarification, true);
  const discoveryWithoutInstall = deterministicIntent('联网找生成应用 icon 的 Skill。只报告结果，不安装。', { webSearchEnabled: true });
  assert.strictEqual(discoveryWithoutInstall.task_kind, 'skill_discovery');
  assert.strictEqual(discoveryWithoutInstall.needs_clarification, false);
  assert.ok(discoveryWithoutInstall.forbidden_actions.includes('skill_install'));
  const createWithoutInstall = deterministicIntent('创建一个生成图标的 Skill，不要安装。', { webSearchEnabled: false });
  assert.strictEqual(createWithoutInstall.task_kind, 'skill_create');
  assert.strictEqual(createWithoutInstall.needs_clarification, false);
  const compiledDiscovery = compileIntent('skill_discovery', deterministicIntent('联网处理这个 Skill', { webSearchEnabled: true }));
  assert.strictEqual(compiledDiscovery.source_policy.web, 'required');
  assert.strictEqual(compiledDiscovery.completion_criteria.requires_web, true);
  assert.ok(compiledDiscovery.forbidden_actions.includes('skill_install'));
  assert.ok(requiredToolNames(createWithoutInstall).has('create_skill_draft'));

  const explicitWeb = deterministicIntent('联网搜索这个 Skill', { webSearchEnabled: false });
  assert.strictEqual(explicitWeb.source_policy.web, 'required');
  assert.strictEqual(explicitWeb.source_policy.local_skills, 'forbidden');
  assert.notStrictEqual(deterministicIntent('总结今年的工作记录', { webSearchEnabled: true }).source_policy.web, 'required');
  assert.notStrictEqual(deterministicIntent('不要联网，只总结当前文档', { webSearchEnabled: true, activeFile: { id: 7, path: 'draft.md' } }).source_policy.web, 'required');
  assert.notStrictEqual(deterministicIntent('不联网，只总结当前文档', { webSearchEnabled: true, activeFile: { id: 7, path: 'draft.md' } }).source_policy.web, 'required');
  assert.strictEqual(deterministicIntent('禁止访问互联网，只总结当前文档', { webSearchEnabled: true, activeFile: { id: 7, path: 'draft.md' } }).source_policy.web, 'forbidden');
  ['不得联网', '不能联网', '勿访问互联网', '严禁联网'].forEach((query) => {
    const denied = deterministicIntent(`${query}，只回答确认。`, { webSearchEnabled: true });
    assert.strictEqual(denied.source_policy.web, 'forbidden');
    assert.deepStrictEqual(denied.direct_url_policy.inspect_urls, []);
  });
  assert.strictEqual(deterministicIntent('不要访问互联网，只回答确认。', { webSearchEnabled: true }).needs_clarification, false);
  assert.strictEqual(deterministicIntent('不要通过网上搜索，只回答确认。', { webSearchEnabled: true }).needs_clarification, false);
  assert.notStrictEqual(deterministicIntent('总结这篇笔记中今年发布的信息', { webSearchEnabled: true, activeFile: { id: 7, path: 'draft.md' } }).source_policy.web, 'required');
  assert.strictEqual(deterministicIntent('查询今天的天气', { webSearchEnabled: false }).source_policy.web, 'required');
  assert.notStrictEqual(deterministicIntent('不要查询当前价格', { webSearchEnabled: true }).source_policy.web, 'required');
  assert.notStrictEqual(deterministicIntent('无需获取最新版本', { webSearchEnabled: true }).source_policy.web, 'required');
  assert.strictEqual(deterministicIntent('不要联网，但请网上搜索今天的天气', { webSearchEnabled: true }).needs_clarification, true);
  const conflictFallback = deterministicIntent('不要联网，但请网上搜索今天的天气', { webSearchEnabled: true });
  const customConflictAnswer = clarificationIntent({ payload: { origin: 'turn_composer' }, status: 'answered', response: { answers: { web_permission: { text: '自定义回答' } } } }, conflictFallback);
  assert.strictEqual(customConflictAnswer.source_policy.web, 'forbidden');
  const urlWebConflict = deterministicIntent('不要联网，但请读取 https://example.com/a', { webSearchEnabled: true });
  assert.strictEqual(urlWebConflict.needs_clarification, true);
  assert.strictEqual(urlWebConflict.source_policy.web, 'forbidden');
  assert.deepStrictEqual(urlWebConflict.direct_url_policy.inspect_urls, []);
  const allowedUrlConflict = clarificationIntent({ payload: { origin: 'turn_composer' }, status: 'answered', response: { answers: { web_permission: { value: 'web_required' } } } }, urlWebConflict);
  assert.deepStrictEqual(allowedUrlConflict.direct_url_policy.inspect_urls, ['https://example.com/a']);

  const install = deterministicIntent('安装这个仓库里的 Skill：https://github.com/example/demo', { webSearchEnabled: true });
  assert.strictEqual(install.task_kind, 'skill_install');
  assert.deepStrictEqual(install.direct_url_policy.inspect_urls, []);
  assert.strictEqual(install.direct_url_policy.tool_only_urls.length, 1);
  assert.ok(requiredToolNames(install).has('install_skill_from_git'));
  assert.ok(requiredToolNames(install).has('list_skills'));

  const blocked = deterministicIntent('不要访问 https://example.com/private，只解释这句话。', { webSearchEnabled: true });
  assert.deepStrictEqual(blocked.direct_url_policy.inspect_urls, []);
  assert.strictEqual(blocked.direct_url_policy.blocked_urls.length, 1);
  const blockedRootUrl = deterministicIntent('不要访问 https://example.com，只确认你不会访问。', { webSearchEnabled: true });
  assert.deepStrictEqual(blockedRootUrl.direct_url_policy.inspect_urls, []);
  assert.deepStrictEqual(blockedRootUrl.direct_url_policy.blocked_urls, ['https://example.com/']);
  const mentionedOnlyUrl = deterministicIntent('把这句话改得更简洁：https://example.com 是示例地址。', { webSearchEnabled: true });
  assert.deepStrictEqual(mentionedOnlyUrl.direct_url_policy.inspect_urls, []);
  const inlineRewrite = deterministicIntent('把这句话改得更简洁，只输出改写结果：https://example.com 是一个示例地址。', { webSearchEnabled: true });
  assert.strictEqual(inlineRewrite.task_kind, 'general');
  assert.strictEqual(inlineRewrite.completion_criteria.requires_write, false);
  const documentRewrite = deterministicIntent('改写当前文档并保存。', { activeFile: { id: 7, path: 'draft.md' } });
  assert.strictEqual(documentRewrite.task_kind, 'file_write');
  assert.strictEqual(documentRewrite.completion_criteria.requires_write, true);
  const explicitReadUrl = deterministicIntent('请读取 https://example.com 并总结内容。', { webSearchEnabled: false });
  assert.deepStrictEqual(explicitReadUrl.direct_url_policy.inspect_urls, ['https://example.com/']);
  const multipleUrls = deterministicIntent('访问 https://example.com/a，https://example.com/b 不要读取。', { webSearchEnabled: true });
  assert.deepStrictEqual(multipleUrls.direct_url_policy.inspect_urls, ['https://example.com/a']);
  assert.deepStrictEqual(multipleUrls.direct_url_policy.blocked_urls, ['https://example.com/b']);
  const asciiMultipleUrls = deterministicIntent('访问 https://example.com/a, https://example.com/b 不要读取。', { webSearchEnabled: true });
  assert.deepStrictEqual(asciiMultipleUrls.direct_url_policy.inspect_urls, ['https://example.com/a']);
  assert.deepStrictEqual(asciiMultipleUrls.direct_url_policy.blocked_urls, ['https://example.com/b']);
  const ambiguousUrls = deterministicIntent('访问 https://example.com/a，https://example.com/b。', { webSearchEnabled: true });
  assert.strictEqual(ambiguousUrls.needs_clarification, true);
  const customUrlAnswer = clarificationIntent({ payload: { origin: 'turn_composer' }, status: 'answered', response: { answers: { url_selection: { text: '自定义回答' } } } }, ambiguousUrls);
  assert.deepStrictEqual(customUrlAnswer.direct_url_policy.inspect_urls, []);

  const activeFile = { id: 7, path: 'draft.md' };
  assert.strictEqual(deterministicIntent('查询当前价格', { activeFile }).material_policy.use_current_file, false);
  assert.strictEqual(deterministicIntent('检查当前版本', { activeFile }).material_policy.use_current_file, false);
  assert.strictEqual(deterministicIntent('总结当前文档', { activeFile }).material_policy.use_current_file, true);
  const safeSearchQuery = sanitizeOutboundSearchQuery('联网查 https://user:pass@example.com/a?token=secret&ok=1 authorization=Bearer-secret-value');
  assert.ok(!safeSearchQuery.includes('user:pass'));
  assert.ok(!safeSearchQuery.includes('token=secret'));
  assert.ok(!safeSearchQuery.includes('Bearer-secret-value'));
  const disabledSearch = getSearchCapabilityLimitation({ error: 'WEB_SEARCH_NOT_CONFIGURED', message: '联网搜索未在设置中启用。' });
  assert.strictEqual(disabledSearch.code, 'WEB_SEARCH_NOT_CONFIGURED');
  assert.ok(disabledSearch.message.includes('设置 → 搜索配置'));
  assert.strictEqual(getSearchCapabilityLimitation({ error: 'WEB_SEARCH_PROVIDER_FAILED' }), null);
  const startRouteSource = fs.readFileSync(path.join(__dirname, '../pages/api/agent/loop/start.js'), 'utf8');
  assert.ok(startRouteSource.includes('turn_context'));
  assert.ok(!/ensureConversation\([^\n]+fileId:\s*body\.active_file_id/.test(startRouteSource));

  const { getDb } = require('../lib/db');
  getDb();
  const { ensureConversation } = require('../lib/conversations');
  const { createSession } = require('../lib/agentSession');
  const { executePlannedResearch, webHasEvidence } = require('../lib/agentResearch');
  const conversation = ensureConversation({ kind: 'knowledge', title: 'search mission' });
  const { parseAgentInputSources } = require('../lib/agentInputSources');
  let networkRequests = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { networkRequests += 1; throw new Error('unexpected network request'); };
  const skippedUrls = await parseAgentInputSources({ conversationId: conversation.id, userInputText: '不要访问 https://example.com', selectedUrls: [] });
  global.fetch = originalFetch;
  assert.deepStrictEqual(skippedUrls, []);
  assert.strictEqual(networkRequests, 0);

  const attachmentsDir = path.join(tempRoot, 'session', 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(attachmentsDir, 'one.txt'), 'first content');
  fs.writeFileSync(path.join(attachmentsDir, 'two.txt'), 'second content');
  await parseAgentInputSources({ conversationId: conversation.id, attachments: [{ name: 'same.txt', stored_name: 'one.txt' }], selectedUrls: [], sourceMessageId: 101 });
  await parseAgentInputSources({ conversationId: conversation.id, attachments: [{ name: 'same.txt', stored_name: 'two.txt' }], selectedUrls: [], sourceMessageId: 102 });
  const sameNameResources = require('../lib/parsedAttachmentStore').loadAttachments(conversation.id).filter((item) => item.source === 'same.txt');
  assert.strictEqual(sameNameResources.length, 2);
  assert.notStrictEqual(sameNameResources[0].contentHash, sameNameResources[1].contentHash);

  const created = createSession({ goal: 'research', conversationId: conversation.id });
  const session = require('../lib/agentSession').getSession(created.sessionId);
  const calls = [];
  const executeQuery = async (query) => {
    calls.push(query);
    return { results: [{ title: query, url: `https://example.com/${calls.length}`, content: `${query} result` }] };
  };
  await executePlannedResearch({ session, sourceType: 'web', query: 'first exact question', missionFingerprint: 'mission-a', executeQuery, evidence: webHasEvidence });
  assert.strictEqual(calls[0], 'first exact question');
  const firstCount = calls.length;
  await executePlannedResearch({ session, sourceType: 'web', query: 'second new question', missionFingerprint: 'mission-b', executeQuery, evidence: webHasEvidence });
  assert.ok(calls.length > firstCount, '新问题不能复用旧 Search Mission。');
  assert.ok(calls.slice(firstCount).includes('second new question'));

  console.log('agent semantic runtime tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
