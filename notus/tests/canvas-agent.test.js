const assert = require('assert');

function withMockedCanvasAgent(mocks = {}) {
  const modulePaths = {
    agent: require.resolve('../lib/canvasAgent'),
    llm: require.resolve('../lib/llm'),
    config: require.resolve('../lib/config'),
    retrieval: require.resolve('../lib/retrieval'),
    style: require.resolve('../lib/style'),
    planner: require.resolve('../lib/canvasRequestPlanner'),
    logger: require.resolve('../lib/logger'),
  };

  const originals = Object.fromEntries(
    Object.entries(modulePaths).map(([key, value]) => [key, require.cache[value]])
  );

  delete require.cache[modulePaths.agent];
  delete require.cache[modulePaths.planner];

  require.cache[modulePaths.llm] = {
    id: modulePaths.llm,
    filename: modulePaths.llm,
    loaded: true,
    exports: {
      completeChat: mocks.completeChat || (async () => ({ message: { content: '{}' } })),
      streamChat: mocks.streamChat || (async () => ({ text: '' })),
    },
  };
  require.cache[modulePaths.config] = {
    id: modulePaths.config,
    filename: modulePaths.config,
    loaded: true,
    exports: {
      getEffectiveConfig: mocks.getEffectiveConfig || (() => ({
        canvasEnableArticleAnalysis: false,
        canvasGlobalEditSoftMaxBlocks: 12,
        canvasGlobalEditHardMaxBlocks: 20,
      })),
    },
  };
  require.cache[modulePaths.retrieval] = {
    id: modulePaths.retrieval,
    filename: modulePaths.retrieval,
    loaded: true,
    exports: {
      retrieveKnowledgeContext: mocks.retrieveKnowledgeContext || (async () => ({ sections: [], chunks: [] })),
    },
  };
  require.cache[modulePaths.style] = {
    id: modulePaths.style,
    filename: modulePaths.style,
    loaded: true,
    exports: {
      getStyleContext: mocks.getStyleContext || (async () => null),
      STYLE_ELIGIBLE_TYPES: new Set(['paragraph', 'list', 'blockquote']),
    },
  };
  require.cache[modulePaths.logger] = {
    id: modulePaths.logger,
    filename: modulePaths.logger,
    loaded: true,
    exports: {
      createLogger: mocks.createLogger || (() => ({
        child() { return this; },
        debug() {},
        info() {},
        warn() {},
        error() {},
      })),
    },
  };

  const agent = require('../lib/canvasAgent');

  return {
    agent,
    restore() {
      delete require.cache[modulePaths.agent];
      delete require.cache[modulePaths.planner];
      Object.entries(modulePaths).forEach(([key, value]) => {
        if (originals[key]) require.cache[value] = originals[key];
        else delete require.cache[value];
      });
    },
  };
}

function buildParagraphArticle(count) {
  return {
    title: '测试文章',
    blocks: Array.from({ length: count }).map((_, index) => ({
      id: `b${index + 1}`,
      type: 'paragraph',
      content: `第 ${index + 1} 段内容`,
    })),
  };
}

function parseBlockSnapshotsFromPrompt(prompt = []) {
  const text = String(prompt?.[prompt.length - 1]?.content || '');
  return Array.from(text.matchAll(/<block ref="@b\d+" id="([^"]+)" type="[^"]+">\n(?:heading_path: .*?\n)?([\s\S]*?)\n<\/block>/g))
    .map((match) => ({
      id: match[1],
      content: match[2],
    }));
}

async function runTests() {
  {
    const warnings = [];
    const article = {
      title: '测试文章',
      blocks: [
        { id: 'b1', type: 'paragraph', content: '技术选型：SQLite，当前用于本地索引。' },
      ],
    };
    const { agent, restore } = withMockedCanvasAgent({
      createLogger: () => ({
        child() { return this; },
        debug() {},
        info() {},
        warn(event, payload) {
          warnings.push({ event, payload });
        },
        error() {},
      }),
      completeChat: async () => ({
        message: {
          content: '我建议直接把 SQLite 换成 HBase，然后再补充索引差异说明。',
        },
      }),
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '@b1 SQLite 换为 HBase',
        article,
        conversationHistory: [],
        forcedPlan: {
          intent: 'edit',
          primary_intent: 'edit',
          scope_mode: 'single',
          target_block_ids: ['b1'],
          operation_kind: 'rewrite',
          helper_used: false,
          needs_style: false,
          needs_knowledge: false,
          clarify_needed: false,
        },
      });
      assert.strictEqual(result.text, 'AI 返回格式异常，请重试。');
      assert.deepStrictEqual(result.operations, []);
      assert.strictEqual(warnings.length, 1);
      assert.strictEqual(warnings[0].event, 'canvas.operation_json.invalid');
      assert.strictEqual(warnings[0].payload.scope_mode, 'single');
      assert.strictEqual(warnings[0].payload.operation_kind, 'rewrite');
      assert.deepStrictEqual(warnings[0].payload.allowed_block_ids, ['b1']);
      assert.ok(warnings[0].payload.raw_content_preview.includes('SQLite 换成 HBase'));
    } finally {
      restore();
    }
  }

  {
    const { agent, restore } = withMockedCanvasAgent({
      streamChat: async () => {
        throw new Error('analysis disabled path should not stream');
      },
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '请分析这篇文章的结构和逻辑',
        article: buildParagraphArticle(4),
        conversationHistory: [],
        forcedPlan: {
          intent: 'analyze',
          primary_intent: 'analyze',
          scope_mode: 'none',
          target_block_ids: [],
          operation_kind: 'analyze',
          helper_used: false,
          needs_style: false,
          needs_knowledge: false,
          clarify_needed: false,
        },
      });
      assert.strictEqual(result.canvasMode, 'text');
      assert.strictEqual(result.fallbackReason, 'analysis_disabled');
      assert.strictEqual(result.operations.length, 0);
    } finally {
      restore();
    }
  }

  {
    let capturedPrompt = null;
    const article = buildParagraphArticle(3);
    const { agent, restore } = withMockedCanvasAgent({
      getStyleContext: async () => ({
        mode: 'auto',
        profile: { summary: '整体直接、简洁。' },
        dimensions: { tone: '直接', sentence_style: '短句为主' },
        signature_phrases: ['先说结论'],
        reference_excerpts: [],
      }),
      completeChat: async (prompt) => {
        capturedPrompt = prompt;
        return {
          message: {
            content: JSON.stringify({
              summary: '已按上一轮建议生成修改。',
              operations: [
                { op: 'replace', block_id: 'b2', old: '第 2 段内容', new: '第 2 段内容（已按建议收紧）' },
              ],
            }),
          },
        };
      },
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '按刚才建议改 @b2',
        article,
        conversationHistory: [
          {
            role: 'assistant',
            content: '建议先把第二段压紧，再补一个例子。',
            meta: {
              target_block_ids: ['b2'],
              scope_mode: 'single',
              canvas_mode: 'analysis',
              operation_kind: 'polish',
              last_focus_summary: '先把第二段压紧，再补一个例子。',
            },
          },
        ],
        forcedPlan: {
          intent: 'edit',
          primary_intent: 'edit',
          scope_mode: 'single',
          target_block_ids: ['b2'],
          operation_kind: 'polish',
          helper_used: false,
          needs_style: true,
          needs_knowledge: false,
          clarify_needed: false,
          summary_instruction: '先把第二段压紧，再补一个例子。',
        },
      });
      const lastMessage = String(capturedPrompt?.[capturedPrompt.length - 1]?.content || '');
      assert.ok(lastMessage.includes('额外要求：先把第二段压紧，再补一个例子。'));
      assert.strictEqual(result.operationKind, 'polish');
      assert.strictEqual(result.focusSummary, '已按上一轮建议生成修改。');
    } finally {
      restore();
    }
  }

  {
    let capturedPrompt = null;
    const longContent = [
      '开头内容用于确认目标块没有被截断。',
      ...Array.from({ length: 90 }).map((_, index) => `第 ${index + 1} 行正文保持不变。`),
      '结尾内容用于确认目标块仍是完整全文。',
    ].join('\n');
    const article = {
      title: '长块文章',
      blocks: [
        { id: 'b1', type: 'paragraph', content: '前一段上下文' },
        { id: 'b2', type: 'paragraph', content: longContent },
        { id: 'b3', type: 'paragraph', content: '后一段上下文' },
      ],
    };
    const { agent, restore } = withMockedCanvasAgent({
      completeChat: async (prompt) => {
        capturedPrompt = prompt;
        return {
          message: {
            content: JSON.stringify({
              summary: '已局部调整长块。',
              operations: [
                {
                  op: 'replace',
                  block_id: 'b2',
                  old: longContent,
                  new: longContent.replace('第 45 行正文保持不变。', '第 45 行正文已调整。'),
                },
              ],
            }),
          },
        };
      },
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '把 @b2 第 45 行改得更准确',
        article,
        conversationHistory: [],
        forcedPlan: {
          intent: 'edit',
          primary_intent: 'edit',
          scope_mode: 'single',
          target_block_ids: ['b2'],
          operation_kind: 'rewrite',
          helper_used: false,
          needs_style: false,
          needs_knowledge: false,
          clarify_needed: false,
        },
      });
      const promptText = capturedPrompt.map((message) => message.content).join('\n');
      const blockSnapshots = parseBlockSnapshotsFromPrompt(capturedPrompt);
      const targetSnapshot = blockSnapshots.find((block) => block.id === 'b2');
      assert.ok(promptText.includes('replace.new 必须是目标块修改后的完整全文'));
      assert.ok(promptText.includes('未修改的文字、换行、列表顺序和标点必须逐字保留'));
      assert.ok(promptText.includes('目标块必须按完整正文处理；非目标块只用于理解上下文'));
      assert.ok(promptText.includes('用户只要求修改第二句时'));
      assert.ok(promptText.includes('如果无法保证 old/new 是完整目标块全文'));
      assert.strictEqual(targetSnapshot.content, longContent);
      assert.strictEqual(result.operations[0].old, longContent);
      assert.ok(result.operations[0].new.includes('第 44 行正文保持不变。'));
      assert.ok(result.operations[0].new.includes('第 45 行正文已调整。'));
      assert.ok(result.operations[0].new.includes('第 46 行正文保持不变。'));
    } finally {
      restore();
    }
  }

  {
    const article = {
      title: '测试文章',
      blocks: [
        { id: 'b1', type: 'paragraph', content: '第一段' },
        { id: 'b2', type: 'paragraph', content: '第二段内容，包含更多解释。' },
      ],
    };
    const { agent, restore } = withMockedCanvasAgent({
      completeChat: async () => ({
        message: {
          content: JSON.stringify({
            summary: '已按第二段生成修改。',
            operations: [
              { op: 'replace', block_id: 'b2', old: '第二段内容', new: '第二段内容，包含更多解释。（已精简）' },
            ],
          }),
        },
      }),
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '精简 @b2',
        article,
        conversationHistory: [],
        forcedPlan: {
          intent: 'edit',
          primary_intent: 'edit',
          scope_mode: 'single',
          target_block_ids: ['b2'],
          operation_kind: 'rewrite',
          helper_used: false,
          needs_style: false,
          needs_knowledge: false,
          clarify_needed: false,
        },
      });
      assert.strictEqual(result.operations.length, 1);
      assert.strictEqual(
        result.operations[0].old,
        '第二段内容，包含更多解释。',
        'operation.old should be normalized to the live block content when model only returns a partial old snapshot'
      );
    } finally {
      restore();
    }
  }

  {
    let callCount = 0;
    const events = [];
    const article = buildParagraphArticle(13);
    const { agent, restore } = withMockedCanvasAgent({
      getStyleContext: async () => ({
        mode: 'auto',
        profile: { summary: '偏克制。' },
        dimensions: {},
        signature_phrases: [],
        reference_excerpts: [],
      }),
      completeChat: async (prompt) => {
        callCount += 1;
        const blocks = parseBlockSnapshotsFromPrompt(prompt);
        return {
          message: {
            content: JSON.stringify({
              summary: `第 ${callCount} 批修改已生成。`,
              operations: blocks.map((block) => ({
                op: 'replace',
                block_id: block.id,
                old: block.content,
                new: `${block.content}（已统一语气）`,
              })),
            }),
          },
        };
      },
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '请统一全文语气，保持原意不变',
        article,
        conversationHistory: [],
        forcedPlan: {
          intent: 'edit',
          primary_intent: 'edit',
          scope_mode: 'global',
          target_block_ids: [],
          operation_kind: 'rewrite',
          helper_used: false,
          needs_style: true,
          needs_knowledge: false,
          clarify_needed: false,
        },
      }, (event) => events.push(event));
      assert.strictEqual(result.canvasMode, 'edit');
      assert.strictEqual(result.scopeMode, 'global');
      assert.strictEqual(result.operations.length, 13);
      assert.strictEqual(callCount, 4);
      assert.strictEqual(events[0].type, 'batch_start');
      assert.strictEqual(events.filter((event) => event.type === 'batch_progress').length, 4);
      assert.strictEqual(events[events.length - 1].type, 'batch_done');
    } finally {
      restore();
    }
  }

  {
    const { agent, restore } = withMockedCanvasAgent({
      getEffectiveConfig: () => ({
        canvasEnableArticleAnalysis: false,
        canvasGlobalEditSoftMaxBlocks: 12,
        canvasGlobalEditHardMaxBlocks: 40,
      }),
      completeChat: async () => {
        throw new Error('global limit refusal should not call llm');
      },
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '请统一全文语气，保持原意不变',
        article: buildParagraphArticle(25),
        conversationHistory: [],
        forcedPlan: {
          intent: 'edit',
          primary_intent: 'edit',
          scope_mode: 'global',
          target_block_ids: [],
          operation_kind: 'rewrite',
          helper_used: false,
          needs_style: false,
          needs_knowledge: false,
          clarify_needed: false,
        },
      });
      assert.strictEqual(result.canvasMode, 'clarify');
      assert.strictEqual(result.fallbackReason, 'global_edit_call_limit');
    } finally {
      restore();
    }
  }

  {
    const article = buildParagraphArticle(3);
    const { agent, restore } = withMockedCanvasAgent({
      completeChat: async () => {
        throw new Error('frozen source content should not call llm');
      },
      streamChat: async () => {
        throw new Error('frozen source content should not stream');
      },
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '把上面的内容写到文档中',
        article,
        conversationHistory: [],
        forcedPlan: {
          intent: 'edit',
          scope_mode: 'single',
          target_block_ids: ['b2'],
          operation_kind: 'insert',
          answer_slots: {
            target_location: {
              question_id: 'target_location',
              slot: 'target_location',
              value: 'block:b2',
              block_id: 'b2',
              label: '第 2 段',
            },
            write_mode: {
              question_id: 'write_mode',
              slot: 'write_mode',
              value: 'append_new_blocks',
              label: '追加新段落',
            },
            source_content_ref: {
              question_id: 'source_content_ref',
              slot: 'source_content_ref',
              value: 'previous_assistant_message',
              label: '上一条助手回复',
              source_content_snapshot: '这是第一段。\n\n这是第二段。',
            },
          },
          target_location: {
            question_id: 'target_location',
            slot: 'target_location',
            value: 'block:b2',
            block_id: 'b2',
            label: '第 2 段',
          },
          write_mode: 'append_new_blocks',
          source_content_snapshot: '这是第一段。\n\n这是第二段。',
          clarify_needed: false,
          helper_used: false,
          needs_style: false,
          needs_knowledge: false,
        },
      });
      assert.strictEqual(result.canvasMode, 'edit');
      assert.strictEqual(result.operations.length, 2);
      assert.strictEqual(result.operations[0].op, 'insert');
      assert.strictEqual(result.operations[0].block_id, 'b2');
      assert.strictEqual(result.operations[0].new, '这是第一段。');
      assert.strictEqual(result.operations[1].new, '这是第二段。');
    } finally {
      restore();
    }
  }

  {
    let called = false;
    const article = {
      title: '测试文章',
      blocks: [
        { id: 'b1', type: 'paragraph', content: '第一段' },
        { id: 'b2', type: 'paragraph', content: '第二段内容' },
      ],
    };
    const { agent, restore } = withMockedCanvasAgent({
      completeChat: async () => {
        called = true;
        throw new Error('deterministic edit should not call llm');
      },
      streamChat: async () => {
        throw new Error('deterministic edit should not stream');
      },
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '将第二段内容换成第二段内容（已精简）',
        article,
        conversationHistory: [],
        forcedPlan: {
          intent: 'edit',
          primary_intent: 'edit',
          scope_mode: 'single',
          target_block_ids: ['b2'],
          operation_kind: 'rewrite',
          helper_used: false,
          needs_style: false,
          needs_knowledge: false,
          clarify_needed: false,
          deterministic_edit: {
            source_text: '第二段内容',
            target_text: '第二段内容（已精简）',
          },
        },
      });
      assert.strictEqual(called, false);
      assert.strictEqual(result.operations.length, 1);
      assert.strictEqual(result.operations[0].op, 'replace');
      assert.strictEqual(result.operations[0].block_id, 'b2');
      assert.strictEqual(result.operations[0].new, '第二段内容（已精简）');
    } finally {
      restore();
    }
  }

  {
    const article = {
      title: '测试文章',
      blocks: [
        { id: 'b1', type: 'paragraph', content: '第一段' },
        { id: 'b2', type: 'paragraph', content: '第二段内容' },
      ],
    };
    const { agent, restore } = withMockedCanvasAgent({
      completeChat: async () => ({
        message: {
          content: JSON.stringify({
            summary: '已按要求修改。',
            operations: [
              { op: 'replace', block_id: 'b1', old: '第一段', new: '第一段（已修改）' },
            ],
          }),
        },
      }),
    });
    try {
      const result = await agent.runCanvasAgent({
        userInput: '精简 @b2',
        article,
        conversationHistory: [],
        forcedPlan: {
          intent: 'edit',
          primary_intent: 'edit',
          scope_mode: 'single',
          target_block_ids: ['b2'],
          operation_kind: 'rewrite',
          helper_used: false,
          needs_style: false,
          needs_knowledge: false,
          clarify_needed: false,
        },
      });
      assert.strictEqual(result.operations.length, 1);
      assert.strictEqual(result.operations[0].block_id, 'b2');
      assert.strictEqual(result.operations[0].old, '第二段内容');
    } finally {
      restore();
    }
  }

  console.log('canvas agent tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
