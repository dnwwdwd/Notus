const { getDb } = require('./db');
const { sha256 } = require('./files');

const DEFAULT_EXPIRE_DAYS = 7;
const ACTIVE_STATUSES = ['pending', 'stale', 'failed'];
const TERMINAL_STATUSES = ['answered', 'cancelled'];
const DISPLAYABLE_STATUSES = ['pending', 'stale', 'failed'];
const STRUCTURED_REASON_CODES = [
  'missing_target_location',
  'ambiguous_content_reference',
  'ambiguous_target_block',
  'conflicting_edit_actions',
  'missing_write_mode',
  'ambiguous_primary_intent',
  'ambiguous_position_relation',
  'unsafe_high_risk_edit',
  'ai_arbitration_unavailable',
];
const SLOT_ORDER = ['primary_intent', 'source_content_ref', 'target_location', 'write_mode'];

function normalizeNullablePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function normalizeStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  if ([...ACTIVE_STATUSES, ...TERMINAL_STATUSES].includes(normalized)) return normalized;
  return fallback;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function formatRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    conversation_id: normalizeNullablePositiveInt(row.conversation_id),
    message_id: normalizeNullablePositiveInt(row.message_id),
    kind: String(row.kind || 'clarify_card'),
    source: String(row.source || 'canvas'),
    status: normalizeStatus(row.status),
    schema_version: Number(row.schema_version || 1),
    reason_code: String(row.reason_code || ''),
    article_hash: String(row.article_hash || ''),
    payload: parseJson(row.payload_json, {}),
    response: parseJson(row.response_json, null),
    answer_message_id: normalizeNullablePositiveInt(row.answer_message_id),
    expires_at: row.expires_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    answered_at: row.answered_at || null,
  };
}

function cleanupExpiredInteractions(database = getDb()) {
  database.prepare(`
    UPDATE conversation_interactions
    SET status = 'cancelled', updated_at = datetime('now')
    WHERE status IN ('pending', 'stale', 'failed')
      AND expires_at IS NOT NULL
      AND expires_at <= datetime('now')
  `).run();
}

function markConversationInteractionsStale(conversationId, articleHash, database = getDb()) {
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  const normalizedArticleHash = String(articleHash || '').trim();
  if (!normalizedConversationId || !normalizedArticleHash) return 0;
  const result = database.prepare(`
    UPDATE conversation_interactions
    SET status = 'stale', updated_at = datetime('now')
    WHERE conversation_id = ?
      AND status IN ('pending', 'failed')
      AND article_hash != ?
  `).run(normalizedConversationId, normalizedArticleHash);
  return Number(result.changes || 0);
}

function getInteractionById(id, database = getDb()) {
  const normalizedId = normalizeNullablePositiveInt(id);
  if (!normalizedId) return null;
  const row = database.prepare(`
    SELECT *
    FROM conversation_interactions
    WHERE id = ?
  `).get(normalizedId);
  return formatRow(row);
}

function listInteractionsByConversation(conversationId, options = {}, database = getDb()) {
  cleanupExpiredInteractions(database);
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) return [];
  const articleHash = String(options.articleHash || '').trim();
  if (articleHash) markConversationInteractionsStale(normalizedConversationId, articleHash, database);

  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((item) => normalizeStatus(item)).filter(Boolean)
    : DISPLAYABLE_STATUSES;

  const rows = database.prepare(`
    SELECT *
    FROM conversation_interactions
    WHERE conversation_id = ?
      AND status IN (${statuses.map(() => '?').join(',')})
    ORDER BY created_at ASC, id ASC
  `).all(normalizedConversationId, ...statuses);

  return rows.map(formatRow);
}

function createInteraction({
  conversationId,
  messageId = null,
  kind = 'clarify_card',
  source = 'canvas',
  status = 'pending',
  schemaVersion = 1,
  reasonCode = '',
  articleHash = '',
  payload = {},
  response = null,
  answerMessageId = null,
  answeredAt = null,
  expireDays = DEFAULT_EXPIRE_DAYS,
} = {}) {
  const database = getDb();
  cleanupExpiredInteractions(database);
  const normalizedConversationId = normalizeNullablePositiveInt(conversationId);
  if (!normalizedConversationId) throw new Error('conversation_id is required');

  database.prepare(`
    UPDATE conversation_interactions
    SET status = 'stale', updated_at = datetime('now')
    WHERE conversation_id = ?
      AND status = 'pending'
  `).run(normalizedConversationId);

  const result = database.prepare(`
    INSERT INTO conversation_interactions (
      conversation_id,
      message_id,
      kind,
      source,
      status,
      schema_version,
      reason_code,
      article_hash,
      payload_json,
      response_json,
      answer_message_id,
      expires_at,
      answered_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?, datetime('now'))
  `).run(
    normalizedConversationId,
    normalizeNullablePositiveInt(messageId),
    String(kind || 'clarify_card'),
    String(source || 'canvas'),
    normalizeStatus(status),
    Math.max(1, Number(schemaVersion) || 1),
    String(reasonCode || ''),
    String(articleHash || ''),
    JSON.stringify(payload || {}),
    response ? JSON.stringify(response) : null,
    normalizeNullablePositiveInt(answerMessageId),
    `+${Math.max(1, Number(expireDays) || DEFAULT_EXPIRE_DAYS)} days`,
    answeredAt || null
  );

  return getInteractionById(result.lastInsertRowid, database);
}

function updateInteraction(id, updates = {}, database = getDb()) {
  const normalizedId = normalizeNullablePositiveInt(id);
  if (!normalizedId) return null;

  const sets = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(updates, 'messageId')) {
    sets.push('message_id = ?');
    params.push(normalizeNullablePositiveInt(updates.messageId));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
    sets.push('status = ?');
    params.push(normalizeStatus(updates.status));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'articleHash')) {
    sets.push('article_hash = ?');
    params.push(String(updates.articleHash || ''));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'payload')) {
    sets.push('payload_json = ?');
    params.push(JSON.stringify(updates.payload || {}));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'response')) {
    sets.push('response_json = ?');
    params.push(updates.response ? JSON.stringify(updates.response) : null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'answerMessageId')) {
    sets.push('answer_message_id = ?');
    params.push(normalizeNullablePositiveInt(updates.answerMessageId));
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'answeredAt')) {
    sets.push('answered_at = ?');
    params.push(updates.answeredAt || null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'reasonCode')) {
    sets.push('reason_code = ?');
    params.push(String(updates.reasonCode || ''));
  }
  if (sets.length === 0) return getInteractionById(normalizedId, database);

  sets.push("updated_at = datetime('now')");
  database.prepare(`
    UPDATE conversation_interactions
    SET ${sets.join(', ')}
    WHERE id = ?
  `).run(...params, normalizedId);
  return getInteractionById(normalizedId, database);
}

function markInteractionStatus(id, status, database = getDb()) {
  return updateInteraction(id, {
    status,
    answeredAt: normalizeStatus(status) === 'answered' ? new Date().toISOString() : undefined,
  }, database);
}

function computeTextDigest(text = '') {
  return sha256(String(text || ''));
}

function findQuestion(payload = {}, id) {
  return (Array.isArray(payload.questions) ? payload.questions : []).find((question) => question.id === id) || null;
}

function getExistingAnswers(interaction = {}) {
  const prefilled = interaction?.payload?.prefilled_answers && typeof interaction.payload.prefilled_answers === 'object'
    ? interaction.payload.prefilled_answers
    : {};
  const responseAnswers = interaction?.response?.answers && typeof interaction.response.answers === 'object'
    ? interaction.response.answers
    : {};
  return {
    ...prefilled,
    ...responseAnswers,
  };
}

function buildAnswer(optionId, question, extra = {}) {
  const option = (Array.isArray(question?.options) ? question.options : []).find((item) => item.id === optionId) || null;
  return {
    question_id: question?.id || '',
    slot: question?.slot || question?.id || '',
    type: question?.type || 'single_select',
    value: optionId || '',
    label: option?.label || extra.label || optionId || '',
    text: extra.text || '',
    option_ids: Array.isArray(extra.option_ids) ? extra.option_ids : undefined,
    block_id: extra.block_id || null,
    source_message_id: extra.source_message_id || null,
    source_content_type: extra.source_content_type || '',
    position_relation: extra.position_relation || '',
    relation_hint: extra.relation_hint || '',
    write_action: extra.write_action || '',
  };
}

function normalizePrimaryIntentValue(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['edit', 'text', 'analyze', 'draft_text'].includes(normalized)) return normalized;
  if (normalized === 'discuss') return 'text';
  if (normalized === 'generate_draft_text') return 'draft_text';
  return normalized;
}

function deriveWriteModeFromAnswers(targetAnswer = null, writeModeAnswer = null) {
  const explicit = String(writeModeAnswer?.value || '').trim();
  const relation = String(targetAnswer?.position_relation || targetAnswer?.relation_hint || '').trim();
  if (explicit === 'replace_target' || relation === 'replace_anchor') return 'replace_target';
  if (explicit === 'insert_before_target' || relation === 'before_anchor' || relation === 'document_start') return 'insert_before_target';
  return explicit || 'append_new_blocks';
}

function deriveWriteAction(writeMode = '') {
  if (writeMode === 'replace_target') return 'rewrite_existing';
  if (writeMode === 'delete_target') return 'delete_existing';
  return 'insert_new_blocks';
}

function derivePositionRelation(targetAnswer = null, writeMode = '') {
  if (writeMode === 'replace_target') return 'replace_anchor';
  if (writeMode === 'insert_before_target') {
    return targetAnswer?.value === 'document_start' ? 'document_start' : 'before_anchor';
  }
  if (targetAnswer?.value === 'document_start') return 'document_start';
  if (targetAnswer?.value === 'document_end') return 'document_end';
  if (targetAnswer?.position_relation) return targetAnswer.position_relation;
  if (targetAnswer?.relation_hint) return targetAnswer.relation_hint;
  return 'after_anchor';
}

function inferTargetPositionRelation(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (/替换|覆盖|写成这段|改成这段/.test(normalized)) return 'replace_anchor';
  if (/前面|前边|之前|前一段/.test(normalized)) return 'before_anchor';
  if (/文首|开头|最前面/.test(normalized)) return 'document_start';
  if (/文末|结尾|最后|末尾/.test(normalized)) return 'document_end';
  if (/后面|后边|之后|后一段/.test(normalized)) return 'after_anchor';
  return '';
}

function buildDecisionSummaryFromAnswers(answers = {}, payload = {}) {
  const primaryIntent = normalizePrimaryIntentValue(answers.primary_intent?.value || payload.primary_intent || 'edit');
  if (primaryIntent === 'text') return '已按继续讨论理解，不会直接改文档。';
  if (primaryIntent === 'analyze') return '已按文章分析理解，不会直接改文档。';

  const sourceLabel = answers.source_content_ref?.label || '';
  const targetLabel = summarizeAnswerValue(answers.target_location, payload) || '';
  const writeMode = deriveWriteModeFromAnswers(answers.target_location, answers.write_mode);
  const writeLabel = writeMode === 'replace_target'
    ? '替换目标段落'
    : writeMode === 'insert_before_target'
      ? '写到目标前面'
      : answers.write_mode?.label || '追加新段落';

  const parts = [];
  if (sourceLabel) parts.push(sourceLabel);
  if (targetLabel) parts.push(targetLabel);
  if (writeLabel) parts.push(writeLabel);
  return parts.length > 0
    ? `已按${parts.join(' + ')}理解。`
    : '已按当前文档编辑理解。';
}

function parseStructuredSourceAnswer(question, answer = {}, interaction = {}) {
  const optionId = String(answer.option_id || answer.value || '').trim();
  const customText = String(answer.custom_text || answer.text || '').trim();
  if (optionId) {
    const option = (question.options || []).find((item) => item.id === optionId) || null;
    if (optionId === 'custom_content' && customText) {
      return {
        ...buildAnswer(optionId, question, {
          label: option?.label || '自定义内容',
          text: customText,
          source_content_type: 'draft_text',
        }),
        source_kind: 'custom_content',
        source_content_snapshot: customText,
        source_content_digest: computeTextDigest(customText),
        source_content_type: 'draft_text',
      };
    }
    if (optionId === 'previous_assistant_message') {
      return {
        ...buildAnswer(optionId, question, {
          label: option?.label || '上一条助手回复',
          source_message_id: normalizeNullablePositiveInt(interaction?.payload?.source_message_id),
          source_content_type: interaction?.payload?.source_content_type || 'general_chat',
        }),
        source_kind: interaction?.payload?.source_kind || 'assistant_message',
        source_content_snapshot: String(interaction?.payload?.source_content_snapshot || ''),
        source_content_digest: String(interaction?.payload?.source_content_digest || ''),
        source_content_type: interaction?.payload?.source_content_type || 'general_chat',
      };
    }
    if (optionId === 'recent_user_message' || optionId.includes(':')) {
      const candidate = interaction?.payload?.source_candidates?.find((item) => item.id === optionId) || null;
      if (candidate) {
        return {
          ...buildAnswer(optionId, question, {
            label: option?.label || candidate.label || '最近一条用户消息',
            source_message_id: normalizeNullablePositiveInt(candidate?.message_id),
            source_content_type: candidate?.source_content_type || 'general_chat',
          }),
          source_kind: candidate?.source_kind || 'user_message',
          source_content_snapshot: String(candidate?.content || ''),
          source_content_digest: computeTextDigest(candidate?.content || ''),
          source_content_type: candidate?.source_content_type || 'general_chat',
        };
      }
    }
    if (option) {
      return {
        ...buildAnswer(optionId, question, { label: option.label || optionId }),
      };
    }
  }
  if (customText) {
    return {
      ...buildAnswer('custom_content', question, { label: '自定义内容', text: customText, source_content_type: 'draft_text' }),
      source_kind: 'custom_content',
      source_content_snapshot: customText,
      source_content_digest: computeTextDigest(customText),
      source_content_type: 'draft_text',
    };
  }
  return null;
}

function parseRawSourceAnswer(question, rawText, interaction = {}) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  if (/上一条|上面的内容|以上内容|刚才生成|刚才那段|上一轮回复|刚才回复/.test(text)) {
    return parseStructuredSourceAnswer(question, { option_id: 'previous_assistant_message' }, interaction);
  }
  return parseStructuredSourceAnswer(question, { option_id: 'custom_content', text }, interaction);
}

function parseStructuredTargetAnswer(question, answer = {}, interaction = {}) {
  const optionId = String(answer.option_id || answer.value || '').trim();
  const customText = String(answer.custom_text || answer.text || '').trim();
  if (!optionId && !customText) return null;

  if (optionId) {
    if (/^block:/.test(optionId)) {
      return buildAnswer(optionId, question, {
        label: (question.options || []).find((item) => item.id === optionId)?.label || optionId,
        block_id: optionId.slice('block:'.length),
        position_relation: inferTargetPositionRelation(customText) || 'after_anchor',
        relation_hint: inferTargetPositionRelation(customText) || 'after_anchor',
      });
    }
    if (['document_start', 'document_end'].includes(optionId)) {
      return buildAnswer(optionId, question, {
        label: (question.options || []).find((item) => item.id === optionId)?.label || optionId,
        position_relation: optionId === 'document_start' ? 'document_start' : 'document_end',
        relation_hint: optionId === 'document_start' ? 'document_start' : 'document_end',
      });
    }
  }

  if (!customText) return null;
  const candidateIds = Array.isArray(interaction?.payload?.candidate_block_ids)
    ? interaction.payload.candidate_block_ids
    : [];
  const articleBlocks = Array.isArray(interaction?.payload?.article_blocks)
    ? interaction.payload.article_blocks
    : [];
  const blockByOrdinal = textToOrdinalBlockId(articleBlocks, customText);
  const relationHint = inferTargetPositionRelation(customText) || 'after_anchor';
  if (blockByOrdinal) {
    return buildAnswer(`block:${blockByOrdinal}`, question, {
      label: `第 ${articleBlocks.findIndex((item) => item.id === blockByOrdinal) + 1} 段`,
      block_id: blockByOrdinal,
      position_relation: relationHint,
      relation_hint: relationHint,
    });
  }
  if (candidateIds.length === 1) {
    return buildAnswer(`block:${candidateIds[0]}`, question, {
      label: `第 ${articleBlocks.findIndex((item) => item.id === candidateIds[0]) + 1} 段`,
      block_id: candidateIds[0],
      position_relation: relationHint,
      relation_hint: relationHint,
    });
  }
  return {
    ...buildAnswer('custom_target_location', question, {
      label: '自定义位置',
      text: customText,
      position_relation: relationHint,
      relation_hint: relationHint,
    }),
    unresolved_custom: true,
  };
}

function parseRawTargetAnswer(question, rawText, interaction = {}) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  if (/开头|最前面|文首|放前面/.test(text)) {
    return parseStructuredTargetAnswer(question, { option_id: 'document_start' }, interaction);
  }
  if (/结尾|最后|末尾|文末/.test(text)) {
    return parseStructuredTargetAnswer(question, { option_id: 'document_end' }, interaction);
  }
  const ordinalMatch = text.match(/@b(\d+)|第\s*(\d+)\s*(?:段|块)/i);
  if (ordinalMatch) {
    const ordinal = Number(ordinalMatch[1] || ordinalMatch[2]);
    const articleBlocks = Array.isArray(interaction?.payload?.article_blocks)
      ? interaction.payload.article_blocks
      : [];
    const block = articleBlocks[ordinal - 1];
    if (block?.id) {
      return parseStructuredTargetAnswer(question, { option_id: `block:${block.id}` }, interaction);
    }
  }
  return parseStructuredTargetAnswer(question, { text }, interaction);
}

function parseStructuredWriteModeAnswer(question, answer = {}) {
  const optionId = String(answer.option_id || answer.value || '').trim();
  if (!optionId) return null;
  const option = (question.options || []).find((item) => item.id === optionId) || null;
  if (!option) return null;
  return buildAnswer(optionId, question, {
    label: option.label || optionId,
    write_action: deriveWriteAction(optionId),
    position_relation: optionId === 'replace_target'
      ? 'replace_anchor'
      : optionId === 'insert_before_target'
        ? 'before_anchor'
        : 'after_anchor',
  });
}

function parseRawWriteModeAnswer(question, rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  if (/替换|覆盖|改成/.test(text)) {
    return parseStructuredWriteModeAnswer(question, { option_id: 'replace_target' });
  }
  if (/前面|前边|之前/.test(text)) {
    return parseStructuredWriteModeAnswer(question, { option_id: 'insert_before_target' });
  }
  if (/新段落|追加|后面|后边|之后|插进去|写进去|加进去|放进去/.test(text)) {
    return parseStructuredWriteModeAnswer(question, { option_id: 'append_new_blocks' });
  }
  return null;
}

function parseStructuredPrimaryIntentAnswer(question, answer = {}) {
  const optionId = normalizePrimaryIntentValue(answer.option_id || answer.value || '');
  if (!optionId) return null;
  const option = (question.options || []).find((item) => normalizePrimaryIntentValue(item.id) === optionId) || null;
  return buildAnswer(optionId, question, {
    label: option?.label || optionId,
  });
}

function parseRawPrimaryIntentAnswer(question, rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return null;
  if (/继续讨论|先讨论|先聊聊|不要直接改文档|先别改文档/.test(text)) {
    return parseStructuredPrimaryIntentAnswer(question, { value: 'text' });
  }
  if (/文章分析|先分析|先评估/.test(text)) {
    return parseStructuredPrimaryIntentAnswer(question, { value: 'analyze' });
  }
  if (/直接改文档|继续改文档|写到文档|写进去|生成预览/.test(text)) {
    return parseStructuredPrimaryIntentAnswer(question, { value: 'edit' });
  }
  return null;
}

function textToOrdinalBlockId(articleBlocks = [], text = '') {
  const ordinalMatch = String(text || '').match(/@b(\d+)|第\s*(\d+)\s*(?:段|块)/i);
  if (!ordinalMatch) return null;
  const ordinal = Number(ordinalMatch[1] || ordinalMatch[2]);
  const block = articleBlocks[ordinal - 1];
  return block?.id || null;
}

function normalizeSingleQuestionAnswer(question, answer, interaction, rawText) {
  if (!question) return null;
  if (question.id === 'primary_intent') {
    return answer ? parseStructuredPrimaryIntentAnswer(question, answer) : parseRawPrimaryIntentAnswer(question, rawText);
  }
  if (question.id === 'source_content_ref') {
    return answer ? parseStructuredSourceAnswer(question, answer, interaction) : parseRawSourceAnswer(question, rawText, interaction);
  }
  if (question.id === 'target_location') {
    return answer ? parseStructuredTargetAnswer(question, answer, interaction) : parseRawTargetAnswer(question, rawText, interaction);
  }
  if (question.id === 'write_mode') {
    return answer ? parseStructuredWriteModeAnswer(question, answer) : parseRawWriteModeAnswer(question, rawText);
  }
  if (question.type === 'text_input') {
    const text = String(answer?.text || rawText || '').trim();
    if (!text) return null;
    return {
      question_id: question.id,
      slot: question.slot || question.id,
      type: question.type,
      value: text,
      label: question.label || question.id,
      text,
    };
  }
  return null;
}

function normalizeInteractionResponse(interaction, input = {}) {
  const payload = interaction?.payload || {};
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const existingAnswers = getExistingAnswers(interaction);
  const structuredAnswers = input?.answers && typeof input.answers === 'object' ? input.answers : null;
  const rawText = String(input?.raw_text || '').trim();

  const nextAnswers = { ...existingAnswers };
  if (structuredAnswers) {
    questions.forEach((question) => {
      const normalized = normalizeSingleQuestionAnswer(question, structuredAnswers[question.id], interaction, '');
      if (normalized) nextAnswers[question.id] = normalized;
    });
  } else if (rawText) {
    questions.forEach((question) => {
      const normalized = normalizeSingleQuestionAnswer(question, null, interaction, rawText);
      if (normalized) nextAnswers[question.id] = normalized;
    });
  }

  const resolvedPrimaryIntent = normalizePrimaryIntentValue(
    nextAnswers.primary_intent?.value
      || interaction?.payload?.primary_intent
      || 'edit'
  );
  const shouldBypassEditSlots = resolvedPrimaryIntent === 'text' || resolvedPrimaryIntent === 'analyze';
  const missingSlots = questions
    .filter((question) => question.required)
    .filter((question) => {
      if (shouldBypassEditSlots && ['source_content_ref', 'target_location', 'write_mode'].includes(question.id)) {
        return false;
      }
      const answer = nextAnswers[question.id];
      if (!answer) return true;
      if (answer.unresolved_custom) return true;
      if (question.id === 'source_content_ref') {
        return !String(answer.source_content_snapshot || '').trim();
      }
      return !String(answer.value || '').trim();
    })
    .map((question) => question.id);

  const hasNewStructuredAnswer = questions.some((question) => {
    const current = nextAnswers[question.id];
    const before = existingAnswers[question.id];
    return JSON.stringify(current || null) !== JSON.stringify(before || null);
  });

  const resolutionStatus = missingSlots.length === 0
    ? 'resolved'
    : hasNewStructuredAnswer
      ? 'partial'
      : 'failed';

  return {
    answers: nextAnswers,
    missing_slots: missingSlots,
    resolution_status: resolutionStatus,
  };
}

function summarizeAnswerValue(answer = {}, payload = {}) {
  if (!answer) return '';
  if (answer.question_id === 'primary_intent') {
    if (answer.value === 'edit') return '直接改文档';
    if (answer.value === 'text') return '继续讨论';
    if (answer.value === 'analyze') return '文章分析';
    return answer.label || answer.value || '';
  }
  if (answer.question_id === 'source_content_ref') {
    if (answer.value === 'previous_assistant_message') return '上一条回复';
    if (answer.value === 'custom_content') return '自定义内容';
    return answer.label || '已确认';
  }
  if (answer.question_id === 'target_location') {
    if (answer.value === 'document_start') return '文首';
    if (answer.value === 'document_end') return '文末';
    if (answer.block_id) {
      const blocks = Array.isArray(payload.article_blocks) ? payload.article_blocks : [];
      const index = blocks.findIndex((item) => item.id === answer.block_id);
      const baseLabel = index >= 0 ? `第 ${index + 1} 段` : (answer.label || '指定段落');
      const relation = String(answer.position_relation || answer.relation_hint || '').trim();
      if (relation === 'before_anchor') return `${baseLabel}前`;
      if (relation === 'after_anchor') return `${baseLabel}后`;
      if (relation === 'replace_anchor') return `${baseLabel}`;
      return baseLabel;
    }
  }
  if (answer.question_id === 'write_mode') {
    if (answer.value === 'append_new_blocks') return '追加新段落';
    if (answer.value === 'insert_before_target') return '写到目标前面';
    if (answer.value === 'replace_target') return '替换目标段落';
  }
  return answer.label || answer.text || answer.value || '';
}

function buildInteractionAnswerSummary(interaction, normalizedResponse) {
  const payload = interaction?.payload || {};
  const answers = normalizedResponse?.answers || {};
  const primaryIntent = normalizePrimaryIntentValue(answers.primary_intent?.value || payload.primary_intent || 'edit');
  const parts = [];
  SLOT_ORDER.forEach((slot) => {
    if (
      (primaryIntent === 'text' || primaryIntent === 'analyze')
      && ['source_content_ref', 'target_location', 'write_mode'].includes(slot)
    ) {
      return;
    }
    const answer = answers[slot];
    const label = summarizeAnswerValue(answer, payload);
    if (!label) return;
    const slotLabel = slot === 'primary_intent'
      ? '主意图'
      : slot === 'source_content_ref'
      ? '内容来源'
      : slot === 'target_location'
        ? '写入位置'
        : slot === 'write_mode'
          ? '写入方式'
          : slot;
    parts.push(`${slotLabel}=${label}`);
  });
  const note = String(answers.additional_note?.text || '').trim();
  if (note) parts.push(`补充说明=${note}`);
  return parts.length > 0 ? `已回答提问卡片：${parts.join('；')}` : '已回答提问卡片。';
}

function resolveSourceSnapshot(interaction) {
  const answers = getExistingAnswers(interaction);
  const sourceAnswer = answers.source_content_ref || null;
  if (sourceAnswer?.source_content_snapshot) {
    return {
      source_message_id: sourceAnswer.source_message_id || normalizeNullablePositiveInt(interaction?.payload?.source_message_id),
      source_kind: sourceAnswer.source_kind || interaction?.payload?.source_kind || 'assistant_message',
      source_content_snapshot: String(sourceAnswer.source_content_snapshot || ''),
      source_content_digest: String(sourceAnswer.source_content_digest || computeTextDigest(sourceAnswer.source_content_snapshot || '')),
      source_content_type: String(sourceAnswer.source_content_type || interaction?.payload?.source_content_type || ''),
    };
  }
  return {
    source_message_id: normalizeNullablePositiveInt(interaction?.payload?.source_message_id),
    source_kind: interaction?.payload?.source_kind || 'assistant_message',
    source_content_snapshot: String(interaction?.payload?.source_content_snapshot || ''),
    source_content_digest: String(interaction?.payload?.source_content_digest || computeTextDigest(interaction?.payload?.source_content_snapshot || '')),
    source_content_type: String(interaction?.payload?.source_content_type || ''),
  };
}

function validateInteractionSourceDigest(interaction, getMessageById) {
  const source = resolveSourceSnapshot(interaction);
  if (!source.source_content_snapshot) return true;
  if (
    ['assistant_message', 'user_message'].includes(source.source_kind)
    && source.source_message_id
    && typeof getMessageById === 'function'
  ) {
    const message = getMessageById(source.source_message_id);
    if (!message) return false;
    return computeTextDigest(message.content || '') === source.source_content_digest;
  }
  return computeTextDigest(source.source_content_snapshot) === source.source_content_digest;
}

function buildResumePlanFromInteraction(interaction) {
  const payload = interaction?.payload || {};
  const answers = getExistingAnswers(interaction);
  const primaryIntent = normalizePrimaryIntentValue(answers.primary_intent?.value || payload.primary_intent || 'edit');
  const targetAnswer = answers.target_location || null;
  const writeModeAnswer = answers.write_mode || null;
  const source = resolveSourceSnapshot(interaction);
  const decisionSummary = buildDecisionSummaryFromAnswers(answers, payload);
  const correctionState = payload.correction_state && typeof payload.correction_state === 'object'
    ? payload.correction_state
    : null;
  const targetBlockId = targetAnswer?.block_id || (
    typeof targetAnswer?.value === 'string' && targetAnswer.value.startsWith('block:')
      ? targetAnswer.value.slice('block:'.length)
      : null
  );
  const writeMode = deriveWriteModeFromAnswers(targetAnswer, writeModeAnswer);
  const positionRelation = derivePositionRelation(targetAnswer, writeMode);
  const writeAction = deriveWriteAction(writeMode);

  if (primaryIntent === 'text') {
    return {
      intent: 'text',
      primary_intent: 'text',
      scope_mode: targetBlockId ? 'single' : 'none',
      target_block_ids: targetBlockId ? [targetBlockId] : [],
      candidate_block_ids: Array.isArray(payload.candidate_block_ids) ? payload.candidate_block_ids : [],
      operation_kind: 'discuss',
      needs_style: false,
      needs_knowledge: false,
      clarify_needed: false,
      helper_used: false,
      answer_slots: {
        primary_intent: answers.primary_intent || buildAnswer('text', { id: 'primary_intent', slot: 'primary_intent' }, { label: '继续讨论' }),
      },
      original_user_input: String(payload.original_user_input || ''),
      decision_summary: decisionSummary,
      correction_state: correctionState,
      risk_level: 'low',
      ai_arbitration_mode: 'resume',
      show_decision_summary: true,
    };
  }

  if (primaryIntent === 'analyze') {
    return {
      intent: 'analyze',
      primary_intent: 'analyze',
      scope_mode: 'none',
      target_block_ids: [],
      candidate_block_ids: Array.isArray(payload.candidate_block_ids) ? payload.candidate_block_ids : [],
      operation_kind: 'analyze',
      needs_style: false,
      needs_knowledge: false,
      clarify_needed: false,
      helper_used: false,
      answer_slots: {
        primary_intent: answers.primary_intent || buildAnswer('analyze', { id: 'primary_intent', slot: 'primary_intent' }, { label: '文章分析' }),
      },
      original_user_input: String(payload.original_user_input || ''),
      decision_summary: decisionSummary,
      correction_state: correctionState,
      risk_level: 'low',
      ai_arbitration_mode: 'resume',
      show_decision_summary: true,
    };
  }

  return {
    intent: 'edit',
    primary_intent: 'edit',
    scope_mode: targetBlockId ? 'single' : 'none',
    target_block_ids: targetBlockId ? [targetBlockId] : [],
    candidate_block_ids: Array.isArray(payload.candidate_block_ids) ? payload.candidate_block_ids : [],
    operation_kind: writeMode === 'replace_target' ? 'rewrite' : 'insert',
    needs_style: false,
    needs_knowledge: false,
    clarify_needed: false,
    helper_used: false,
    answer_slots: {
      primary_intent: answers.primary_intent || null,
      source_content_ref: answers.source_content_ref || null,
      target_location: targetAnswer || null,
      write_mode: writeModeAnswer || null,
    },
    target_location: targetAnswer || null,
    target_anchor: targetAnswer
      ? {
        value: targetAnswer.value,
        label: targetAnswer.label,
        block_id: targetBlockId,
      }
      : null,
    position_relation: positionRelation,
    write_action: writeAction,
    write_mode: writeMode,
    original_user_input: String(payload.original_user_input || ''),
    source_message_id: source.source_message_id,
    source_kind: source.source_kind,
    source_content_snapshot: source.source_content_snapshot,
    source_content_digest: source.source_content_digest,
    source_content_type: source.source_content_type || payload.source_content_type || '',
    summary_instruction: String(answers.additional_note?.text || ''),
    decision_summary: decisionSummary,
    correction_state: correctionState,
    risk_level: payload.risk_level || 'medium',
    ai_arbitration_mode: payload.ai_arbitration_mode || 'resume',
    show_decision_summary: true,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  DISPLAYABLE_STATUSES,
  STRUCTURED_REASON_CODES,
  SLOT_ORDER,
  buildInteractionAnswerSummary,
  buildResumePlanFromInteraction,
  cleanupExpiredInteractions,
  computeTextDigest,
  createInteraction,
  getExistingAnswers,
  getInteractionById,
  listInteractionsByConversation,
  markConversationInteractionsStale,
  markInteractionStatus,
  normalizeInteractionResponse,
  updateInteraction,
  validateInteractionSourceDigest,
};
