const { getEffectiveConfig } = require('./config');
const { retrieveKnowledgeContext } = require('./retrieval');
const { completeChat, streamChat } = require('./llm');
const {
  buildHistorySummary,
  sanitizeKnowledgeSections,
} = require('./contextCompaction');
const { getStyleContext, STYLE_ELIGIBLE_TYPES } = require('./style');
const { resolveCanvasRequest } = require('./canvasRequestPlanner');
const {
  buildCanvasEditPrompt,
  buildCanvasTextPrompt,
  buildCanvasAnalysisPrompt,
} = require('./prompt');
const {
  sumUsageRecords,
  trimTextToTokenBudget,
} = require('./llmBudget');

function safeJsonParse(content) {
  if (!content) return null;
  const text = String(content).trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```json\s*([\s\S]+?)```/i) || text.match(/```([\s\S]+?)```/i);
    if (!match) return null;
    try {
      return JSON.parse(match[1].trim());
    } catch {
      return null;
    }
  }
}

function findBlock(article, blockId) {
  return (article?.blocks || []).find((block) => block.id === blockId);
}

function getBlockIndex(article, blockId) {
  return (article?.blocks || []).findIndex((block) => block.id === blockId);
}

function blockRefLabel(article, blockId) {
  const index = getBlockIndex(article, blockId);
  return index >= 0 ? `@b${index + 1}` : blockId;
}

function normalizeStringArray(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function buildTelemetry() {
  return {
    usages: [],
    budgets: [],
    compacted: false,
  };
}

function pushReplyTelemetry(telemetry, reply) {
  if (!telemetry || !reply) return;
  if (reply.usage) telemetry.usages.push(reply.usage);
  if (reply.budget) telemetry.budgets.push(reply.budget);
  if (reply.compacted) telemetry.compacted = true;
}

function getLastBudget(telemetry) {
  return telemetry?.budgets?.[telemetry.budgets.length - 1] || null;
}

function normalizeOperation(article, operation, options = {}) {
  if (!operation || typeof operation !== 'object') throw new Error('操作结果解析失败');
  const normalized = { ...operation };
  const allowedBlockIds = Array.isArray(options.allowedBlockIds) ? options.allowedBlockIds : [];
  const resolvedBlockId = operation.block_id;

  if (normalized.op !== 'insert' && !findBlock(article, resolvedBlockId)) {
    throw new Error('BLOCK_NOT_FOUND');
  }
  if (allowedBlockIds.length > 0 && resolvedBlockId && !allowedBlockIds.includes(resolvedBlockId)) {
    throw new Error('AI 只能修改当前选中的块');
  }
  if (resolvedBlockId) {
    normalized.block_id = resolvedBlockId;
  }
  if ((normalized.op === 'replace' || normalized.op === 'delete') && !normalized.old) {
    normalized.old = findBlock(article, normalized.block_id)?.content || '';
  }
  if (typeof normalized.new === 'string') {
    normalized.new = normalized.new.replace(/\r\n/g, '\n');
  }
  return normalized;
}

function normalizeOperations(article, payload, options = {}) {
  const operations = Array.isArray(payload?.operations)
    ? payload.operations
    : payload?.operation
      ? [payload.operation]
      : payload?.op
        ? [payload]
        : [];

  return operations
    .map((operation) => normalizeOperation(article, operation, options))
    .filter(Boolean);
}

function selectNeighborContext(article, targetBlockIds = [], maxBlocks = 8) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  if (blocks.length === 0) return [];
  if (!Array.isArray(targetBlockIds) || targetBlockIds.length === 0) {
    return blocks.slice(0, maxBlocks);
  }
  const indices = new Set();
  targetBlockIds.forEach((blockId) => {
    const index = getBlockIndex(article, blockId);
    if (index < 0) return;
    indices.add(index);
    if (index > 0) indices.add(index - 1);
    if (index < blocks.length - 1) indices.add(index + 1);
  });
  return [...indices]
    .sort((left, right) => left - right)
    .slice(0, maxBlocks)
    .map((index) => blocks[index])
    .filter(Boolean);
}

function trimBlocks(blocks = [], tokenBudget = 220) {
  return (Array.isArray(blocks) ? blocks : []).map((block) => ({
    ...block,
    content: trimTextToTokenBudget(block.content || '', tokenBudget),
  }));
}

function getEditableBlocks(article) {
  return (Array.isArray(article?.blocks) ? article.blocks : []).filter((block) => STYLE_ELIGIBLE_TYPES.has(block.type));
}

function buildKnowledgeContext(result) {
  return sanitizeKnowledgeSections(result?.sections || [], {
    sectionLimit: 3,
    quoteLimit: 2,
    quoteTokenBudget: 110,
    contentTokenBudget: 220,
  });
}

function buildSummaryFromOperations(article, operations = []) {
  if (!Array.isArray(operations) || operations.length === 0) return '本轮没有生成可应用的修改。';
  const previews = operations.slice(0, 3).map((operation) => {
    const ref = blockRefLabel(article, operation.block_id);
    if (operation.op === 'delete') return `删除 ${ref}`;
    if (operation.op === 'insert') return `在 ${ref} 附近新增内容`;
    return `改写 ${ref}`;
  });
  const more = operations.length > 3 ? `等 ${operations.length} 项修改` : `${operations.length} 项修改`;
  return `已生成 ${more}：${previews.join('，')}。`;
}

function buildFocusSummary(text = '') {
  return trimTextToTokenBudget(String(text || '').trim(), 90, ' …');
}

function buildDecisionContext(plan = {}, options = {}) {
  const shouldShowDecisionSummary = Boolean(
    plan.decision_summary
    && (
      options.forceShowDecisionSummary
      || plan.show_decision_summary
      || plan.clarify_needed
      || plan.risk_level === 'high'
      || plan.correction_state
    )
  );

  return {
    primaryIntent: String(plan.primary_intent || plan.intent || 'text'),
    intentConfidence: Number(plan.intent_confidence || 0) || 0,
    riskLevel: String(plan.risk_level || 'low'),
    decisionSummary: String(plan.decision_summary || '').trim(),
    aiArbitrationMode: String(plan.ai_arbitration_mode || 'none'),
    sourceContentType: String(plan.source_content_type || '').trim(),
    targetAnchor: plan.target_anchor || (
      plan.target_location
        ? {
          value: plan.target_location.value,
          label: plan.target_location.label,
          block_id: plan.target_location.block_id || null,
        }
        : null
    ),
    positionRelation: String(plan.position_relation || '').trim(),
    writeAction: String(plan.write_action || '').trim(),
    correctionState: plan.correction_state && typeof plan.correction_state === 'object'
      ? plan.correction_state
      : null,
    showDecisionSummary: shouldShowDecisionSummary,
  };
}

function buildClarifyResult(text, plan, telemetry, fallbackReason = 'clarify_needed') {
  return {
    canvasMode: 'clarify',
    scopeMode: plan.scope_mode || 'none',
    targetBlockIds: plan.target_block_ids || [],
    candidateBlockIds: plan.candidate_block_ids || [],
    operationKind: plan.operation_kind || 'rewrite',
    helperUsed: Boolean(plan.helper_used),
    styleContextMode: 'none',
    operations: [],
    citations: [],
    text,
    focusSummary: buildFocusSummary(text),
    fallbackReason,
    interactionEligible: Boolean(plan.clarify_needed),
    clarifyReason: plan.clarify_reason || '',
    clarifyRenderMode: plan.clarify_render_mode || 'text',
    missingSlots: Array.isArray(plan.missing_slots) ? plan.missing_slots : [],
    prefilledAnswers: plan.prefilled_answers || {},
    answerSlots: plan.answer_slots || {},
    sourceReference: plan.source_reference || null,
    sourceCandidates: Array.isArray(plan.source_candidates) ? plan.source_candidates : [],
    targetCandidates: Array.isArray(plan.target_candidates) ? plan.target_candidates : [],
    primaryIntent: String(plan.primary_intent || plan.intent || 'edit'),
    intentConfidence: Number(plan.intent_confidence || 0) || 0,
    riskLevel: String(plan.risk_level || 'low'),
    decisionSummary: String(plan.decision_summary || '').trim(),
    aiArbitrationMode: String(plan.ai_arbitration_mode || 'none'),
    sourceContentType: String(plan.source_content_type || '').trim(),
    targetAnchor: plan.target_anchor || null,
    positionRelation: String(plan.position_relation || '').trim(),
    writeAction: String(plan.write_action || '').trim(),
    correctionState: plan.correction_state && typeof plan.correction_state === 'object'
      ? plan.correction_state
      : null,
    showDecisionSummary: Boolean(plan.decision_summary),
    usage: sumUsageRecords(telemetry.usages),
    budget: getLastBudget(telemetry),
    compacted: telemetry.compacted,
  };
}

function detectCanvasBlockType(content = '') {
  if (/^#{1,6}\s/m.test(content)) return 'heading';
  if (/^```/m.test(content)) return 'code';
  if (/^\|.+\|$/m.test(content)) return 'table';
  if (/^>\s/m.test(content)) return 'blockquote';
  if (/^([-*+]|\d+\.)\s/m.test(content)) return 'list';
  return 'paragraph';
}

function buildSnapshotBlocks(markdown = '') {
  const source = String(markdown || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  return source
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((content, index) => ({
      id: `snapshot_${index + 1}`,
      type: detectCanvasBlockType(content),
      content,
    }));
}

function resolveLocationBlock(article, targetLocation = null, targetBlockIds = []) {
  if (targetLocation?.block_id) return findBlock(article, targetLocation.block_id);
  if (typeof targetLocation?.value === 'string' && targetLocation.value.startsWith('block:')) {
    return findBlock(article, targetLocation.value.slice('block:'.length));
  }
  if (Array.isArray(targetBlockIds) && targetBlockIds.length > 0) {
    return findBlock(article, targetBlockIds[0]);
  }
  return null;
}

function buildInsertOperationsFromSnapshot({
  article,
  sourceBlocks = [],
  targetLocation = null,
  targetBlockIds = [],
  writeMode = 'append_new_blocks',
}) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  const normalizedSourceBlocks = Array.isArray(sourceBlocks) ? sourceBlocks.filter((item) => String(item?.content || '').trim()) : [];
  if (normalizedSourceBlocks.length === 0) return [];

  const anchorBlock = resolveLocationBlock(article, targetLocation, targetBlockIds);
  const anchorValue = String(targetLocation?.value || '').trim();
  const firstBlock = blocks[0] || null;
  const lastBlock = blocks[blocks.length - 1] || null;

  const positionMode = writeMode === 'insert_before_target'
    ? 'before'
    : 'after';

  if (writeMode === 'replace_target') {
    const replaceBlock = anchorBlock || (
      anchorValue === 'document_start'
        ? firstBlock
        : anchorValue === 'document_end'
          ? lastBlock
          : null
    );
    if (!replaceBlock) {
      return normalizedSourceBlocks.map((block, index) => ({
        op: 'insert',
        block_id: lastBlock?.id || firstBlock?.id || null,
        new_block_id: `snapshot_insert_${Date.now()}_${index + 1}`,
        position: blocks.length === 0 ? 0 : 'after',
        type: block.type || 'paragraph',
        new: block.content,
      }));
    }

    const operations = [];
    operations.push({
      op: 'replace',
      block_id: replaceBlock.id,
      old: replaceBlock.content || '',
      new: normalizedSourceBlocks[0].content,
    });
    let previousBlockId = replaceBlock.id;
    normalizedSourceBlocks.slice(1).forEach((block, index) => {
      const newBlockId = `snapshot_insert_${Date.now()}_${index + 2}`;
      operations.push({
        op: 'insert',
        block_id: previousBlockId,
        new_block_id: newBlockId,
        position: 'after',
        type: block.type || 'paragraph',
        new: block.content,
      });
      previousBlockId = newBlockId;
    });
    return operations;
  }

  const docStart = anchorValue === 'document_start';
  const docEnd = anchorValue === 'document_end';
  let previousBlockId = docStart ? firstBlock?.id || null : (anchorBlock?.id || lastBlock?.id || null);
  const initialPosition = blocks.length === 0
    ? 0
    : docStart
      ? 'before'
      : positionMode;

  return normalizedSourceBlocks.map((block, index) => {
    const newBlockId = `snapshot_insert_${Date.now()}_${index + 1}`;
    const operation = {
      op: 'insert',
      block_id: previousBlockId,
      new_block_id: newBlockId,
      position: index === 0
        ? initialPosition
        : 'after',
      type: block.type || 'paragraph',
      new: block.content,
    };
    if (docEnd && index === 0 && lastBlock?.id) {
      operation.block_id = lastBlock.id;
      operation.position = 'after';
    }
    if (docStart && index === 0 && firstBlock?.id) {
      operation.block_id = firstBlock.id;
      operation.position = 'before';
    }
    if (!operation.block_id && typeof operation.position !== 'number') {
      operation.position = 0;
    }
    previousBlockId = newBlockId;
    return operation;
  });
}

function buildDeterministicDelete(article, targetBlockIds = []) {
  return targetBlockIds
    .map((blockId) => {
      const block = findBlock(article, blockId);
      if (!block) return null;
      return {
        op: 'delete',
        block_id: blockId,
        old: block.content || '',
      };
    })
    .filter(Boolean);
}

function buildDeterministicSwap(article, targetBlockIds = []) {
  if (!Array.isArray(targetBlockIds) || targetBlockIds.length !== 2) return [];
  const first = findBlock(article, targetBlockIds[0]);
  const second = findBlock(article, targetBlockIds[1]);
  if (!first || !second) return [];
  return [
    {
      op: 'replace',
      block_id: first.id,
      old: first.content || '',
      new: second.content || '',
    },
    {
      op: 'replace',
      block_id: second.id,
      old: second.content || '',
      new: first.content || '',
    },
  ];
}

async function executePromptedEdit({
  userInput,
  article,
  blocks,
  allowedBlockIds = [],
  scopeMode,
  operationKind,
  styleContext,
  knowledgeSections,
  memorySummary,
  recentHistory,
  llmConfig,
  telemetry,
  summaryInstruction,
  sourceContentSnapshot,
}) {
  const promptBlocks = Array.isArray(blocks) ? blocks : [];
  const targetBlockIds = Array.isArray(allowedBlockIds) && allowedBlockIds.length > 0
    ? allowedBlockIds
    : promptBlocks.map((block) => block.id);
  const targetLabels = targetBlockIds.map((blockId) => blockRefLabel(article, blockId));
  const prompt = buildCanvasEditPrompt({
    userInput,
    articleTitle: article?.title || '未命名文章',
    blocks: promptBlocks,
    scopeMode,
    operationKind,
    styleContext,
    knowledgeSections,
    memorySummary,
    recentHistory,
    targetBlockLabels: targetLabels,
    summaryInstruction,
    sourceContentSnapshot,
  });
  const reply = await completeChat(prompt, {
    taskType: 'operation_json',
    temperature: 0.25,
    responseFormat: { type: 'json_object' },
    config: llmConfig || undefined,
  });
  pushReplyTelemetry(telemetry, reply);
  const parsed = safeJsonParse(reply.message?.content);
  if (!parsed) throw new Error('操作结果解析失败');
  return {
    summary: String(parsed.summary || '').trim(),
    operations: normalizeOperations(article, parsed, {
      allowedBlockIds: targetBlockIds,
    }),
  };
}

async function executeTextReply({
  prompt,
  taskType,
  llmConfig,
  telemetry,
  onStream,
}) {
  let fullText = '';
  const reply = await streamChat(prompt, {
    taskType,
    config: llmConfig || undefined,
    temperature: 0.35,
    onToken: (token) => {
      fullText += token;
      if (typeof onStream === 'function') onStream({ type: 'token', text: token });
    },
    onUsage: (usage) => {
      if (usage) telemetry.usages.push(usage);
    },
  });
  pushReplyTelemetry(telemetry, reply);
  return fullText || reply.text || '';
}

async function runCanvasAgent({
  userInput,
  article,
  conversationHistory = [],
  activeFileId = null,
  referenceMode = 'auto',
  factFileIds = [],
  styleMode = 'auto',
  styleFileIds = [],
  llmConfig = null,
  forcedPlan = null,
}, onStream) {
  const config = getEffectiveConfig();
  const telemetry = buildTelemetry();
  const resolvedUserInput = String(userInput || forcedPlan?.original_user_input || '').trim();
  const plan = forcedPlan || await resolveCanvasRequest({
    userInput: resolvedUserInput,
    article,
    conversationHistory,
    styleMode,
    referenceMode,
    factFileIds,
    llmConfig,
  });

  if (plan.helper_usage) telemetry.usages.push(plan.helper_usage);
  if (plan.helper_budget) telemetry.budgets.push(plan.helper_budget);
  if (plan.helper_compacted) telemetry.compacted = true;
  const decisionContext = buildDecisionContext(plan, {
    forceShowDecisionSummary: Boolean(forcedPlan),
  });

  const { recentHistory, memorySummary } = buildHistorySummary(conversationHistory, {
    keepRecentMessages: 4,
    maxOlderTurns: 4,
    userTokenBudget: 64,
    assistantTokenBudget: 96,
  });

  if (plan.clarify_needed) {
    return buildClarifyResult(plan.clarify_question || '你想改哪一段？', plan, telemetry);
  }

  const resolvedPrimaryIntent = String(plan.primary_intent || plan.intent || 'text');
  const resolvedTargetLocation = plan.target_location
    || plan.answer_slots?.target_location
    || null;
  const resolvedWriteMode = plan.write_mode
    || plan.answer_slots?.write_mode?.value
    || '';
  const resolvedSourceSnapshot = String(
    plan.source_content_snapshot
    || plan.answer_slots?.source_content_ref?.source_content_snapshot
    || ''
  ).trim();
  const directSourceTargetIds = normalizeStringArray([
    ...(Array.isArray(plan.target_block_ids) ? plan.target_block_ids : []),
    resolvedTargetLocation?.block_id || '',
  ]);

  if (resolvedPrimaryIntent === 'edit' && resolvedSourceSnapshot && resolvedWriteMode) {
    const sourceBlocks = buildSnapshotBlocks(resolvedSourceSnapshot);
    const operations = buildInsertOperationsFromSnapshot({
      article,
      sourceBlocks,
      targetLocation: resolvedTargetLocation,
      targetBlockIds: directSourceTargetIds,
      writeMode: resolvedWriteMode,
    });
    const summaryText = operations.length > 0
      ? '已根据你确认的内容来源、写入位置和写入方式生成预览。'
      : '已记录你的确认，但当前没有生成可应用的修改。';
    return {
      canvasMode: 'edit',
      scopeMode: directSourceTargetIds.length > 1 ? 'multiple' : (directSourceTargetIds.length === 1 ? 'single' : 'none'),
      targetBlockIds: directSourceTargetIds,
      operationKind: plan.operation_kind || 'insert',
      helperUsed: Boolean(plan.helper_used),
      styleContextMode: 'none',
      operations,
      citations: [],
      text: summaryText,
      focusSummary: summaryText,
      fallbackReason: null,
      ...decisionContext,
      usage: sumUsageRecords(telemetry.usages),
      budget: getLastBudget(telemetry),
      compacted: telemetry.compacted,
    };
  }

  let styleContext = null;
  let knowledgeContext = null;

  if (plan.needs_style) {
    styleContext = await getStyleContext(resolvedUserInput || article?.title, {
      articleTitle: article?.title || '',
      activeFileId,
      styleFileIds: styleMode === 'manual' ? styleFileIds : [],
    });
  }

  if (plan.needs_knowledge) {
    const retrieved = await retrieveKnowledgeContext(resolvedUserInput, {
      topK: 4,
      activeFileId,
      fileIds: Array.isArray(factFileIds) ? factFileIds : [],
      restrictToFileIds: referenceMode === 'manual',
    });
    knowledgeContext = {
      sections: buildKnowledgeContext(retrieved),
      chunks: retrieved?.chunks || [],
    };
  }

  if (resolvedPrimaryIntent === 'text') {
    const targetBlocks = trimBlocks(selectNeighborContext(article, plan.target_block_ids, 8), 180);
    const prompt = buildCanvasTextPrompt({
      userInput: resolvedUserInput,
      articleTitle: article?.title || '未命名文章',
      blocks: targetBlocks,
      memorySummary,
      styleContext,
      knowledgeSections: knowledgeContext?.sections || [],
      recentHistory,
    });
    if (typeof onStream === 'function') onStream({ type: 'thinking', text: '正在整理建议…' });
    const text = await executeTextReply({
      prompt,
      taskType: 'canvas_text',
      llmConfig,
      telemetry,
      onStream,
    });
    return {
      canvasMode: 'text',
      scopeMode: plan.scope_mode || 'none',
      targetBlockIds: plan.target_block_ids || [],
      operationKind: 'discuss',
      helperUsed: Boolean(plan.helper_used),
      styleContextMode: styleContext?.mode || 'none',
      operations: [],
      citations: knowledgeContext?.chunks || [],
      text,
      focusSummary: buildFocusSummary(text),
      fallbackReason: null,
      ...decisionContext,
      usage: sumUsageRecords(telemetry.usages),
      budget: getLastBudget(telemetry),
      compacted: telemetry.compacted,
    };
  }

  if (resolvedPrimaryIntent === 'analyze') {
    if (!config.canvasEnableArticleAnalysis) {
      return {
        canvasMode: 'text',
        scopeMode: 'none',
        targetBlockIds: [],
        operationKind: 'analyze',
        helperUsed: Boolean(plan.helper_used),
        styleContextMode: 'none',
        operations: [],
        citations: [],
        text: '当前版本默认未开启文章分析功能。如需启用，可以打开 canvas 文章分析开关后再使用。',
        focusSummary: '当前版本默认未开启文章分析功能。',
        fallbackReason: 'analysis_disabled',
        ...decisionContext,
        usage: sumUsageRecords(telemetry.usages),
        budget: getLastBudget(telemetry),
        compacted: telemetry.compacted,
      };
    }
    const prompt = buildCanvasAnalysisPrompt({
      userInput: resolvedUserInput,
      articleTitle: article?.title || '未命名文章',
      blocks: trimBlocks(article?.blocks || [], 140).slice(0, 12),
      memorySummary,
    });
    if (typeof onStream === 'function') onStream({ type: 'thinking', text: '正在分析文章…' });
    const text = await executeTextReply({
      prompt,
      taskType: 'canvas_analysis',
      llmConfig,
      telemetry,
      onStream,
    });
    return {
      canvasMode: 'analysis',
      scopeMode: 'none',
      targetBlockIds: [],
      operationKind: 'analyze',
      helperUsed: Boolean(plan.helper_used),
      styleContextMode: 'none',
      operations: [],
      citations: [],
      text,
      focusSummary: buildFocusSummary(text),
      fallbackReason: null,
      ...decisionContext,
      usage: sumUsageRecords(telemetry.usages),
      budget: getLastBudget(telemetry),
      compacted: telemetry.compacted,
    };
  }

  if (plan.operation_kind === 'delete') {
    const operations = buildDeterministicDelete(article, plan.target_block_ids || []);
    return {
      canvasMode: 'edit',
      scopeMode: plan.scope_mode || 'single',
      targetBlockIds: plan.target_block_ids || [],
      operationKind: 'delete',
      helperUsed: Boolean(plan.helper_used),
      styleContextMode: 'none',
      operations,
      citations: [],
      text: buildSummaryFromOperations(article, operations),
      focusSummary: buildSummaryFromOperations(article, operations),
      fallbackReason: null,
      ...decisionContext,
      usage: sumUsageRecords(telemetry.usages),
      budget: getLastBudget(telemetry),
      compacted: telemetry.compacted,
    };
  }

  if (plan.operation_kind === 'reorder' && Array.isArray(plan.target_block_ids) && plan.target_block_ids.length === 2) {
    const operations = buildDeterministicSwap(article, plan.target_block_ids);
    return {
      canvasMode: 'edit',
      scopeMode: 'multiple',
      targetBlockIds: plan.target_block_ids || [],
      operationKind: 'reorder',
      helperUsed: Boolean(plan.helper_used),
      styleContextMode: 'none',
      operations,
      citations: [],
      text: '已生成这两段的顺序调整预览。',
      focusSummary: '已生成这两段的顺序调整预览。',
      fallbackReason: null,
      ...decisionContext,
      usage: sumUsageRecords(telemetry.usages),
      budget: getLastBudget(telemetry),
      compacted: telemetry.compacted,
    };
  }

  if (plan.scope_mode === 'global') {
    const editableBlocks = getEditableBlocks(article);
    const softMax = Number(config.canvasGlobalEditSoftMaxBlocks || 12);
    const hardMax = Number(config.canvasGlobalEditHardMaxBlocks || 20);
    if (editableBlocks.length === 0) {
      return buildClarifyResult('这篇文章里没有可直接全文改写的正文块。', plan, telemetry, 'no_editable_blocks');
    }
    if (editableBlocks.length > hardMax) {
      return buildClarifyResult(`当前可改写正文块有 ${editableBlocks.length} 个，超出自动全文处理上限。请缩小到某几段，或分批指定范围。`, plan, telemetry, 'global_edit_hard_limit');
    }

    const batchSize = 4;
    const estimatedCalls = Math.ceil(editableBlocks.length / batchSize);
    if (estimatedCalls > 6) {
      return buildClarifyResult('这次全文改写范围过大，预计调用次数会过多。请缩小到某几段，或先处理前半部分。', plan, telemetry, 'global_edit_call_limit');
    }

    const batches = [];
    for (let index = 0; index < editableBlocks.length; index += batchSize) {
      batches.push(editableBlocks.slice(index, index + batchSize));
    }
    if (typeof onStream === 'function') {
      onStream({
        type: 'batch_start',
        total_batches: batches.length,
        total_blocks: editableBlocks.length,
        soft_limit: softMax,
      });
    }

    const allOperations = [];
    let summary = '';
    for (let index = 0; index < batches.length; index += 1) {
      const batch = trimBlocks(batches[index], 180);
      if (typeof onStream === 'function') {
        onStream({
          type: 'batch_progress',
          current_batch: index + 1,
          total_batches: batches.length,
          text: `正在处理第 ${index + 1}/${batches.length} 批全文改写…`,
        });
      }
      const result = await executePromptedEdit({
        userInput: resolvedUserInput,
        article,
        blocks: batch,
        allowedBlockIds: batch.map((block) => block.id),
        scopeMode: editableBlocks.length > softMax ? 'global' : 'multiple',
        operationKind: plan.operation_kind,
        styleContext,
        knowledgeSections: knowledgeContext?.sections || [],
        memorySummary,
        recentHistory,
        llmConfig,
        telemetry,
        summaryInstruction: plan.summary_instruction || '',
        sourceContentSnapshot: resolvedSourceSnapshot,
      });
      allOperations.push(...result.operations);
      if (result.summary && !summary) summary = result.summary;
    }
    if (typeof onStream === 'function') {
      onStream({
        type: 'batch_done',
        total_batches: batches.length,
        total_operations: allOperations.length,
      });
    }
    const finalSummary = summary || buildSummaryFromOperations(article, allOperations);
    return {
      canvasMode: 'edit',
      scopeMode: 'global',
      targetBlockIds: editableBlocks.map((block) => block.id),
      operationKind: plan.operation_kind,
      helperUsed: Boolean(plan.helper_used),
      styleContextMode: styleContext?.mode || 'none',
      operations: allOperations,
      citations: knowledgeContext?.chunks || [],
      text: finalSummary,
      focusSummary: finalSummary,
      fallbackReason: null,
      ...decisionContext,
      usage: sumUsageRecords(telemetry.usages),
      budget: getLastBudget(telemetry),
      compacted: telemetry.compacted,
    };
  }

  const targetBlockIds = normalizeStringArray(plan.target_block_ids);
  if (targetBlockIds.length === 0) {
    return buildClarifyResult('你想改哪一段？可以直接说“@b2”或“全文”。', plan, telemetry, 'no_target_block');
  }

  const promptBlocks = trimBlocks(selectNeighborContext(article, targetBlockIds, plan.scope_mode === 'single' ? 5 : 8), 200);
  const result = await executePromptedEdit({
    userInput: resolvedUserInput,
    article,
    blocks: promptBlocks,
    allowedBlockIds: targetBlockIds,
    scopeMode: plan.scope_mode,
    operationKind: plan.operation_kind,
    styleContext,
    knowledgeSections: knowledgeContext?.sections || [],
    memorySummary,
    recentHistory,
    llmConfig,
    telemetry,
    summaryInstruction: plan.summary_instruction || '',
    sourceContentSnapshot: resolvedSourceSnapshot,
  });
  const finalSummary = result.summary || buildSummaryFromOperations(article, result.operations);

  return {
    canvasMode: 'edit',
    scopeMode: plan.scope_mode || (targetBlockIds.length > 1 ? 'multiple' : 'single'),
    targetBlockIds,
    operationKind: plan.operation_kind,
    helperUsed: Boolean(plan.helper_used),
    styleContextMode: styleContext?.mode || 'none',
    operations: result.operations,
    citations: knowledgeContext?.chunks || [],
    text: finalSummary,
    focusSummary: finalSummary,
    fallbackReason: null,
    ...decisionContext,
    usage: sumUsageRecords(telemetry.usages),
    budget: getLastBudget(telemetry),
    compacted: telemetry.compacted,
  };
}

module.exports = {
  runCanvasAgent,
};
