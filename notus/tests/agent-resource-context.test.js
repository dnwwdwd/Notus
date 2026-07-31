const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function run() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-resource-context-'));
  const originalEnv = {
    NOTUS_DATA_ROOT: process.env.NOTUS_DATA_ROOT,
    NOTUS_RUNTIME_TARGET: process.env.NOTUS_RUNTIME_TARGET,
    HOME: process.env.HOME,
  };
  const testHome = path.join(dataRoot, 'home');
  fs.mkdirSync(testHome, { recursive: true });
  process.env.NOTUS_DATA_ROOT = dataRoot;
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.HOME = testHome;

  [
    '../lib/db',
    '../lib/config',
    '../lib/runtime',
    '../lib/conversations',
    '../lib/agentSession',
    '../lib/conversationInteractions',
    '../lib/skills',
    '../lib/mcp',
    '../lib/agentResourceContext',
    '../lib/agentLoopPrompt',
  ].forEach(resetModule);

  const { ensureRuntime } = require('../lib/runtime');
  const { createConversation } = require('../lib/conversations');
  const { createSession, logToolCall } = require('../lib/agentSession');
  const { skillRoots, scanAllSkills, getSkill, deleteSkill } = require('../lib/skills');
  const { saveServer, removeServer } = require('../lib/mcp');
  const { createInteraction } = require('../lib/conversationInteractions');
  const { buildConversationResourceContext, formatConversationResourceContext } = require('../lib/agentResourceContext');
  const { buildLoopSystemPrompt } = require('../lib/agentLoopPrompt');

  try {
    assert.equal(ensureRuntime({ startBackground: false }).ok, true);
    const root = skillRoots().find((item) => item.managedByNotus);
    const skillDir = path.join(root.path, 'renhua');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: renhua\ndescription: 上下文回归测试\n---\n\n测试内容\n');
    scanAllSkills();
    const skill = getSkill(scanAllSkills().find((item) => item.name === 'renhua').id);
    const conversation = createConversation({ kind: 'canvas', title: '资源上下文回归' });
    const firstSession = createSession({ goal: '查看 renhua', conversationId: conversation.id });
    logToolCall({
      sessionId: firstSession.sessionId,
      loopIndex: 1,
      toolName: 'get_skill_details',
      toolInput: { skill_id: skill.id },
      toolResult: { id: skill.id, name: skill.name, enabled: true, managed: true, status: 'valid' },
    });

    let context = buildConversationResourceContext(conversation.id);
    assert.equal(context.latest.id, skill.id, '跨 session 必须保留最近操作的 Skill 稳定 ID');
    assert.equal(context.latest.type, 'skill');
    assert.match(formatConversationResourceContext(context), new RegExp(skill.id));

    const server = await saveServer({
      name: 'context MCP',
      transport: 'streamable_http',
      enabled: true,
      http: { url: 'https://example.com/mcp' },
    });
    const secondSession = createSession({ goal: '查看 MCP', conversationId: conversation.id });
    logToolCall({
      sessionId: secondSession.sessionId,
      loopIndex: 1,
      toolName: 'get_mcp_server_details',
      toolInput: { server_id: server.id },
      toolResult: { server: { id: server.id, name: server.name, transport: server.transport, enabled: true } },
    });
    context = buildConversationResourceContext(conversation.id);
    assert.equal(context.latest.id, server.id, '最近一次 MCP 操作应覆盖为当前资源对象');
    assert.equal(context.latest.type, 'mcp');

    const thirdSession = createSession({ goal: '再次查看 Skill', conversationId: conversation.id });
    logToolCall({
      sessionId: thirdSession.sessionId,
      loopIndex: 1,
      toolName: 'get_skill_details',
      toolInput: { skill_id: skill.id },
      toolResult: { id: skill.id, name: skill.name, enabled: true, managed: true, status: 'valid' },
    });
    context = buildConversationResourceContext(conversation.id);
    const prompt = buildLoopSystemPrompt({ goal: '我想换个名字' }, { resourceContext: context });
    assert.equal(context.latest.id, skill.id);
    assert.ok(prompt.includes('当前受管资源上下文（高于最近对话文本）'));
    assert.ok(prompt.includes('只有用户明确指向文章、文件或新资源时才切换目标'));

    createInteraction({
      conversationId: conversation.id,
      kind: 'resource_approval',
      source: 'agent_loop',
      status: 'answered',
      payload: { action: 'skill_disable', skill_id: skill.id, agent_session_id: thirdSession.sessionId },
      response: { approved: true, action: 'skill_disable', skill: { id: skill.id, name: skill.name, enabled: false } },
      answeredAt: '2038-01-01T00:00:00.000Z',
    });
    context = buildConversationResourceContext(conversation.id);
    assert.equal(context.latest.source, 'resource_approval', '确认卡完成后的资源操作也必须能承接');

    const secondSkillDir = path.join(root.path, 'other-skill');
    fs.mkdirSync(secondSkillDir, { recursive: true });
    fs.writeFileSync(path.join(secondSkillDir, 'SKILL.md'), '---\nname: other-skill\ndescription: 歧义回归测试\n---\n\n测试内容\n');
    const secondSkill = getSkill(scanAllSkills().find((item) => item.name === 'other-skill').id);
    const ambiguousConversation = createConversation({ kind: 'canvas', title: '资源歧义回归' });
    const ambiguousSession = createSession({ goal: '查看两个 Skill', conversationId: ambiguousConversation.id });
    [skill, secondSkill].forEach((item) => logToolCall({
      sessionId: ambiguousSession.sessionId,
      loopIndex: 1,
      toolName: 'get_skill_details',
      toolInput: { skill_id: item.id },
      toolResult: { id: item.id, name: item.name, enabled: true, managed: true, status: 'valid' },
    }));
    const ambiguousContext = buildConversationResourceContext(ambiguousConversation.id);
    assert.ok(ambiguousContext.ambiguousTypes.includes('skill'), '同一最近操作中的多个 Skill 不能强行绑定');
    assert.ok(formatConversationResourceContext(ambiguousContext).includes('必须追问'));

    deleteSkill(skill.id);
    context = buildConversationResourceContext(conversation.id);
    assert.ok(!context.skills.some((item) => item.id === skill.id), '已删除的 Skill 不得继续注入上下文');

    await removeServer(server.id);
    context = buildConversationResourceContext(conversation.id);
    assert.equal(context.hasResources, false, '已删除资源不得作为承接目标');
    console.log('agent resource context tests passed');
  } finally {
    try { require('../lib/skills').stopSkillWatchers(); } catch {}
    fs.rmSync(dataRoot, { recursive: true, force: true });
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
