const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-projection-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, DB_PATH: path.join(root, 'test.db'), NOTES_DIR: path.join(root, 'notes'), ASSETS_DIR: path.join(root, 'assets') });
async function main() {
  const { ensureConversation } = require('../lib/conversations');
  const { createSession, getSession, saveMessagesCheckpoint, loadMessagesCheckpoint } = require('../lib/agentSession');
  const { migrateCheckpointResults, compactMessages, evictOldReadWindows } = require('../lib/agentMessageProjection');
  const { readToolResult, listToolResults } = require('../lib/agentToolResultStore');
  const cid = ensureConversation({ kind: 'canvas', title: '投影恢复' }).id;
  const { sessionId } = createSession({ goal: '投影恢复', conversationId: cid });
  const session = getSession(sessionId);
  const use = (id, name = 'read_file', input = {}) => ({ type: 'tool_use', id, name, input });
  const result = (id, value) => ({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(value) });
  const original = [{ role: 'user', content: '核对文件' }];
  for (let i = 0; i < 8; i++) original.push({ role: 'assistant', content: [use(`a${i}`), use(`b${i}`)] }, { role: 'user', content: [result(`a${i}`, { content: '中文正文😀'.repeat(1000) }), result(`b${i}`, { operation_set_id: i + 1 })] });
  const projected = await migrateCheckpointResults({ messages: original, toolResultProjectionVersion: 2 }, session);
  assert.ok(!JSON.stringify(projected.messages).includes('中文正文'));
  const receipt = JSON.parse(projected.messages[2].content[0].content);
  assert.ok(receipt.result_ref && receipt.storage_path && receipt.purpose);
  saveMessagesCheckpoint(sessionId, projected.messages, [], '');
  assert.strictEqual(JSON.parse(loadMessagesCheckpoint(sessionId).messages[2].content[0].content).result_ref, receipt.result_ref, '老回执经过检查点保存仍可恢复');
  const catalogue = listToolResults({ conversationId: cid });
  assert.strictEqual(catalogue.items.length, 12);
  assert.ok(catalogue.next_before_id);
  assert.strictEqual(listToolResults({ conversationId: cid + 1 }).items.length, 0);
  const remaining = listToolResults({ conversationId: cid, beforeId: catalogue.next_before_id });
  assert.strictEqual(remaining.items.length, 4);
  const badPointer = await readToolResult({ conversationId: cid, resultRef: receipt.result_ref, jsonPointer: '/missing' });
  assert.strictEqual(badPointer.error, 'JSON_POINTER_NOT_FOUND');
  let offset = 0; let text = ''; let more = true;
  while (more) {
    const chunk = await readToolResult({ conversationId: cid, resultRef: receipt.result_ref, offset, maxBytes: 1024 });
    assert.ok(!chunk.error && !chunk.content.includes('\ufffd'));
    assert.ok(chunk.next_offset > offset);
    text += chunk.content; offset = chunk.next_offset; more = chunk.truncated;
  }
  assert.strictEqual(JSON.parse(text).content, '中文正文😀'.repeat(1000));
  const changed = await migrateCheckpointResults({ messages: [], lastResponseContent: [use('a0')], toolResults: [result('a0', { content: '审批后新结果' })], toolResultProjectionVersion: 2 }, session);
  const restored = JSON.parse(changed.toolResults[0].content);
  assert.notStrictEqual(restored.result_ref, receipt.result_ref);
  const fresh = await readToolResult({ conversationId: cid, resultRef: restored.result_ref, jsonPointer: '/content' });
  assert.ok(fresh.content.includes('审批后新结果'));
  const approval = await migrateCheckpointResults({ messages: [], appliedToolUseId: 'approval', lastResponseContent: [use('approval', 'preview_patch_files')], toolResults: [result('approval', { preview: true })], resumeToolResult: { content: JSON.stringify({ applied: true }) } }, session);
  assert.notStrictEqual(JSON.parse(approval.toolResults[0].content).result_ref, JSON.parse(approval.resumeToolResult.content).result_ref);
  const applied = await readToolResult({ conversationId: cid, resultRef: JSON.parse(approval.resumeToolResult.content).result_ref, jsonPointer: '/applied' });
  assert.strictEqual(applied.content, 'true');
  const questionAnswer = { answered: true, interaction_id: 19, answers: {
    audience: { value: '国内用户购买美区礼品卡（人民币收款）' },
    delivery: { value: '手动采购 + 手动发卡' },
    payment: { value: '支付宝 + 微信支付' },
  } };
  const resumedQuestion = await migrateCheckpointResults({
    messages: [], lastResponseContent: [use('question', 'ask_question_card')],
    toolResults: [result('question', questionAnswer)],
  }, session);
  assert.deepStrictEqual(JSON.parse(resumedQuestion.toolResults[0].content), questionAnswer, '恢复后的模型输入必须直接包含提问卡片答案');
  const resumedAgain = await migrateCheckpointResults({
    messages: [{ role: 'assistant', content: [use('question', 'ask_question_card')] },
      { role: 'user', content: resumedQuestion.toolResults }],
  }, session);
  assert.deepStrictEqual(JSON.parse(resumedAgain.messages[1].content[0].content), questionAnswer, '再次恢复不能把已回答内容压成归档回执');
  const partialQuestion = await migrateCheckpointResults({
    messages: [], lastResponseContent: [use('partial-question', 'ask_question_card')],
    toolResults: [result('partial-question', { answered: true, interaction_id: 21,
      answers: { audience: { value: '国内用户' }, delivery: { skipped: true } } })],
  }, session);
  assert.strictEqual(JSON.parse(partialQuestion.toolResults[0].content).answers.delivery.skipped, true, '跳过状态不能在投影时丢失');
  const cancelledQuestion = await migrateCheckpointResults({
    messages: [], lastResponseContent: [use('cancelled-question', 'ask_question_card')],
    toolResults: [result('cancelled-question', { answered: false, cancelled: true, interaction_id: 20 })],
  }, session);
  assert.strictEqual(JSON.parse(cancelledQuestion.toolResults[0].content).cancelled, true, '取消决定也必须直接送达模型');
  const compact = compactMessages(projected.messages, 1500);
  const pending = new Set();
  for (const message of compact) for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'tool_use') pending.add(block.id);
    if (block.type === 'tool_result') { assert.ok(pending.has(block.tool_use_id), '不能留下孤立工具结果'); pending.delete(block.tool_use_id); }
  }
  assert.strictEqual(pending.size, 0);
  const reads = [{ role: 'user', content: '读取' }, { role: 'assistant', content: [use('r', 'read_tool_result', { result_ref: receipt.result_ref, offset: 0 })] }, { role: 'user', content: [result('r', { result_ref: receipt.result_ref, content: '读窗口正文' })] }, ...projected.messages.slice(1)];
  assert.strictEqual(evictOldReadWindows(reads), reads, '预算充足不能因轮次移除读取内容');
  assert.ok(JSON.stringify(compactMessages(reads,60000)).includes('读窗口正文'));
  const largeReads = structuredClone(reads);
  largeReads[2].content[0].content = JSON.stringify({result_ref:receipt.result_ref,content:'大段正文'.repeat(5000),next_offset:20000});
  const originalJson = JSON.stringify(largeReads);
  const projectedLarge = evictOldReadWindows(largeReads, 10000);
  const evicted = JSON.parse(projectedLarge[2].content[0].content);
  assert.strictEqual(evicted.status, 'tool_result_evicted');
  assert.strictEqual(evicted.read_arguments.result_ref, receipt.result_ref);
  assert.equal(evicted.next_offset,20000);
  assert.equal(JSON.stringify(largeReads),originalJson,'不能修改checkpoint原始消息');
  assert.ok(!JSON.stringify(evicted).includes('大段正文'));
  const smallUnderPressure = structuredClone(largeReads);
  smallUnderPressure.splice(1,0,{role:'assistant',content:[use('directory','list_file_images',{path:'article.md'})]},
    {role:'user',content:[result('directory',{items:[{ref:'note-image://1/reference/0'}]})]});
  const { evictOldToolResults, KEEP_RECENT_TOOL_RESULTS } = require('../lib/agentMessageProjection');
  const projectedSmall = evictOldToolResults(smallUnderPressure, 10000);
  const pressureResults = projectedSmall.flatMap(m=>m.content||[]).filter(b=>b.type==='tool_result');
  const pressureEvicted = pressureResults.filter(b=>JSON.parse(b.content).status==='tool_result_evicted').length;
  assert.equal(pressureResults.length - pressureEvicted, KEEP_RECENT_TOOL_RESULTS, '压力下无论大小只保留最近 N 个工具结果，其余按引用占位');
  console.log('agent message projection tests passed');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
