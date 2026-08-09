const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-tool-resume-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.LOG_DIR = path.join(tempRoot, 'logs');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');

  const llmPath = require.resolve('../lib/llm');
  const originalLlm = require.cache[llmPath];
  let llmCallCount = 0;
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: {
      completeToolChat: async () => {
        llmCallCount += 1;
        return {
          content: [{ type: 'text', text: '已从中断位置继续并完成。' }],
          stopReason: 'end_turn',
          usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
        };
      },
    },
  };

  try {
    const { createFile } = require('../lib/files');
    const { ensureConversation } = require('../lib/conversations');
    const { createSession, saveMessagesCheckpoint, updateSessionStatus } = require('../lib/agentSession');
    const { beginExecutionSegment, beginRequestWindow, finishRequestWindow, updateExecutionSegment } = require('../lib/agentExecutionSegments');
    const { getDb } = require('../lib/db');
    const { runAgentLoop } = require('../lib/agentLoop');

    createFile('a.md', '# A\n');
    createFile('b.md', '# B\n');
    const conversation = ensureConversation({ kind: 'canvas', title: '工具续跑测试' });
    const session = createSession({ goal: '读取两个文件。', authorizedPaths: [], authorizedOps: ['modify'], conversationId: conversation.id });
    const segment = beginExecutionSegment(session.sessionId, 1, { reuseOpen: false });
    const window = beginRequestWindow(segment.id, { retryLimit: 2 });
    finishRequestWindow(window.id, 'completed');
    updateExecutionSegment(segment.id, { status: 'dispatching_tools', toolNames: ['read_file', 'read_file'] });
    const content = [
      { type: 'tool_use', id: 'tool_read_a', name: 'read_file', input: { path: 'a.md' } },
      { type: 'tool_use', id: 'tool_read_b', name: 'read_file', input: { path: 'b.md' } },
    ];
    saveMessagesCheckpoint(session.sessionId, [{ role: 'user', content: '读取两个文件。' }], content, '', 'resume-test', {
      phase: 'dispatching_tools',
      executionSegmentId: segment.id,
      llmRequestWindowId: window.id,
      toolResults: [{ type: 'tool_result', tool_use_id: 'tool_read_a', content: JSON.stringify({ file_path: 'a.md', content: '# A\n' }), is_error: false }],
      nextToolIndex: 1,
    });
    updateSessionStatus(session.sessionId, 'queued_resume');

    const result = await runAgentLoop({
      sessionId: session.sessionId,
      approvalMode: 'auto_confirm',
      llmConfig: { llmContextWindowTokens: 60000 },
    });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(llmCallCount, 1);
    const readLogs = getDb().prepare("SELECT tool_input FROM agent_run_logs WHERE session_id = ? AND tool_name = 'read_file' ORDER BY id ASC").all(session.sessionId);
    assert.strictEqual(readLogs.length, 1);
    assert.strictEqual(JSON.parse(readLogs[0].tool_input).path, 'b.md');
  } finally {
    delete require.cache[require.resolve('../lib/agentLoop')];
    if (originalLlm) require.cache[llmPath] = originalLlm;
    else delete require.cache[llmPath];
  }

  console.log('agent tool dispatch resume tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
