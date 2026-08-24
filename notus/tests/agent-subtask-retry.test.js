const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-subtask-retry-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.LOG_DIR = path.join(tempRoot, 'logs');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');

  [
    '../lib/db', '../lib/config', '../lib/files', '../lib/conversations',
    '../lib/canvasOperationSets', '../lib/agentSession', '../lib/agentTools',
    '../lib/agentExecutionSegments', '../lib/agentTaskChangeSets', '../lib/agentLoop',
    '../lib/platform/paths', '../lib/platform/profile', '../lib/platform/target',
  ].forEach(resetModule);

  const llmPath = require.resolve('../lib/llm');
  const originalLlm = require.cache[llmPath];
  let callCount = 0;
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: {
      completeToolChat: async () => {
        callCount += 1;
        if (callCount === 1 || callCount === 3) {
          const error = new Error('temporary unavailable');
          error.status = 503;
          throw error;
        }
        if (callCount === 2) {
          return {
            content: [{ type: 'tool_use', id: 'toolu_read_retry', name: 'read_file', input: { path: 'retry.md' } }],
            stopReason: 'tool_use',
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          };
        }
        return {
          content: [{ type: 'text', text: '读取完成。' }],
          stopReason: 'end_turn',
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        };
      },
    },
  };

  try {
    const { createFile } = require('../lib/files');
    const { ensureConversation } = require('../lib/conversations');
    const { createSession, updateSessionStatus } = require('../lib/agentSession');
    const { listExecutionSegments } = require('../lib/agentExecutionSegments');
    const { runAgentLoop } = require('../lib/agentLoop');
    createFile('retry.md', '# Retry\n\ncontent\n');
    const conversation = ensureConversation({ kind: 'agent', title: '子任务重试测试' });
    const session = createSession({
      goal: '读取 retry.md 后总结。',
      authorizedPaths: ['retry.md'],
      authorizedOps: ['modify'],
      conversationId: conversation.id,
    });
    updateSessionStatus(session.sessionId, 'running');
    const events = [];
    const result = await runAgentLoop({
      sessionId: session.sessionId,
      llmConfig: { llmContextWindowTokens: 60000 },
      onStream: (event) => events.push(event),
    });
    assert.strictEqual(result.status, 'completed');
    const retries = events.filter((event) => event.type === 'progress' && event.stage === 'llm_retry');
    assert.strictEqual(retries.length, 2);
    assert.notStrictEqual(retries[0].execution_segment_id, retries[1].execution_segment_id);
    assert.deepStrictEqual(retries.map((event) => event.retry_attempt), [1, 1]);
    const segments = listExecutionSegments(session.sessionId);
    assert.strictEqual(segments.length, 2);
    assert.deepStrictEqual(segments.map((segment) => segment.request_windows[0].retry_attempts), [1, 1]);
    assert.deepStrictEqual(segments.map((segment) => segment.status), ['completed', 'completed']);
  } finally {
    delete require.cache[require.resolve('../lib/agentLoop')];
    if (originalLlm) require.cache[llmPath] = originalLlm;
    else delete require.cache[llmPath];
  }

  console.log('agent subtask retry tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
