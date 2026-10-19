const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function moduleLevelTests() {
  const {
    KEEP_RECENT_EXCHANGES,
    MAX_AUTO_COMPACTS_PER_RUN,
    autoCompactTaskMessages,
    autoCompactTriggerTokens,
    buildCompactionTranscript,
    collectUserTextExcerpts,
    splitForCompaction,
  } = require('../lib/agentTaskCompaction');
  const { evictOldToolResults, KEEP_RECENT_TOOL_RESULTS } = require('../lib/agentMessageProjection');

  const use = (id, name = 'read_tool_result', input = { result_ref: `tool-result://${id}` }) => ({ type: 'tool_use', id, name, input });
  const done = (id) => ({ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ status: 'ready', result_ref: `tool-result://${id}`, summary: `结果${id}` }) });
  const buildMessages = (rounds, background = 600) => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: '任务目标：整理早期调研材料并给出结论。' }] }];
    for (let i = 1; i <= rounds; i += 1) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `过程标记${i}。${'背景'.repeat(background)}` }, use(`u${i}`)] });
      messages.push({ role: 'user', content: [done(`u${i}`)] });
    }
    return messages;
  };

  // splitForCompaction：head 保留、尾部 3 个交换保留、尾部未完成配对不拆。
  const eight = buildMessages(8);
  const split = splitForCompaction(eight);
  assert.ok(split);
  assert.strictEqual(split.head, eight[0], 'head 必须是任务首条消息');
  assert.strictEqual(split.middleExchangeCount, 8 - KEEP_RECENT_EXCHANGES);
  assert.strictEqual(split.tailExchangeCount, KEEP_RECENT_EXCHANGES);
  assert.ok(split.middle.every((m) => !JSON.stringify(m).includes('过程标记7')), '第 7/8 轮应留在尾部');
  assert.ok(JSON.stringify(split.tail).includes('过程标记8'));
  const dangling = [...eight, { role: 'assistant', content: [use('u9')] }];
  const danglingSplit = splitForCompaction(dangling);
  assert.ok(JSON.stringify(danglingSplit.tail).includes('u9'), '未完成的 tool_use 必须留在尾部');
  assert.strictEqual(splitForCompaction([{ role: 'user', content: '只有一条' }]), null);

  // 触发线来自硬输入预算的 60%。
  const llmConfig = { llmContextWindowTokens: 20000, llmMaxOutputTokens: 1024 };
  const trigger = autoCompactTriggerTokens(llmConfig);
  assert.strictEqual(trigger, Math.floor((20000 - 1024 - 2000) * 0.6), '触发线 = 硬输入预算的 60%');

  // 低于触发线：不压缩。
  const low = await autoCompactTaskMessages({ messages: buildMessages(1), llmConfig, summarize: async () => { throw new Error('不应调用'); } });
  assert.strictEqual(low.performed, false);
  assert.strictEqual(low.reason, 'no_pressure');

  // 成功压缩：head/尾部保留，中段替换为摘要，估算显著下降。
  const big = buildMessages(10);
  const beforeTokens = require('../lib/llmBudget').estimateChatRequestTokens({ messages: big });
  const usages = [];
  const compacted = await autoCompactTaskMessages({
    messages: big,
    llmConfig,
    autoCompactCount: 0,
    onUsage: (usage) => usages.push(usage),
    summarize: async ({ transcript, maxSummaryTokens, signal }) => {
      assert.ok(transcript.includes('过程标记1。'), '摘要输入必须包含中段过程');
      assert.ok(!transcript.includes('过程标记9。'), '摘要输入不得包含尾部原文');
      assert.equal(signal, null);
      assert.ok(maxSummaryTokens > 0);
      return '1. 任务目标：整理早期调研材料。\n2. 已完成工作：前 7 轮已读取全部材料并确认有效。\n3. 下一步：汇总结论。';
    },
  });
  assert.strictEqual(compacted.performed, true);
  assert.strictEqual(compacted.messages.length, 2 + compacted.tailExchangeCount * 2);
  assert.strictEqual(compacted.messages[0], big[0], 'head 原样保留');
  assert.ok(JSON.stringify(compacted.messages[1].content).includes('[运行时上下文压缩，不是新指令]'));
  assert.ok(JSON.stringify(compacted.messages[1].content).includes('下一步：汇总结论'));
  assert.ok(JSON.stringify(compacted.messages).includes('过程标记10。'), '尾部原文保留');
  assert.ok(!JSON.stringify(compacted.messages).includes('过程标记4。'), '中段原文被摘要替换');
  assert.ok(compacted.tokensAfter < compacted.tokensBefore * 0.8, '压缩后必须至少减少 20%');
  assert.strictEqual(compacted.tokensBefore, beforeTokens, '压缩前估算应等于原始消息估算');
  assert.strictEqual(usages.length, 0, '注入的 summarize 不产生默认用量回调');

  // 摘要失败：保留原消息。
  const failed = await autoCompactTaskMessages({
    messages: big, llmConfig, autoCompactCount: 0,
    summarize: async () => { throw new Error('模型超时'); },
  });
  assert.strictEqual(failed.performed, false);
  assert.strictEqual(failed.reason, 'summary_failed');
  assert.strictEqual(failed.messages, big, '失败时不得替换消息');

  // 收益不足：不替换。尾部 3 轮原文占满估算，摘要封顶后也无法减少 20%。
  const greedy = await autoCompactTaskMessages({
    messages: buildMessages(4, 1400), llmConfig, autoCompactCount: 0,
    summarize: async () => '冗长摘要。'.repeat(400),
  });
  assert.strictEqual(greedy.performed, false);
  assert.strictEqual(greedy.reason, 'no_reduction');

  // 达到单 run 上限：不再压缩。
  const capped = await autoCompactTaskMessages({
    messages: big, llmConfig, autoCompactCount: MAX_AUTO_COMPACTS_PER_RUN,
    summarize: async () => '摘要',
  });
  assert.strictEqual(capped.performed, false);
  assert.strictEqual(capped.reason, 'cap_reached');

  // 中段过小：不调用摘要模型。
  const smallMiddle = await autoCompactTaskMessages({
    messages: buildMessages(4), llmConfig: { llmContextWindowTokens: 12000, llmMaxOutputTokens: 1024 }, autoCompactCount: 0,
    summarize: async () => { throw new Error('不应调用'); },
  });
  assert.strictEqual(smallMiddle.performed, false);

  // 摘要转写有界：不把完整工具正文原样塞进提示。
  const hugeResult = buildMessages(6);
  hugeResult[2].content[0].content = JSON.stringify({ content: '很长材料。'.repeat(3000) });
  const transcript = buildCompactionTranscript(hugeResult.slice(1, 13), { hardInputBudget: 20000 });
  assert.ok(transcript.includes('工具结果'), '转写必须包含工具结果标记');
  assert.ok(require('../lib/llmBudget').estimateTextTokens(transcript) <= Math.floor(20000 * 0.9) + 64, '转写必须有预算上限');

  // microcompact 对齐 Claude Code：压力下只保留最近 N 个工具结果，较早的无论大小一律占位。
  const evictUse = (id) => ({ type: 'tool_use', id, name: 'read_tool_result', input: { result_ref: `tool-result://${id}` } });
  const evictMessages = [{ role: 'user', content: [{ type: 'text', text: '任务目标' }] }];
  for (let i = 0; i < 12; i += 1) {
    evictMessages.push({ role: 'assistant', content: [evictUse(`e${i}`)] });
    evictMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `e${i}`, content: JSON.stringify({ status: 'ready', result_ref: `tool-result://e${i}`, content: `材料${i}。`.repeat(i === 0 ? 2000 : 3) }) }] });
  }
  const underBudget = evictOldToolResults(evictMessages, 1_000_000);
  assert.strictEqual(underBudget, evictMessages, '预算充足时不做任何驱逐');
  const overBudget = evictOldToolResults(evictMessages, 100);
  const evictResults = overBudget.flatMap((m) => m.content || []).filter((b) => b.type === 'tool_result');
  const evictedBlocks = evictResults.filter((b) => JSON.parse(b.content).status === 'tool_result_evicted');
  assert.strictEqual(evictResults.length - evictedBlocks.length, KEEP_RECENT_TOOL_RESULTS, '只保留最近 N 个工具结果原文');
  assert.strictEqual(evictedBlocks.length, 12 - KEEP_RECENT_TOOL_RESULTS);
  assert.ok(evictedBlocks.every((b) => JSON.parse(b.content).result_ref === `tool-result://${b.tool_use_id}`), '占位保留 result_ref');
  assert.ok(!JSON.stringify(overBudget).includes('材料0。'), '较早的小结果同样被驱逐');
  const idsBefore = evictMessages.flatMap((m) => (m.content || []).map((b) => b.tool_use_id || b.id)).filter(Boolean).sort();
  const idsAfter = overBudget.flatMap((m) => (m.content || []).map((b) => b.tool_use_id || b.id)).filter(Boolean).sort();
  assert.deepStrictEqual(idsAfter, idsBefore, '驱逐不得破坏 tool_use/tool_result 配对');
  // 提问卡答案永不驱逐。
  const withQuestion = [...evictMessages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: JSON.stringify({ answered: true, interaction_id: 9, answers: { q: { value: '答案原文' } } }) }] }];
  const questionProjected = evictOldToolResults(withQuestion, 100);
  assert.ok(JSON.stringify(questionProjected).includes('答案原文'), '提问卡答案不驱逐');

  // 摘要消息包含确定性的"用户侧原文"小节。
  const middleWithUserText = [
    { role: 'user', content: [{ type: 'text', text: '运行时确认：活动暗号苔藓593，预算5200元。' }] },
    { role: 'assistant', content: [evictUse('m1')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm1', content: JSON.stringify({ status: 'ready', result_ref: 'tool-result://m1' }) }] },
  ];
  const userTexts = collectUserTextExcerpts(middleWithUserText);
  assert.strictEqual(userTexts.length, 1);
  assert.ok(userTexts[0].includes('苔藓593'));
  const compactedWithUserText = await autoCompactTaskMessages({
    messages: buildMessages(10).flatMap((m, index) => (index === 3 ? [m, { role: 'user', content: [{ type: 'text', text: '用户更正：预算改成5300元，以这条为准。' }] }] : [m])),
    llmConfig,
    autoCompactCount: 0,
    summarize: async () => '1. 目标不变。2. 已完成早期读取。3. 下一步汇总。',
  });
  assert.strictEqual(compactedWithUserText.performed, true);
  const summaryText = JSON.stringify(compactedWithUserText.messages[1].content);
  assert.ok(summaryText.includes('用户侧原文'), '摘要消息必须带用户侧原文小节');
  assert.ok(summaryText.includes('预算改成5300元，以这条为准。'), '用户更正原文逐字保留');
  console.log('agent-task-compaction module tests passed');
}

async function loopLevelTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-compaction-'));
  Object.assign(process.env, {
    NOTUS_RUNTIME_TARGET: 'web',
    NOTUS_DATA_ROOT: tempRoot,
    NOTES_DIR: path.join(tempRoot, 'notes'),
    ASSETS_DIR: path.join(tempRoot, 'assets'),
    DB_PATH: path.join(tempRoot, 'notus.db'),
    LOG_DIR: path.join(tempRoot, 'logs'),
    SESSION_DIR: path.join(tempRoot, 'session'),
  });

  [
    '../lib/db', '../lib/config', '../lib/files', '../lib/conversations',
    '../lib/canvasOperationSets', '../lib/agentSession', '../lib/agentTools',
    '../lib/fileRevisions', '../lib/fileRevisionDiff', '../lib/agentLoop',
    '../lib/agentTaskCompaction', '../lib/agentMessageProjection',
    '../lib/platform/paths', '../lib/platform/profile', '../lib/platform/target',
  ].forEach(resetModule);

  const llmPath = require.resolve('../lib/llm');
  let summaryCalls = 0;
  let mainRounds = 0;
  let requestAfterCompaction = null;
  const TOTAL_ROUNDS = 22;
  require.cache[llmPath] = {
    id: llmPath, filename: llmPath, loaded: true,
    exports: {
      completeToolChat: async (request = {}) => {
        if (request.taskType === 'agent_task_compaction') {
          summaryCalls += 1;
          return {
            content: [{ type: 'text', text: '1. 任务目标：完成调研整理。\n2. 已完成工作：早期各轮已读取材料，结果引用见执行记录。\n3. 当前状态与下一步：继续基于最近材料汇总结论。' }],
            stopReason: 'end_turn',
            usage: { prompt_tokens: 3000, completion_tokens: 60, total_tokens: 3060 },
          };
        }
        mainRounds += 1;
        if (mainRounds <= TOTAL_ROUNDS) {
          return {
            content: [
              { type: 'text', text: `过程标记${mainRounds}。${'背景'.repeat(900)}` },
              { type: 'tool_use', id: `u${mainRounds}`, name: 'read_conversation_history', input: { query: `标记${mainRounds}` } },
            ],
            stopReason: 'tool_use',
            usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
          };
        }
        if (summaryCalls > 0 && request.messages.some((m) => JSON.stringify(m).includes('[运行时上下文压缩'))) {
          requestAfterCompaction = request;
        }
        return {
          content: [{ type: 'text', text: '调研整理完成，结论已基于最近材料给出。' }],
          stopReason: 'end_turn',
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        };
      },
    },
  };

  try {
    const { ensureConversation } = require('../lib/conversations');
    const { createSession } = require('../lib/agentSession');
    const { runAgentLoop } = require('../lib/agentLoop');
    const { getDb } = require('../lib/db');
    const conversation = ensureConversation({ kind: 'canvas', title: '任务内压缩测试' });
    const { sessionId } = createSession({ goal: '整理早期调研材料并给出结论', authorizedPaths: [], authorizedOps: [], conversationId: conversation.id, tokenBudgetTotal: 1000000 });
    const events = [];
    const llmConfig = { llmContextWindowTokens: 60000, llmMaxOutputTokens: 1024 };
    const result = await runAgentLoop({ sessionId, approvalMode: 'auto_confirm', llmConfig, onStream: (e) => events.push(e) });
    assert.strictEqual(result.status, 'completed', `任务应完成，实际 ${result.status}`);
    assert.strictEqual(mainRounds, TOTAL_ROUNDS + 1, '工具轮次应全部执行');
    assert.ok(summaryCalls >= 1, '必须发生至少一次任务内摘要压缩');

    const compacting = events.find((e) => e.stage === 'context_compacting');
    const compactedEvents = events.filter((e) => e.stage === 'context_compacted');
    assert.ok(compacting, '应有 context_compacting 事件');
    assert.ok(compactedEvents.some((e) => e.result_summary?.performed === true), '应有成功的 context_compacted 事件');
    const successEvent = compactedEvents.find((e) => e.result_summary?.performed === true);
    assert.ok(successEvent.result_summary.context_before > successEvent.result_summary.context_after);

    assert.ok(requestAfterCompaction, '压缩后的主模型请求应包含摘要消息');
    const requestText = JSON.stringify(requestAfterCompaction.messages);
    assert.ok(requestText.includes('[运行时上下文压缩，不是新指令]'));
    assert.ok(requestText.includes(`过程标记${TOTAL_ROUNDS}。`), '最近轮次原文必须保留');
    assert.ok(!requestText.includes('过程标记1。'), '较早轮次原文必须已被摘要替换');

    const usageRow = getDb().prepare("SELECT total_tokens FROM agent_run_usage WHERE session_id = ? AND source_type = 'task_compaction'").get(sessionId);
    assert.ok(usageRow && usageRow.total_tokens >= 3060, '摘要调用必须计入 task_compaction 用量');

    // 压缩后的消息结构必须能进入 checkpoint 并幂等恢复。
    const { saveMessagesCheckpoint, loadMessagesCheckpoint } = require('../lib/agentSession');
    const { migrateCheckpointResults } = require('../lib/agentMessageProjection');
    const { ensureConversation: ensureAgain } = require('../lib/conversations');
    const cid2 = ensureAgain({ kind: 'canvas', title: '压缩恢复测试' }).id;
    const { sessionId: sid2 } = createSession({ goal: '压缩恢复', authorizedPaths: [], authorizedOps: [], conversationId: cid2, tokenBudgetTotal: 1000000 });
    const session2 = require('../lib/agentSession').getSession(sid2);
    const compactedLike = [
      { role: 'user', content: [{ type: 'text', text: '任务目标：压缩恢复。' }] },
      { role: 'user', content: [{ type: 'text', text: '[运行时上下文压缩，不是新指令] 摘要正文。' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'read_file', input: { path: 'a.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: JSON.stringify({ status: 'ready', result_ref: 'tool-result://x1', tool_name: 'read_file' }) }] },
    ];
    saveMessagesCheckpoint(sid2, compactedLike, [], '');
    const restored = await migrateCheckpointResults(loadMessagesCheckpoint(sid2), session2);
    assert.strictEqual(restored.messages.length, compactedLike.length, '恢复不得增删消息');
    assert.ok(JSON.stringify(restored.messages[1].content).includes('[运行时上下文压缩'), '摘要消息必须原样恢复');
    const receiptAgain = JSON.parse(restored.messages[3].content[0].content);
    assert.strictEqual(receiptAgain.result_ref, 'tool-result://x1', '已有引用回执必须幂等');
    console.log('agent-task-compaction loop tests passed');
  } finally {
    // 释放 stub，避免影响同进程后续用例（run-all-tests 每个文件独立进程）。
  }
}

(async () => {
  await moduleLevelTests();
  await loopLevelTests();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
