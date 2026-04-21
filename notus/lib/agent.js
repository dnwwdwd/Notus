const { hybridSearch } = require('./retrieval');
const { completeChat } = require('./llm');
const { buildAgentSystemPrompt } = require('./prompt');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '搜索知识库中的相关内容',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topK: { type: 'integer', default: 5 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_style_samples',
      description: '获取相近主题的风格样本',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' }, k: { type: 'integer', default: 3 } },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_outline',
      description: '返回一组简单的大纲块',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_block',
      description: '为某个块起草替换内容',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string' },
          instruction: { type: 'string' },
        },
        required: ['block_id', 'instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'expand_block',
      description: '扩写一个块',
      parameters: {
        type: 'object',
        properties: { block_id: { type: 'string' } },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shrink_block',
      description: '压缩一个块',
      parameters: {
        type: 'object',
        properties: { block_id: { type: 'string' } },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'polish_style',
      description: '按风格润色一个块',
      parameters: {
        type: 'object',
        properties: { block_id: { type: 'string' }, instruction: { type: 'string' } },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_block',
      description: '在某个块后插入新块',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string' },
          content: { type: 'string' },
          type: { type: 'string' },
        },
        required: ['block_id', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_block',
      description: '删除某个块',
      parameters: {
        type: 'object',
        properties: { block_id: { type: 'string' } },
        required: ['block_id'],
      },
    },
  },
];

function findBlock(article, blockId) {
  return (article.blocks || []).find((block) => block.id === blockId);
}

function safeJsonParse(content) {
  if (!content) return null;
  const text = String(content).trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```json\s*([\s\S]+?)```/i) || text.match(/```([\s\S]+?)```/i);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function generateOperation(article, blockId, instruction, styleSamples = [], mode = 'replace') {
  const block = findBlock(article, blockId);
  if (!block && mode !== 'insert') throw new Error('BLOCK_NOT_FOUND');

  const messages = [
    {
      role: 'system',
      content: [
        '你是 Markdown 文章协作助手。',
        '只输出 JSON，不要输出解释。',
        '返回格式：{"op":"replace|insert|delete","block_id":"...","old":"...","new":"...","position":"after","type":"paragraph"}。',
        '如果是 replace，必须带 old 和 new。',
        '如果是 insert，必须带 block_id、position、type、new。',
        '如果是 delete，必须带 block_id 和 old。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        article_title: article.title,
        block,
        instruction,
        mode,
        style_samples: styleSamples.map((sample) => sample.content || sample),
      }),
    },
  ];

  const reply = await completeChat(messages);
  const parsed = safeJsonParse(reply.content);
  if (!parsed?.op) throw new Error('操作结果解析失败');
  return parsed;
}

async function executeTool(name, args, context) {
  if (name === 'search_knowledge') {
    const chunks = await hybridSearch(args.query, { topK: args.topK || 5 });
    return { chunks };
  }

  if (name === 'get_style_samples') {
    const samples = await hybridSearch(args.topic, {
      topK: args.k || 3,
      fileIds: context.styleFileIds,
    });
    return { samples };
  }

  if (name === 'get_outline') {
    return {
      outline: [
        { id: 'b_outline_1', type: 'heading', content: `# ${args.topic}` },
        { id: 'b_outline_2', type: 'paragraph', content: `围绕“${args.topic}”展开背景、问题和结论。` },
      ],
    };
  }

  if (name === 'draft_block') {
    return { operation: await generateOperation(context.article, args.block_id, args.instruction, context.styleSamples) };
  }

  if (name === 'expand_block') {
    return { operation: await generateOperation(context.article, args.block_id, '扩写这段内容，补足论证和细节。', context.styleSamples) };
  }

  if (name === 'shrink_block') {
    return { operation: await generateOperation(context.article, args.block_id, '精简这段内容，保留核心信息。', context.styleSamples) };
  }

  if (name === 'polish_style') {
    return { operation: await generateOperation(context.article, args.block_id, args.instruction || '按已有风格润色这段内容。', context.styleSamples) };
  }

  if (name === 'insert_block') {
    return {
      operation: {
        op: 'insert',
        block_id: args.block_id,
        position: 'after',
        type: args.type || 'paragraph',
        new: args.content,
      },
    };
  }

  if (name === 'delete_block') {
    const block = findBlock(context.article, args.block_id);
    return {
      operation: {
        op: 'delete',
        block_id: args.block_id,
        old: block?.content || '',
      },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function runAgent({ userInput, article, styleSource }, onStream) {
  const context = {
    article,
    styleSamples: [],
    styleFileIds: Array.isArray(styleSource?.file_ids)
      ? styleSource.file_ids.map((item) => Number(item)).filter((item) => Number.isFinite(item))
      : [],
    citations: [],
    operations: [],
  };

  const initialMessages = [
    {
      role: 'system',
      content: [
        buildAgentSystemPrompt(article.blocks || [], ''),
        '你可以调用工具。最终必须只输出 JSON：{"operations":[...],"citations":[...]}。',
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        user_input: userInput,
        article_title: article.title,
        style_source: styleSource,
      }),
    },
  ];

  const history = [...initialMessages];
  if (onStream) onStream({ type: 'thinking', text: '正在分析你的创作请求…' });

  for (let round = 0; round < 4; round += 1) {
    const reply = await completeChat(history, { tools: TOOLS });

    if (reply.tool_calls?.length) {
      history.push({
        role: 'assistant',
        content: reply.content || '',
        tool_calls: reply.tool_calls,
      });

      for (const call of reply.tool_calls) {
        const args = safeJsonParse(call.function.arguments) || {};
        if (onStream) onStream({ type: 'tool_call', name: call.function.name, args });
        const result = await executeTool(call.function.name, args, context);
        if (result.samples) context.styleSamples = result.samples;
        if (result.chunks) context.citations.push(...result.chunks);
        if (result.operation) context.operations.push(result.operation);
        if (onStream) onStream({ type: 'tool_result', name: call.function.name, data: result });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    const parsed = safeJsonParse(reply.content);
    if (parsed?.operations || parsed?.citations) {
      return {
        operations: parsed.operations || context.operations,
        citations: parsed.citations || context.citations,
      };
    }

    return {
      operations: context.operations,
      citations: context.citations,
      text: reply.content || '',
    };
  }

  return {
    operations: context.operations,
    citations: context.citations,
  };
}

module.exports = {
  TOOLS,
  runAgent,
};
