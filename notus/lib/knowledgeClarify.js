const { getDb } = require('./db');
const { sha256 } = require('./files');
const { getExistingAnswers } = require('./conversationInteractions');

function trimText(value = '', limit = 28) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function uniqueTexts(items = [], limit = 3) {
  const seen = new Set();
  const next = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    const text = String(item || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    next.push(text);
  });
  return next.slice(0, Math.max(0, limit));
}

function buildHistorySubjectOptions(history = [], activeFileLabel = '') {
  const choices = uniqueTexts(
    (Array.isArray(history) ? history : [])
      .filter((item) => item?.role === 'user')
      .map((item) => trimText(item.content, 22)),
    2
  );
  const options = [];
  if (activeFileLabel) {
    options.push({
      id: 'current_document',
      label: activeFileLabel,
      description: '当前打开的文档',
    });
  }
  choices.forEach((choice, index) => {
    options.push({
      id: `history_subject_${index + 1}`,
      label: choice,
      description: '来自最近一轮提问',
    });
  });
  return options.slice(0, 3);
}

function buildTimeRangeOptions({ fileIds = [], restrictToFileIds = false } = {}) {
  const db = getDb();
  const now = Date.now();
  let rows = [];

  if (restrictToFileIds && Array.isArray(fileIds) && fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    rows = db.prepare(`
      SELECT id, mtime
      FROM files
      WHERE id IN (${placeholders})
    `).all(...fileIds);
  } else {
    rows = db.prepare('SELECT id, mtime FROM files').all();
  }

  const counts = [7, 30, 90].map((days) => ({
    days,
    count: rows.filter((row) => Number(row.mtime || 0) > 0 && (now - Number(row.mtime || 0)) <= days * 24 * 60 * 60 * 1000).length,
  }));

  return [
    { id: 'last_7_days', label: '最近一周', description: counts[0].count > 0 ? `约 ${counts[0].count} 篇笔记` : '近 7 天内的笔记' },
    { id: 'last_30_days', label: '最近一个月', description: counts[1].count > 0 ? `约 ${counts[1].count} 篇笔记` : '近 30 天内的笔记' },
    { id: 'last_90_days', label: '最近三个月', description: counts[2].count > 0 ? `约 ${counts[2].count} 篇笔记` : '近 90 天内的笔记' },
  ];
}

function buildKnowledgeClarifyQuestions(queryPlan = {}, options = {}) {
  const flags = Array.isArray(queryPlan.ambiguity_flags) ? queryPlan.ambiguity_flags : [];
  const questions = [];
  const activeFileLabel = String(options.activeFileLabel || '').trim();
  const subjectOptions = buildHistorySubjectOptions(options.history, activeFileLabel);

  if (flags.includes('pronoun_reference') || flags.includes('missing_subject')) {
    questions.push({
      id: 'knowledge_subject',
      slot: 'knowledge_subject',
      label: '你指的是哪个对象、主题或文档？',
      type: subjectOptions.length > 0 ? 'single_select' : 'text_input',
      required: true,
      options: subjectOptions,
      allow_custom: true,
      custom_placeholder: '例如：某篇笔记、某个功能、某个对象',
    });
  }

  if ((queryPlan.intent === 'comparison' || flags.includes('missing_counterpart')) && questions.length < 3) {
    questions.push({
      id: 'knowledge_counterpart',
      slot: 'knowledge_counterpart',
      label: '还需要补上另一个比较对象',
      type: 'text_input',
      required: true,
      options: [],
      allow_custom: true,
      custom_placeholder: '例如：和 Redis、和另一种方案、和旧版本相比',
    });
  }

  if ((queryPlan.intent === 'summary' || flags.includes('broad_scope') || /最近|近期|这周|本周|本月|近/.test(String(queryPlan.query || ''))) && questions.length < 3) {
    questions.push({
      id: 'knowledge_time_range',
      slot: 'knowledge_time_range',
      label: '你说的时间范围大概是多久？',
      type: 'single_select',
      required: true,
      options: buildTimeRangeOptions(options),
      allow_custom: true,
      custom_placeholder: '例如：从 4 月底到今天',
    });
  }

  if ((flags.includes('broad_scope') || (questions.length === 0 && queryPlan.intent === 'summary')) && questions.length < 3) {
    const scopeOptions = [];
    if (activeFileLabel) {
      scopeOptions.push({
        id: 'current_document_first',
        label: '先看当前文档',
        description: activeFileLabel,
      });
    }
    if (options.restrictToFileIds && Array.isArray(options.fileIds) && options.fileIds.length > 0) {
      scopeOptions.push({
        id: 'current_reference_scope',
        label: `只看当前参考范围`,
        description: `当前限制为 ${options.fileIds.length} 篇文档`,
      });
    }
    scopeOptions.push({
      id: 'whole_library',
      label: '整个知识库',
      description: '不限制到单篇文档',
    });
    questions.push({
      id: 'knowledge_scope',
      slot: 'knowledge_scope',
      label: '这次想限定在哪个范围里检索？',
      type: 'single_select',
      required: true,
      options: scopeOptions.slice(0, 3),
      allow_custom: true,
      custom_placeholder: '例如：只看某个专题目录',
    });
  }

  return questions.slice(0, 3);
}

function buildKnowledgeClarifyReason(queryPlan = {}) {
  const flags = Array.isArray(queryPlan.ambiguity_flags) ? queryPlan.ambiguity_flags : [];
  if (flags.includes('missing_counterpart')) return 'missing_counterpart';
  if (flags.includes('pronoun_reference')) return 'pronoun_reference';
  if (flags.includes('broad_scope')) return 'broad_scope';
  if (flags.includes('missing_subject')) return 'missing_subject';
  return 'clarify_needed';
}

function buildKnowledgeClarifyIntro(queryPlan = {}) {
  const flags = Array.isArray(queryPlan.ambiguity_flags) ? queryPlan.ambiguity_flags : [];
  if (queryPlan.intent === 'comparison' || flags.includes('missing_counterpart')) {
    return '我先确认一下你想比较的对象，再开始检索。';
  }
  if (queryPlan.intent === 'summary' || flags.includes('broad_scope')) {
    return '我先确认一下你想整理的范围，再开始检索。';
  }
  if (flags.includes('pronoun_reference') || flags.includes('missing_subject')) {
    return '这个问题里缺少明确对象，我先和你对齐一下再开始检索。';
  }
  return '我先补齐几个条件，再开始检索。';
}

function buildKnowledgeInteractionHash({ activeFileId = null, fileIds = [], restrictToFileIds = false, referenceMode = 'auto' } = {}) {
  const db = getDb();
  let snapshot = null;

  if (restrictToFileIds && Array.isArray(fileIds) && fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, mtime, updated_at
      FROM files
      WHERE id IN (${placeholders})
      ORDER BY id ASC
    `).all(...fileIds);
    snapshot = {
      mode: 'scoped',
      active_file_id: Number(activeFileId) || null,
      reference_mode: referenceMode,
      files: rows.map((row) => ({
        id: Number(row.id),
        mtime: Number(row.mtime || 0),
        updated_at: String(row.updated_at || ''),
      })),
    };
  } else {
    const row = db.prepare(`
      SELECT COUNT(*) AS count, MAX(mtime) AS max_mtime, MAX(updated_at) AS max_updated_at
      FROM files
    `).get();
    snapshot = {
      mode: 'all',
      active_file_id: Number(activeFileId) || null,
      reference_mode: referenceMode,
      count: Number(row?.count || 0),
      max_mtime: Number(row?.max_mtime || 0),
      max_updated_at: String(row?.max_updated_at || ''),
    };
  }

  return sha256(JSON.stringify(snapshot));
}

function buildKnowledgeInteractionPayload({
  query,
  queryPlan,
  activeFileId = null,
  activeFileLabel = '',
  fileIds = [],
  restrictToFileIds = false,
  referenceMode = 'auto',
  history = [],
} = {}) {
  const questions = buildKnowledgeClarifyQuestions(queryPlan, {
    activeFileLabel,
    history,
    activeFileId,
    fileIds,
    restrictToFileIds,
    referenceMode,
  });
  const clarifyIntro = buildKnowledgeClarifyIntro(queryPlan);

  return {
    title: '确认后再检索',
    kicker: '想先和你对齐几件事',
    submit_label: '开始检索',
    footer_hint: questions.length > 0 ? `${questions.length} 个问题，约 30 秒` : '确认后开始检索',
    collapsed_summary: '这次检索还差几个条件',
    original_user_input: String(query || '').trim(),
    clarify_intro: clarifyIntro,
    clarify_reason: buildKnowledgeClarifyReason(queryPlan),
    active_file_id: Number(activeFileId) || null,
    active_file_label: activeFileLabel,
    file_ids: Array.isArray(fileIds) ? fileIds.map((item) => Number(item)).filter(Boolean) : [],
    restrict_to_file_ids: Boolean(restrictToFileIds),
    reference_mode: referenceMode,
    questions,
  };
}

function getKnowledgeAnswerText(answer = {}) {
  return String(answer.text || '').trim() || String(answer.label || '').trim() || String(answer.value || '').trim();
}

function buildKnowledgeClarifiedQuery(interaction = {}) {
  const payload = interaction?.payload || {};
  const answers = getExistingAnswers(interaction);
  const originalQuery = String(payload.original_user_input || '').trim();
  const parts = [];

  if (answers.knowledge_subject) parts.push(`对象：${getKnowledgeAnswerText(answers.knowledge_subject)}`);
  if (answers.knowledge_counterpart) parts.push(`对比对象：${getKnowledgeAnswerText(answers.knowledge_counterpart)}`);
  if (answers.knowledge_time_range) parts.push(`时间范围：${getKnowledgeAnswerText(answers.knowledge_time_range)}`);
  if (answers.knowledge_scope) parts.push(`检索范围：${getKnowledgeAnswerText(answers.knowledge_scope)}`);

  return parts.length > 0
    ? `${originalQuery}；补充条件：${parts.join('；')}`
    : originalQuery;
}

module.exports = {
  buildKnowledgeClarifiedQuery,
  buildKnowledgeClarifyIntro,
  buildKnowledgeClarifyQuestions,
  buildKnowledgeInteractionHash,
  buildKnowledgeInteractionPayload,
};
