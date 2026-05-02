const assert = require('assert');

function loadPlannerWithMockedLlm(completeChat) {
  const llmPath = require.resolve('../lib/llm');
  const plannerPath = require.resolve('../lib/canvasRequestPlanner');
  const originalLlmModule = require.cache[llmPath];

  delete require.cache[plannerPath];
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: { completeChat },
  };

  const planner = require('../lib/canvasRequestPlanner');

  return {
    planner,
    restore() {
      delete require.cache[plannerPath];
      if (originalLlmModule) {
        require.cache[llmPath] = originalLlmModule;
      } else {
        delete require.cache[llmPath];
      }
    },
  };
}

const article = {
  title: '测试文章',
  blocks: [
    { id: 'b1', type: 'heading', content: '## 引言' },
    { id: 'b2', type: 'paragraph', content: '第一段背景说明。' },
    { id: 'b3', type: 'paragraph', content: '第二段主体内容。' },
    { id: 'b4', type: 'paragraph', content: '关于性能优化的第一种方案。' },
    { id: 'b5', type: 'paragraph', content: '关于性能优化的第二种方案。' },
    { id: 'b6', type: 'paragraph', content: '第四段结尾。' },
  ],
};

async function runTests() {
  const { planner, restore } = loadPlannerWithMockedLlm(async (messages) => {
    const promptText = String(messages?.[messages.length - 1]?.content || '');
    if (promptText.includes('性能优化那一段')) {
      return {
        message: {
          content: JSON.stringify({
            intent: 'edit',
            scope_mode: 'none',
            target_refs: [],
            operation_kind: 'rewrite',
            needs_style: true,
            needs_knowledge: false,
            clarify_needed: true,
            reason_code: 'ambiguous_target_block',
            missing_slots: ['target_location'],
          }),
        },
      };
    }
    return {
      message: {
        content: JSON.stringify({
          intent: 'edit',
          scope_mode: 'single',
          target_refs: ['@b3'],
          operation_kind: 'polish',
          needs_style: true,
          needs_knowledge: false,
          clarify_needed: false,
          reason_code: '',
          missing_slots: [],
        }),
      },
    };
  });

  try {
    const single = await planner.resolveCanvasRequest({
      userInput: '@b3 请把这一段改得更简洁',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(single.intent, 'edit');
    assert.strictEqual(single.scope_mode, 'single');
    assert.deepStrictEqual(single.target_block_ids, ['b3']);
    assert.strictEqual(single.operation_kind, 'shrink');
    assert.strictEqual(single.clarify_needed, false);

    const writeAbove = await planner.resolveCanvasRequest({
      userInput: '把上面的内容写到文档中',
      article,
      conversationHistory: [
        {
          id: 101,
          role: 'assistant',
          content: '这是上一轮已经生成好的正文内容。\n\n它已经整理成了可直接写入文档的两段草稿。',
          meta: {
            target_block_ids: ['b3'],
            scope_mode: 'single',
            canvas_mode: 'text',
            operation_kind: 'discuss',
            source_content_type: 'draft_text',
          },
        },
      ],
      styleMode: 'auto',
    });
    assert.strictEqual(writeAbove.intent, 'edit');
    assert.strictEqual(writeAbove.operation_kind, 'insert');
    assert.strictEqual(writeAbove.clarify_needed, false);
    assert.ok(writeAbove.prefilled_answers.source_content_ref);
    assert.ok(writeAbove.prefilled_answers.target_location);
    assert.strictEqual(writeAbove.write_mode, 'append_new_blocks');

    const writeGenerated = await planner.resolveCanvasRequest({
      userInput: '把刚才生成的内容写进去',
      article,
      conversationHistory: [
        {
          id: 102,
          role: 'assistant',
          content: '这里是一段刚生成的说明内容。\n\n它保持了完整语气，可以直接放回正文。',
          meta: {
            canvas_mode: 'text',
            source_content_type: 'draft_text',
          },
        },
      ],
      styleMode: 'auto',
    });
    assert.strictEqual(writeGenerated.intent, 'edit');
    assert.ok(writeGenerated.prefilled_answers.source_content_ref);
    assert.ok(writeGenerated.target_block_ids.length > 0 || writeGenerated.clarify_needed);

    const introPlan = await planner.resolveCanvasRequest({
      userInput: '改引言那一段，不用 @',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(introPlan.intent, 'edit');
    assert.deepStrictEqual(introPlan.target_block_ids, ['b1']);
    assert.strictEqual(introPlan.scope_mode, 'single');

    const ambiguousPlan = await planner.resolveCanvasRequest({
      userInput: '改一下性能优化那一段',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(ambiguousPlan.intent, 'edit');
    assert.strictEqual(ambiguousPlan.clarify_needed, true);
    assert.strictEqual(ambiguousPlan.clarify_reason, 'ambiguous_target_block');
    assert.ok(ambiguousPlan.missing_slots.includes('target_location'));
    assert.ok(ambiguousPlan.candidate_block_ids.length >= 2);

    const summaryFollowPlan = await planner.resolveCanvasRequest({
      userInput: '按刚才建议改',
      article,
      conversationHistory: [
        {
          role: 'assistant',
          content: '建议先把第二段压紧，再补一个例子。',
          meta: {
            target_block_ids: ['b3'],
            scope_mode: 'single',
            canvas_mode: 'analysis',
            operation_kind: 'polish',
            last_focus_summary: '先把第二段压紧，再补一个例子。',
          },
        },
      ],
      styleMode: 'auto',
    });
    assert.strictEqual(summaryFollowPlan.intent, 'edit');
    assert.deepStrictEqual(summaryFollowPlan.target_block_ids, ['b3']);
    assert.strictEqual(summaryFollowPlan.summary_instruction, '先把第二段压紧，再补一个例子。');

    const discussionPlan = await planner.resolveCanvasRequest({
      userInput: '你觉得上面的内容怎么样',
      article,
      conversationHistory: [
        {
          role: 'assistant',
          content: '这是一段已经生成好的正文草稿。\n\n它还缺一个更具体的例子。',
          meta: {
            canvas_mode: 'text',
            source_content_type: 'draft_text',
          },
        },
      ],
      styleMode: 'auto',
    });
    assert.strictEqual(discussionPlan.primary_intent, 'text');
    assert.strictEqual(discussionPlan.clarify_needed, false);

    const helperPlan = await planner.resolveCanvasRequest({
      userInput: '帮我改一下',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(helperPlan.helper_used, true);
    assert.deepStrictEqual(helperPlan.target_block_ids, ['b3']);
    assert.strictEqual(helperPlan.operation_kind, 'rewrite');
  } finally {
    restore();
  }

  console.log('canvas request planner tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
