const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-llm-segment-resume-'));
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
        if (callCount === 1) {
          return {
            content: [{ type: 'tool_use', id: 'toolu_resume_read', name: 'read_file', input: { path: 'resume.md' } }],
            stopReason: 'tool_use',
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          };
        }
        if (callCount <= 7) {
          const error = new Error('temporary unavailable');
          error.status = 503;
          throw error;
        }
        return {
          content: [{ type: 'text', text: '已从失败位置继续。' }],
          stopReason: 'end_turn',
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        };
      },
    },
  };

  try {
    const { createFile } = require('../lib/files');
    const { ensureConversation } = require('../lib/conversations');
    const { createSession, getSession, loadMessagesCheckpoint, updateSessionStatus } = require('../lib/agentSession');
    const { listExecutionSegments } = require('../lib/agentExecutionSegments');
    const { runAgentLoop } = require('../lib/agentLoop');

    createFile('resume.md', '# Resume\n\ncontent\n');
    const conversation = ensureConversation({ kind: 'agent', title: '执行段恢复测试' });
    const session = createSession({
      goal: '读取 resume.md 后总结。',
      authorizedPaths: ['resume.md'],
      authorizedOps: ['modify'],
      conversationId: conversation.id,
    });
    updateSessionStatus(session.sessionId, 'running');

    const firstEvents = [];
    const firstResult = await runAgentLoop({
      sessionId: session.sessionId,
      llmConfig: { llmContextWindowTokens: 60000 },
      llmRetryDelayMs: () => 0,
      onStream: (event) => firstEvents.push(event),
    });

    assert.strictEqual(firstResult.status, 'waiting_retry');
    assert.strictEqual(getSession(session.sessionId).status, 'waiting_retry');
    assert.strictEqual(firstEvents.filter((event) => event.type === 'progress' && event.stage === 'tool_start').length, 1, '失败前读取工具必须只执行一次');
    const checkpoint = loadMessagesCheckpoint(session.sessionId);
    assert.ok(checkpoint, '重试耗尽后必须保留可恢复 checkpoint');
    const beforeResume = listExecutionSegments(session.sessionId);
    assert.strictEqual(beforeResume.length, 2);
    assert.strictEqual(beforeResume[1].request_windows.length, 1);
    assert.strictEqual(beforeResume[1].request_windows[0].retry_attempts, 5);

    updateSessionStatus(session.sessionId, 'running');
    const resumedEvents = [];
    const resumedResult = await runAgentLoop({
      sessionId: session.sessionId,
      llmConfig: { llmContextWindowTokens: 60000 },
      llmRetryDelayMs: () => 0,
      onStream: (event) => resumedEvents.push(event),
    });

    assert.strictEqual(resumedResult.status, 'completed');
    assert.strictEqual(getSession(session.sessionId).status, 'completed');
    assert.strictEqual(resumedEvents.filter((event) => event.type === 'progress' && event.stage === 'tool_start').length, 0, '恢复同一执行段不得重复执行已完成工具');
    const afterResume = listExecutionSegments(session.sessionId);
    assert.strictEqual(afterResume.length, 2, '继续任务不得创建新的执行段');
    assert.strictEqual(afterResume[1].id, beforeResume[1].id, '继续任务必须复用失败的执行段');
    assert.strictEqual(afterResume[1].request_windows.length, 2, '继续任务只应在原执行段新增请求窗口');
    assert.strictEqual(afterResume[1].request_windows[1].status, 'completed');
    assert.strictEqual(loadMessagesCheckpoint(session.sessionId), null, '任务完成后必须清除恢复 checkpoint');
  } finally {
    delete require.cache[require.resolve('../lib/agentLoop')];
    if (originalLlm) require.cache[llmPath] = originalLlm;
    else delete require.cache[llmPath];
  }

  console.log('agent llm execution segment resume tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
