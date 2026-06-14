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
  let capturedPlannerPrompt = '';
  const { planner, restore } = loadPlannerWithMockedLlm(async (messages) => {
    const promptText = String(messages?.[messages.length - 1]?.content || '');
    capturedPlannerPrompt = messages.map((message) => String(message.content || '')).join('\n');
    if (promptText.includes('性能优化那一段') || promptText.includes('将关于性能优化换成关于缓存设计')) {
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
    if (promptText.includes('写到文档中') || promptText.includes('写进去')) {
      return {
        message: {
          content: JSON.stringify({
            intent: 'edit',
            scope_mode: 'single',
            target_refs: ['@b3'],
            operation_kind: 'insert',
            needs_style: true,
            needs_knowledge: false,
            clarify_needed: false,
            reason_code: '',
            missing_slots: [],
            write_action: 'insert_new_blocks',
            position_relation: 'after_anchor',
          }),
        },
      };
    }
    if (promptText.includes('引言那一段')) {
      return {
        message: {
          content: JSON.stringify({
            intent: 'edit',
            scope_mode: 'single',
            target_refs: ['@b1'],
            operation_kind: 'rewrite',
            needs_style: true,
            needs_knowledge: false,
            clarify_needed: false,
            reason_code: '',
            missing_slots: [],
          }),
        },
      };
    }
    if (promptText.includes('帮我改一下')) {
      return {
        message: {
          content: JSON.stringify({
            intent: 'edit',
            scope_mode: 'single',
            target_refs: ['@b3'],
            operation_kind: 'rewrite',
            needs_style: true,
            needs_knowledge: false,
            clarify_needed: false,
            reason_code: '',
            missing_slots: [],
          }),
        },
      };
    }
    if (promptText.includes('请写一篇关于缓存设计的文章')) {
      return {
        message: {
          content: JSON.stringify({
            intent: 'edit',
            scope_mode: 'global',
            target_refs: [],
            operation_kind: 'expand',
            needs_style: true,
            needs_knowledge: false,
            clarify_needed: false,
            reason_code: '',
            missing_slots: [],
          }),
        },
      };
    }
    if (promptText.includes('@b2 你觉得这段怎么样')) {
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
    }
    return {
      message: {
        content: JSON.stringify({
          intent: 'edit',
          scope_mode: 'single',
          target_refs: ['@b3'],
          operation_kind: promptText.includes('更简洁') ? 'shrink' : 'polish',
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
    assert.ok(!capturedPlannerPrompt.includes('无关键词时优先考虑 edit'));
    assert.ok(capturedPlannerPrompt.includes('没有明确修改动词时，不要因为上下文里有文章块就默认 edit'));
    assert.ok(capturedPlannerPrompt.includes('用户明确引用块'));
    assert.ok(capturedPlannerPrompt.includes('按刚才建议改 @b2'));
    assert.ok(capturedPlannerPrompt.includes('只是询问“怎么样 / 是否清楚 / 有什么建议 / 怎么看”'));

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

    const deterministicSinglePlan = await planner.resolveCanvasRequest({
      userInput: '将第二段主体内容换成新的第二段主体内容',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(deterministicSinglePlan.clarify_needed, false);
    assert.deepStrictEqual(deterministicSinglePlan.target_block_ids, ['b3']);
    assert.ok(deterministicSinglePlan.deterministic_edit);
    assert.strictEqual(deterministicSinglePlan.deterministic_edit.source_text, '第二段主体内容');
    assert.strictEqual(deterministicSinglePlan.deterministic_edit.target_text, '新的第二段主体内容');

    const deterministicWithoutVerbPrefixPlan = await planner.resolveCanvasRequest({
      userInput: '@b4 SQLite 换为 HBase',
      article: {
        ...article,
        blocks: article.blocks.map((block) => (
          block.id === 'b4'
            ? { ...block, content: '技术选型：SQLite，当前用于本地索引。' }
            : block
        )),
      },
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(deterministicWithoutVerbPrefixPlan.clarify_needed, false);
    assert.deepStrictEqual(deterministicWithoutVerbPrefixPlan.target_block_ids, ['b4']);
    assert.ok(deterministicWithoutVerbPrefixPlan.deterministic_edit);
    assert.strictEqual(deterministicWithoutVerbPrefixPlan.deterministic_edit.source_text, 'SQLite');
    assert.strictEqual(deterministicWithoutVerbPrefixPlan.deterministic_edit.target_text, 'HBase');

    const deterministicAmbiguousPlan = await planner.resolveCanvasRequest({
      userInput: '将关于性能优化换成关于缓存设计',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(deterministicAmbiguousPlan.clarify_needed, true);
    assert.strictEqual(deterministicAmbiguousPlan.clarify_reason, 'ambiguous_target_block');

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
    assert.strictEqual(discussionPlan.scope_mode, 'none');
    assert.strictEqual(discussionPlan.operation_kind, 'discuss');
    assert.deepStrictEqual(discussionPlan.target_block_ids, []);
    assert.ok(discussionPlan.decision_path.includes('discussion_intent:text_override'));
    assert.strictEqual(discussionPlan.clarify_needed, false);

    const explicitDiscussionPlan = await planner.resolveCanvasRequest({
      userInput: '@b2 你觉得这段怎么样',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(explicitDiscussionPlan.primary_intent, 'text');
    assert.deepStrictEqual(explicitDiscussionPlan.target_block_ids, ['b2']);
    assert.strictEqual(explicitDiscussionPlan.operation_kind, 'discuss');
    assert.ok(explicitDiscussionPlan.decision_path.includes('discussion_intent:text_override'));

    const helperPlan = await planner.resolveCanvasRequest({
      userInput: '帮我改一下',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(helperPlan.helper_used, true);
    assert.deepStrictEqual(helperPlan.target_block_ids, ['b3']);
    assert.strictEqual(helperPlan.operation_kind, 'rewrite');

    const draftArticlePlan = await planner.resolveCanvasRequest({
      userInput: '请写一篇关于缓存设计的文章',
      article,
      conversationHistory: [],
      styleMode: 'auto',
    });
    assert.strictEqual(draftArticlePlan.intent, 'edit');
    assert.strictEqual(draftArticlePlan.primary_intent, 'edit');
    assert.strictEqual(draftArticlePlan.scope_mode, 'global');
    assert.strictEqual(draftArticlePlan.operation_kind, 'expand');
    assert.strictEqual(draftArticlePlan.clarify_needed, false);
  } finally {
    restore();
  }

  console.log('canvas request planner tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
