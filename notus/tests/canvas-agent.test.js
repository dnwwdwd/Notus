const assert = require('assert');

function withMockedCanvasAgent(mocks = {}) {
  const modulePaths = {
    agent: require.resolve('../lib/canvasAgent'),
    llm: require.resolve('../lib/llm'),
    config: require.resolve('../lib/config'),
    retrieval: require.resolve('../lib/retrieval'),
    style: require.resolve('../lib/style'),
    planner: require.resolve('../lib/canvasRequestPlanner'),
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

  console.log('canvas agent tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
