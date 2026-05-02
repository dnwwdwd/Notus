const assert = require('assert');
const {
  buildInteractionAnswerSummary,
  buildResumePlanFromInteraction,
  normalizeInteractionResponse,
} = require('../lib/conversationInteractions');

const baseInteraction = {
  id: 11,
  conversation_id: 3,
  status: 'pending',
  payload: {
    source_message_id: 201,
    source_kind: 'assistant_message',
    source_content_snapshot: '上一轮生成的正文。',
    source_content_digest: 'x',
    candidate_block_ids: ['b2'],
    article_blocks: [
      { id: 'b1', index: 1, type: 'paragraph', content: '第一段' },
      { id: 'b2', index: 2, type: 'paragraph', content: '第二段' },
      { id: 'b3', index: 3, type: 'paragraph', content: '第三段' },
    ],
    prefilled_answers: {
      source_content_ref: {
        question_id: 'source_content_ref',
        slot: 'source_content_ref',
        value: 'previous_assistant_message',
        label: '上一条助手回复',
        source_message_id: 201,
        source_kind: 'assistant_message',
        source_content_snapshot: '上一轮生成的正文。',
        source_content_digest: 'x',
      },
    },
    questions: [
      {
        id: 'target_location',
        slot: 'target_location',
        type: 'single_select',
        required: true,
        options: [
          { id: 'document_end', label: '文末', description: '写到最后' },
          { id: 'block:b2', label: '第 2 段', description: '写到第二段' },
        ],
        allow_custom: true,
      },
      {
        id: 'write_mode',
        slot: 'write_mode',
        type: 'single_select',
        required: true,
        options: [
          { id: 'append_new_blocks', label: '追加新段落', description: '' },
          { id: 'replace_target', label: '替换目标段落', description: '' },
        ],
        allow_custom: false,
      },
    ],
  },
  response: null,
};

function runTests() {
  const partial = normalizeInteractionResponse(baseInteraction, {
    raw_text: '写到第 2 段后',
  });
  assert.strictEqual(partial.resolution_status, 'partial');
  assert.strictEqual(partial.answers.target_location.block_id, 'b2');
  assert.ok(partial.missing_slots.includes('write_mode'));

  const resolved = normalizeInteractionResponse({
    ...baseInteraction,
    response: partial,
  }, {
    raw_text: '追加成新段落',
  });
  assert.strictEqual(resolved.resolution_status, 'resolved');
  assert.strictEqual(resolved.answers.write_mode.value, 'append_new_blocks');

  const summary = buildInteractionAnswerSummary(baseInteraction, resolved);
  assert.ok(summary.includes('内容来源=上一条回复'));
  assert.ok(summary.includes('写入位置=第 2 段'));
  assert.ok(summary.includes('写入方式=追加新段落'));

  const resumePlan = buildResumePlanFromInteraction({
    ...baseInteraction,
    response: resolved,
  });
  assert.strictEqual(resumePlan.operation_kind, 'insert');
  assert.deepStrictEqual(resumePlan.target_block_ids, ['b2']);
  assert.strictEqual(resumePlan.write_mode, 'append_new_blocks');
  assert.strictEqual(resumePlan.source_content_snapshot, '上一轮生成的正文。');

  const discussInteraction = {
    ...baseInteraction,
    payload: {
      ...baseInteraction.payload,
      questions: [
        {
          id: 'primary_intent',
          slot: 'primary_intent',
          type: 'single_select',
          required: true,
          options: [
            { id: 'edit', label: '直接改文档', description: '' },
            { id: 'text', label: '继续讨论', description: '' },
            { id: 'analyze', label: '文章分析', description: '' },
          ],
        },
        ...baseInteraction.payload.questions,
      ],
    },
  };
  const discussResponse = normalizeInteractionResponse(discussInteraction, {
    raw_text: '继续讨论，不要直接改文档',
  });
  assert.strictEqual(discussResponse.resolution_status, 'resolved');
  assert.strictEqual(discussResponse.answers.primary_intent.value, 'text');
  assert.deepStrictEqual(discussResponse.missing_slots, []);

  const discussSummary = buildInteractionAnswerSummary(discussInteraction, discussResponse);
  assert.ok(discussSummary.includes('主意图=继续讨论'));
  assert.ok(!discussSummary.includes('写入位置='));

  const discussPlan = buildResumePlanFromInteraction({
    ...discussInteraction,
    response: discussResponse,
  });
  assert.strictEqual(discussPlan.primary_intent, 'text');
  assert.strictEqual(discussPlan.intent, 'text');
  assert.strictEqual(discussPlan.operation_kind, 'discuss');

  console.log('conversation interactions tests passed');
}

runTests();
