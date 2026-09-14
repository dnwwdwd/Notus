const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-memory-loop-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), DB_PATH: path.join(root, 'notus.db'), LOG_DIR: path.join(root, 'logs'), SESSION_DIR: path.join(root, 'session'), ASSETS_DIR: path.join(root, 'assets') });
const llmPath = require.resolve('../lib/llm');
let count = 0;
let requests = [];
let marker = '';
require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: {
  completeToolChat: async request => {
    requests.push(request);
    const memory = require('../lib/globalAgentFiles');
    count += 1;
    if (count === 1) return { content: [{ type: 'tool_use', id: `read-${marker}`, name: 'read_global_agent_file', input: { file: 'memory' } }], stopReason: 'tool_use' };
    if (count === 2) return { content: [{ type: 'tool_use', id: `write-${marker}`, name: 'update_global_agent_file', input: { file: 'memory', content: `${memory.readFile('memory').content}\n- 我平时偏好${marker}。\n`, expected_hash: memory.readFile('memory').hash, evidence: `我平时偏好${marker}` } }], stopReason: 'tool_use' };
    assert.ok(request.system.includes(`我平时偏好${marker}`), '写入后的下一次请求必须含新记忆');
    return { content: [{ type: 'text', text: '好的，继续处理。' }], stopReason: 'end_turn' };
  },
} };
async function run() {
  const { ensureConversation } = require('../lib/conversations');
  const { createSession, listRunEvents } = require('../lib/agentSession');
  const { runAgentLoop } = require('../lib/agentLoop');
  for (const mode of ['legacy', 'enforced']) {
    process.env.NOTUS_AGENT_RUNTIME_MODE = mode;
    marker = mode === 'legacy' ? '短句' : '具体示例';
    count = 0; requests = [];
    const conversation = ensureConversation({ kind: 'canvas', title: mode });
    const session = createSession({ goal: `我平时偏好${marker}`, authorizedPaths: [''], conversationId: conversation.id });
    const result = await runAgentLoop({ sessionId: session.sessionId, llmConfig: { llmContextWindowTokens: 60000 } });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(count, 3);
    const events = listRunEvents(session.sessionId).map(item => item.payload);
    assert.ok(events.some(item => item.tool_display_name === '读取记忆'));
    assert.ok(events.some(item => item.tool_display_name === '更新记忆'));
  }
  console.log('agent memory refresh tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { require('../lib/db').closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
