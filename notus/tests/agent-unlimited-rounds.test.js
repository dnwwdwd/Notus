const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-unlimited-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.LOG_DIR = path.join(tempRoot, 'logs');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');
  process.env.NOTUS_AGENT_RUNTIME_MODE = 'enforced';

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
      completeToolChat: async (request = {}) => {
        llmCallCount += 1;
        if (llmCallCount <= 35) {
          request.onVisibleText?.('先创建文件。');
          return {
            content: [{ type: 'text', text: '先创建文件。' }, {
              type: 'tool_use',
              id: `toolu_create_${llmCallCount}`,
              name: 'create_note',
              input: {
                path: `part-${llmCallCount}.md`,
                content: `# Part ${llmCallCount}\n\n已完成内容。\n`,
              },
            }],
            stopReason: 'tool_use',
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          };
        }
        request.onVisibleText?.('文件');
        request.onVisibleText?.('已创建。');
        return {
          content: [{ type: 'text', text: '文件已创建。' }],
          stopReason: 'end_turn',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      },
    },
  };

  try {
    const { ensureConversation } = require('../lib/conversations');
    const { createSession, getSession, updateSessionStatus, updateSessionLoopCount } = require('../lib/agentSession');
    const { runAgentLoop } = require('../lib/agentLoop');
    const { getDb } = require('../lib/db');
    const conversation = ensureConversation({ kind: 'canvas', title: '不限轮次测试' });
    const makeSession = () => createSession({ goal: '创建文件并总结', authorizedPaths: [], authorizedOps: ['create'], conversationId: conversation.id, tokenBudgetTotal: 1000000 });
    const session = makeSession();
    const events = [];
    const controller = new AbortController();
    const interrupted = await runAgentLoop({ sessionId: session.sessionId, approvalMode: 'auto_confirm', signal: controller.signal, llmConfig: { llmContextWindowTokens: 1000000 }, onStream: e => {
      events.push(e);
      if (llmCallCount === 31 && e.type === 'artifact' && e.artifact_type === 'operation_set') controller.abort('connection_lost');
    } });
    assert.equal(interrupted.status, 'queued_resume');
    assert.equal(llmCallCount, 31, '超过旧 30 轮后仍实际调用模型');
    const result = await runAgentLoop({ sessionId: session.sessionId, approvalMode: 'auto_confirm', llmConfig: { llmContextWindowTokens: 1000000 }, onStream: e => events.push(e) });
    assert.equal(result.status, 'completed');
    assert.equal(llmCallCount, 36, '35 次工具轮后给出最终回答并停止');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM canvas_operation_sets WHERE agent_session_id = ? AND status = ?').get(session.sessionId, 'applied').n, 35);
    assert.ok(!events.some(e => e.reason === 'hard_limit_reached' || e.stage === 'soft_limit_notice'));

    const { evaluateCompletion } = require('../lib/agentCompletionEvaluator');
    assert.equal(evaluateCompletion({ sessionId: session.sessionId, frame: { intent: { completion_criteria: { requires_write: true, requires_applied_write: true, requires_answer: true } } }, finalText: '文件已创建。' }).complete, true);
    const missingEvidence = { sessionId: session.sessionId, frame: { intent: { completion_criteria: { requires_web: true } } }, finalText: '声称已联网' };
    assert.equal(evaluateCompletion(missingEvidence).complete, false);
    assert.equal(evaluateCompletion(missingEvidence).correctable, true);
    assert.equal(evaluateCompletion({ ...missingEvidence, correctionCount: 1 }).correctable, false);

    const resumed = makeSession();
    updateSessionLoopCount(resumed.sessionId, 31);
    updateSessionStatus(resumed.sessionId, 'waiting_limit_confirmation');
    const resumedResult = await runAgentLoop({ sessionId: resumed.sessionId, llmConfig: { llmContextWindowTokens: 1000000 } });
    assert.equal(resumedResult.status, 'completed', '旧上限等待态可继续并完成');
    assert.equal(llmCallCount, 37);

    const budget = makeSession();
    getDb().prepare('UPDATE agent_sessions SET token_budget_total = 1 WHERE id = ?').run(budget.sessionId);
    llmCallCount = 0;
    const budgetResult = await runAgentLoop({ sessionId: budget.sessionId, approvalMode: 'auto_confirm', llmConfig: { llmContextWindowTokens: 1000000 } });
    assert.equal(budgetResult.reason, 'token_budget_reached');
    assert.equal(getSession(budget.sessionId).status, 'waiting_limit_confirmation');
    assert.equal(llmCallCount, 1, '预算耗尽后不再请求模型');

    const vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../hooks/useAgentLoopController.js'), 'utf8');
    const context = { getAgentToolLabel: v => v, getAgentToolDisplayName: v => v, getAgentLoopReasonLabel: v => v };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function toPositiveInt'), source.indexOf('const FILE_MUTATION_TOOL_NAMES')).replaceAll('export function', 'function'), context);
    const oldEvent = { type: 'artifact', artifact_type: 'limit_confirmation', reason: 'hard_limit_reached' };
    const restored = context.buildRestoredAgentTimeline({ status: 'waiting_limit_confirmation', run_events: [{ id: 1, payload: oldEvent }] });
    assert.ok(restored.steps.some(s => s.action === 'resume_agent' && s.status === 'waiting'));
    for (const status of ['running', 'queued', 'completed', 'cancelled']) {
      assert.ok(!context.buildRestoredAgentTimeline({ status, run_events: [{ id: 1, payload: oldEvent }] }).steps.some(s => s.action === 'resume_agent'));
    }
    const continued = context.applyAgentTimelineEvent({ activeSteps: restored.steps }, { type: 'session_resumed' });
    assert.ok(!continued.activeSteps.some(s => s.id === 'loop-done-hard_limit_reached'));
    const tokenStep = context.buildEventStep({ ...oldEvent, reason: 'token_budget_reached' });
    assert.notEqual(tokenStep.action, 'resume_agent', '预算确认不能绕过');
  } finally {
    delete require.cache[require.resolve('../lib/agentLoop')];
    if (originalLlm) require.cache[llmPath] = originalLlm;
    else delete require.cache[llmPath];
  }
  console.log('agent unlimited rounds tests passed');
}
runTests().catch(error => { console.error(error); process.exit(1); });
