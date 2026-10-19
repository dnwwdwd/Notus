const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-blocked-replay-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.LOG_DIR = path.join(tempRoot, 'logs');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');

  const llmPath = require.resolve('../lib/llm');
  const originalLlm = require.cache[llmPath];
  const requestLog = [];
  let script = [];
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: {
      completeToolChat: async (request) => {
        requestLog.push(request.messages);
        const next = script.shift();
        if (!next) throw new Error('没有更多脚本化模型响应');
        return {
          content: next,
          stopReason: next.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
          usage: { total_tokens: 1 },
        };
      },
    },
  };

  try {
    const { createFile } = require('../lib/files');
    const { ensureConversation } = require('../lib/conversations');
    const { createSession, updateSessionStatus } = require('../lib/agentSession');
    const { getDb } = require('../lib/db');
    const { runAgentLoop } = require('../lib/agentLoop');

    createFile('ok.md', '# OK\n');
    const conversation = ensureConversation({ kind: 'agent', title: '拦截重放测试' });
    const { sessionId } = createSession({ goal: '读取文件。', authorizedPaths: [], conversationId: conversation.id });
    const readLogs = () => getDb().prepare("SELECT tool_input FROM agent_run_logs WHERE session_id = ? AND tool_name = 'read_file' ORDER BY id ASC").all(sessionId);

    // 第一轮：两次相同失败建立 repeat 拦截条目；第三次相同调用被拦截。
    script = [
      [
        { type: 'text', text: '读取文件。' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'missing.md' } },
        { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'missing.md' } },
      ],
      [
        { type: 'text', text: '重试读取。' },
        { type: 'tool_use', id: 't3', name: 'read_file', input: { path: 'missing.md' } },
      ],
      [{ type: 'text', text: '任务完成。' }],
    ];
    updateSessionStatus(sessionId, 'queued_resume');
    const firstRun = await runAgentLoop({ sessionId, approvalMode: 'auto_confirm', llmConfig: { llmContextWindowTokens: 60000 } });
    assert.strictEqual(firstRun.status, 'completed');
    assert.strictEqual(readLogs().length, 2, '只有前两次调用真实执行，被拦截的第三次不得执行');

    // 拦截分支必须已保存推进后的 dispatching_tools 检查点。
    const blockedFacts = getDb().prepare("SELECT payload_json FROM agent_runtime_facts WHERE session_id = ? AND fact_type = 'tool_call_blocked'").all(sessionId);
    assert.ok(blockedFacts.length >= 1, '拦截必须落库 tool_call_blocked 事实');
    assert.ok(JSON.parse(blockedFacts[0].payload_json).input_digest, '拦截事实必须携带 input_digest 用于恢复种子');
    const interceptionCheckpoints = getDb().prepare(
      "SELECT id, status, next_tool_index, tool_results_json, last_response_content_json FROM agent_checkpoints WHERE session_id = ? AND phase = 'dispatching_tools' ORDER BY id ASC"
    ).all(sessionId).filter((row) => String(row.tool_results_json).includes('t3'));
    assert.ok(interceptionCheckpoints.length >= 1, '被拦截调用必须产生包含拦截回执的检查点');
    const interception = interceptionCheckpoints[interceptionCheckpoints.length - 1];
    assert.strictEqual(interception.next_tool_index, 1, '拦截检查点必须推进 nextToolIndex 越过被拦截调用');
    const savedBlocked = JSON.parse(interception.tool_results_json).find((item) => String(item.tool_use_id) === 't3');
    assert.ok(savedBlocked && String(savedBlocked.content).includes('TOOL_REPEAT_BLOCKED') && savedBlocked.is_error === true, '拦截回执必须落入检查点');

    // 第二轮：模拟崩溃后从拦截检查点恢复。恢复必须从推进后的索引继续，
    // 被拦截的 t3 不再真实执行，其回执已随检查点进入模型消息。
    getDb().prepare("UPDATE agent_checkpoints SET status = 'superseded' WHERE session_id = ?").run(sessionId);
    getDb().prepare("UPDATE agent_checkpoints SET status = 'active', superseded_at = NULL WHERE id = ?").run(interception.id);
    updateSessionStatus(sessionId, 'queued_resume');
    script = [[{ type: 'text', text: '任务完成。' }]];
    const resumeRun = await runAgentLoop({ sessionId, approvalMode: 'auto_confirm', llmConfig: { llmContextWindowTokens: 60000 } });
    assert.strictEqual(resumeRun.status, 'completed');
    assert.strictEqual(readLogs().length, 2, '从拦截检查点恢复后不得真实重放被拦截调用');
    const resumeRequest = JSON.stringify(requestLog[requestLog.length - 1]);
    assert.ok(resumeRequest.includes('"tool_use_id":"t3"') && resumeRequest.includes('TOOL_REPEAT_BLOCKED'), '恢复轮请求必须包含 t3 的拦截回执');

    // 第三轮：模拟无检查点的从零重启。tool_call_blocked 事实必须进入
    // repeatedCalls 种子，让模型再次发出的相同调用仍被拦截而不是执行。
    updateSessionStatus(sessionId, 'queued_resume');
    script = [
      [{ type: 'tool_use', id: 't4', name: 'read_file', input: { path: 'missing.md' } }],
      [{ type: 'text', text: '任务完成。' }],
    ];
    const restartRun = await runAgentLoop({ sessionId, approvalMode: 'auto_confirm', llmConfig: { llmContextWindowTokens: 60000 } });
    assert.strictEqual(restartRun.status, 'completed');
    assert.strictEqual(readLogs().length, 2, '从零重启后被拦截的相同调用不得真实重放');
    const restartReceipts = requestLog[requestLog.length - 1]
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === 'tool_result' && String(block.tool_use_id) === 't4');
    assert.strictEqual(restartReceipts.length, 1, 't4 必须收到回执');
    assert.ok(String(restartReceipts[0].content).includes('TOOL_REPEAT_BLOCKED') && restartReceipts[0].content.includes('"not_executed":true'), 't4 必须以拦截回执返回模型而不是执行结果');

    // 第四轮：资源回执超长必须截断注入，去重逻辑保持一次。
    const receiptConversation = ensureConversation({ kind: 'agent', title: '资源回执截断测试' });
    const { sessionId: receiptSessionId } = createSession({ goal: '安装资源。', authorizedPaths: [], conversationId: receiptConversation.id });
    const bigResponse = { ok: true, message: 'y'.repeat(200000) };
    getDb().prepare(`INSERT INTO conversation_interactions (conversation_id, kind, source, status, reason_code, article_hash, payload_json, response_json, updated_at)
      VALUES (?, 'resource_approval', 'agent_loop', 'answered', 'resource_approval_requested', '', ?, ?, datetime('now'))`)
      .run(receiptConversation.id, JSON.stringify({ agent_session_id: receiptSessionId, action: 'skill_install' }), JSON.stringify(bigResponse));
    updateSessionStatus(receiptSessionId, 'queued_resume');
    script = [[{ type: 'text', text: '任务完成。' }]];
    const receiptRun = await runAgentLoop({ sessionId: receiptSessionId, approvalMode: 'auto_confirm', llmConfig: { llmContextWindowTokens: 60000 } });
    assert.strictEqual(receiptRun.status, 'completed');
    const receiptMessages = requestLog[requestLog.length - 1]
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === 'text' && String(block.text || '').includes('资源确认执行回执'));
    assert.strictEqual(receiptMessages.length, 1, '同一版本资源回执只注入一次');
    const receiptText = receiptMessages[0].text;
    assert.ok(receiptText.includes('"truncated":true') && receiptText.includes('original_chars'), '超长资源结果必须带截断标记');
    assert.ok(receiptText.length < 4000, `注入回执必须被截断（当前长度 ${receiptText.length}）`);
    assert.ok(!receiptText.includes('y'.repeat(5000)), '截断后不得再携带完整超长正文');
  } finally {
    delete require.cache[require.resolve('../lib/agentLoop')];
    if (originalLlm) require.cache[llmPath] = originalLlm;
    else delete require.cache[llmPath];
  }

  console.log('agent blocked replay and receipt truncation tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
