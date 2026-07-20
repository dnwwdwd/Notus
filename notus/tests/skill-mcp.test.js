const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-skill-mcp-test-'));
process.env.NOTUS_DATA_ROOT = dataRoot;
process.env.NOTUS_RUNTIME_TARGET = 'electron';

async function run() {
  const { ensureRuntime } = require('../lib/runtime');
  const { createSession, getSession, setSessionMcpPermission, consumeSessionMcpPermission } = require('../lib/agentSession');
  const { getSkillMcpCapabilities } = require('../lib/platform/capabilities');
  const { saveServer, listServers, removeServer } = require('../lib/mcp');
  const { buildLoopSystemPrompt } = require('../lib/agentLoopPrompt');
  const { stopSkillWatchers } = require('../lib/skills');

  try {
    assert.equal(ensureRuntime().ok, true);
    const capabilities = getSkillMcpCapabilities('electron', { dataRoot });
    assert.equal(capabilities.mcp.stdio, true);
    assert.equal(capabilities.skills.discoverExternalRoots, true);

    const created = createSession({
      goal: '整理研究笔记',
      authorizedPaths: [''],
      skillMentions: ['skill-a'],
      mcpSelection: { mode: 'auto' },
    });
    const session = getSession(created.sessionId);
    assert.deepEqual(session.skill_mentions, ['skill-a']);
    assert.deepEqual(session.mcp_selection, { mode: 'auto' });
    setSessionMcpPermission(session.id, 'server-a:tool-a', 'allow_once');
    assert.equal(consumeSessionMcpPermission(session.id, 'server-a:tool-a'), true);
    assert.equal(consumeSessionMcpPermission(session.id, 'server-a:tool-a'), false);

    const prompt = buildLoopSystemPrompt(session, {
      skillCatalog: [{ id: 'skill-a', name: 'skill-a', description: '测试 Skill', sourceLabel: 'test', explicit: true }],
      mcpInstructions: [{ server: 'test MCP', text: '外部说明' }],
    });
    assert.ok(prompt.includes('本轮明确选择的 Skill'));
    assert.ok(prompt.includes('不可信输入'));

    const server = await saveServer({
      name: 'test MCP',
      transport: 'streamable_http',
      http: { url: 'http://127.0.0.1:39001/mcp' },
      toolPolicy: { default: 'ask' },
    });
    assert.equal(listServers().length, 1);
    await removeServer(server.id);
    assert.equal(listServers().length, 0);
    console.log('skill and mcp tests passed');
  } finally {
    stopSkillWatchers();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
