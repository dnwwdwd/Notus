const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-loop-auto-write-'));
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
    '../lib/fileRevisions', '../lib/fileRevisionDiff', '../lib/agentLoop',
    '../lib/platform/paths', '../lib/platform/profile', '../lib/platform/target',
  ].forEach(resetModule);

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
        if (llmCallCount <= 2) {
          const second = llmCallCount === 2;
          return {
            content: [{
              type: 'tool_use',
              id: `toolu_create_${llmCallCount}`,
              name: 'create_note',
              input: {
                path: second ? 'two.md' : 'one.md',
                content: second ? '# Two\n\nsecond\n' : '# One\n\nfirst\n',
              },
            }],
            stopReason: 'tool_use',
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          };
        }
        return {
          content: [{ type: 'text', text: '两份文件已创建。' }],
          stopReason: 'end_turn',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      },
    },
  };

  try {
    const { getFileByPath } = require('../lib/files');
    const { ensureConversation } = require('../lib/conversations');
    const { createSession, getSession, loadMessagesCheckpoint, updateSessionStatus } = require('../lib/agentSession');
    const { runAgentLoop } = require('../lib/agentLoop');
    const { getTaskChangeSetDetail } = require('../lib/agentTaskChangeSets');
    const { listExecutionSegments } = require('../lib/agentExecutionSegments');
    const conversation = ensureConversation({ kind: 'canvas', title: '自动写入连续任务测试' });
    const session = createSession({
      goal: '用户任务：新建 one.md 和 two.md。',
      authorizedPaths: [],
      authorizedOps: ['create'],
      conversationId: conversation.id,
    });
    updateSessionStatus(session.sessionId, 'running');

    const events = [];
    const controller = new AbortController();
    let interruptedOnce = false;
    const interrupted = await runAgentLoop({
      sessionId: session.sessionId,
      approvalMode: 'auto_confirm',
      llmConfig: { llmContextWindowTokens: 60000 },
      signal: controller.signal,
      onStream: (event) => {
        events.push(event);
        if (!interruptedOnce && event.type === 'artifact' && event.artifact_type === 'operation_set') {
          interruptedOnce = true;
          controller.abort('connection_lost');
        }
      },
    });
    assert.strictEqual(interrupted.status, 'queued_resume');
    assert.strictEqual(llmCallCount, 1);
    assert.ok(getFileByPath('one.md'));
    const checkpoint = loadMessagesCheckpoint(session.sessionId);
    assert.strictEqual(checkpoint.phase, 'dispatching_tools');
    assert.strictEqual(checkpoint.nextToolIndex, 1);
    assert.strictEqual(JSON.parse(checkpoint.toolResults[0].content).applied, true);

    const result = await runAgentLoop({
      sessionId: session.sessionId,
      approvalMode: 'auto_confirm',
      llmConfig: { llmContextWindowTokens: 60000 },
      onStream: (event) => events.push(event),
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(llmCallCount, 3);
    assert.strictEqual(getSession(session.sessionId).status, 'completed');
    assert.ok(getFileByPath('one.md'));
    assert.ok(getFileByPath('two.md'));
    assert.strictEqual(events.filter((event) => event.type === 'artifact' && event.artifact_type === 'operation_set').length, 2);
    assert.strictEqual(events.filter((event) => event.type === 'final').length, 1);
    const executionStarts = events.filter((event) => event.type === 'progress' && event.stage === 'model_requesting');
    const toolStarts = events.filter((event) => event.type === 'progress' && event.stage === 'tool_start');
    assert.strictEqual(executionStarts.length, 3, '每一次模型决策都必须公开一个执行段的真实等待状态。');
    assert.deepStrictEqual(toolStarts.map((event) => event.execution_segment_id), executionStarts.slice(0, 2).map((event) => event.execution_segment_id));
    assert.deepStrictEqual(toolStarts.map((event) => event.tool_index), [0, 0]);
    assert.ok(events.some((event) => String(event.text || '').includes('两份文件已创建')));
    const changeSet = getTaskChangeSetDetail(session.sessionId);
    assert.strictEqual(changeSet.file_count, 2);
    assert.strictEqual(changeSet.pending_count, 0);
    assert.strictEqual(changeSet.operation_sets.length, 2);
    assert.strictEqual(changeSet.operation_set_view.patches.length, 2);
    assert.deepStrictEqual(changeSet.operation_set_view.patches.map((patch) => patch.file_path).sort(), ['one.md', 'two.md']);
    assert.deepStrictEqual(
      changeSet.operation_set_view.patches.map((patch) => patch.source_batches[0]?.execution_segment_sequence_no).sort(),
      [1, 2],
      '累计 Diff 的每个文件必须能追溯到真实执行段。'
    );
    const segments = listExecutionSegments(session.sessionId);
    assert.strictEqual(segments.length, 3);
    assert.deepStrictEqual(segments.map((segment) => segment.sequence_no), [1, 2, 3]);
  } finally {
    delete require.cache[require.resolve('../lib/agentLoop')];
    if (originalLlm) require.cache[llmPath] = originalLlm;
    else delete require.cache[llmPath];
  }

  console.log('agent loop auto write continuation tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
