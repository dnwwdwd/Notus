const { completeChat } = require('./llm');
const { extractWebUrls } = require('./attachmentParsing');
const { getFileById, sha256 } = require('./files');
const { recordRunUsage } = require('./agentControlPlane');
const { createTurnFrame, getTaskTurnFrame } = require('./agentTurnFrames');

const INTENT_TYPES = new Set([
  'general', 'skill_discovery', 'skill_install', 'skill_create', 'mcp_manage',
  'web_research', 'knowledge_research', 'file_read', 'file_write',
]);
const CURRENT_FILE_REFERENCE = /(?:当前|现在|正在)(?:打开|编辑|查看)的?(?:文档|文件|笔记|文章)|(?:当前|这篇|这份|这个)(?:文档|文件|笔记|文章)|本文|本篇/;
const CURRENT_NON_FILE_REFERENCE = /当前(?:价格|版本|时间|日期|状态|进度|新闻|天气|汇率|政策|模型|数据)/;
const EXPLICIT_WEB = /联网|上网|网上(?:搜索|查找|寻找|查询)|互联网(?:搜索|查找|寻找|查询)|公开(?:来源|仓库|市场)|github[^\n]{0,24}(?:搜索|查找|寻找)|(?:搜索|查找|寻找)[^\n]{0,24}github/i;
const REALTIME_WEB_NEED = /(?:查询|搜索|查找|寻找|获取|了解|告诉我|看看)[^\n，。！？；]{0,24}(?:最新|实时|近期|今天|今年|当前)[^\n，。！？；]{0,24}(?:新闻|价格|天气|汇率|政策|数据|版本|发布|动态|信息)/i;
const WEB_NEGATION = /(?:不要|不用|无需|不必|不需要|不使用|不可以|不可|不得|不能|勿|别|禁止|严禁)(?:再|去|进行|使用|开启|打开|访问|通过|依赖|任何|\s){0,10}(?:联网|上网|网上|互联网|网页)|(?:不联网|离线|仅本地|只用本地)/i;
const LOCAL_ONLY = /本地|已安装|现有|我的\s*skill|notus\s*里/i;
const SKILL_WORD = /\bskill(?:s)?\b|技能/i;
const SKILL_DISCOVERY = /搜索|查找|寻找|找找|找|有没有|有无|推荐|哪些|哪里有|发现/i;
const SKILL_INSTALL = /安装|导入|添加到|装上/i;
const SKILL_CREATE = /创建|新建|编写|写一个|做一个|制作一个|设计一个/i;
const WRITE_ACTION = /修改|改写|重写|润色|补充|合并|写入|插入|追加|新建(?:文档|文件|笔记|文章)|创建(?:文档|文件|笔记|文章)|移动|重命名/i;
const INLINE_TEXT_OUTPUT = /(?:只|仅)(?:需|要)?(?:输出|返回|回复|给出)(?:[^，。！？；]{0,16})(?:结果|文本|内容|表达|一句话)?|直接(?:输出|返回|回复|给出)|不要(?:修改|写入|保存)(?:文档|文件|笔记|文章)/i;
const EXPLICIT_FILE_WRITE_TARGET = /(?:当前|这篇|这份|这个|指定|上述)?(?:文档|文件|笔记|文章|正文)|写入|保存(?:到|至|为)|新建(?:文档|文件|笔记|文章)|创建(?:文档|文件|笔记|文章)|\.md\b/i;
const READ_ACTION = /读取|阅读|总结|分析|检查|查看|解释|比较|提取/i;
const KNOWLEDGE_ACTION = /知识库|笔记库|我的笔记|工作区资料/i;
const MCP_ACTION = /\bmcp\b|mcp\s*server/i;
const URL_READ_ACTION = /读取|阅读|打开|访问|检查|分析|总结|看看|查看|抓取|解析|比较/i;
const ACTION_NEGATION = /(?:不要|不得|别|禁止|无需|不需要|不必|不能|不可|勿|并非要|不是要|尚未|未|不)(?:再|去|进行|帮我|直接|自动|现在|立刻|马上|这个|该|任何|只|\s){0,8}$/i;
const CLAUSE_BOUNDARY = /[，。！？；,;\n]/;

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanExtractedUrl(value = '') {
  let decoded = String(value || '');
  try { decoded = decodeURI(decoded); } catch {}
  return decoded.split(/[，。！？；、\s]/)[0].replace(/[),.;!?]+$/g, '');
}

function sanitizeUrl(value = '') {
  try {
    const cleaned = cleanExtractedUrl(value);
    const url = new URL(cleaned);
    url.username = '';
    url.password = '';
    url.hash = '';
    ['access_token', 'api_key', 'apikey', 'auth', 'authorization', 'code', 'key', 'password', 'secret', 'signature', 'token'].forEach((key) => {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[REDACTED]');
    });
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeMention(mention = {}) {
  const type = ['file', 'folder', 'skill'].includes(String(mention?.type || '')) ? String(mention.type) : 'unknown';
  return {
    type,
    id: String(mention?.id || '').slice(0, 240),
    path: type === 'file' || type === 'folder' ? String(mention?.path || '').replace(/\\/g, '/').slice(0, 1000) : '',
    name: String(mention?.name || mention?.label || '').slice(0, 240),
  };
}

function locateUrl(text, url) {
  const normalizedUrl = String(url || '');
  const candidates = [normalizedUrl, normalizedUrl.replace(/\/$/, '')].filter(Boolean);
  const index = candidates.reduce((found, candidate) => (found >= 0 ? found : text.indexOf(candidate)), -1);
  if (index < 0) return null;
  const matched = candidates.find((candidate) => text.indexOf(candidate) === index) || normalizedUrl;
  let start = index;
  while (start > 0 && !CLAUSE_BOUNDARY.test(text[start - 1])) start -= 1;
  let end = index + matched.length;
  while (end < text.length && !CLAUSE_BOUNDARY.test(text[end])) end += 1;
  return { index, matched, clause: text.slice(start, end), localIndex: index - start };
}

function urlIsNegated(text, url) {
  const located = locateUrl(text, url);
  if (!located) return false;
  const before = located.clause.slice(0, located.localIndex);
  const after = located.clause.slice(located.localIndex + located.matched.length);
  const negatedReadAction = /(?:不要|不得|别|禁止|无需|不用|不需要|不必|不可|不能|勿)(?:再|去|进行|帮我|直接|自动|这个|该|任何|只|\s){0,8}(?:读取|阅读|打开|访问|检查|分析|总结|看看|查看|抓取|解析|比较)/i;
  return negatedReadAction.test(before) || negatedReadAction.test(after);
}

function urlIsSelectedForInspection(text, url) {
  if (urlIsNegated(text, url)) return false;
  const located = locateUrl(text, url);
  return located ? hasPositiveAction(located.clause, URL_READ_ACTION) : false;
}

function hasPositiveAction(text, pattern) {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g');
  let match = matcher.exec(text);
  while (match) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (!ACTION_NEGATION.test(before)) return true;
    match = matcher.exec(text);
  }
  return false;
}

function hasPositiveWebInstruction(text) {
  return String(text || '').split(CLAUSE_BOUNDARY).some((clause) => (
    EXPLICIT_WEB.test(clause) && !WEB_NEGATION.test(clause)
  ));
}

function deterministicIntent(userQuery, context = {}) {
  const text = normalizeText(userQuery);
  const hasSkill = SKILL_WORD.test(text);
  const hasSkillDiscovery = hasSkill && hasPositiveAction(text, SKILL_DISCOVERY);
  const hasSkillInstall = hasSkill && hasPositiveAction(text, SKILL_INSTALL);
  const hasSkillCreate = hasSkill && hasPositiveAction(text, SKILL_CREATE);
  const webNegated = WEB_NEGATION.test(text);
  const explicitWeb = !webNegated && (EXPLICIT_WEB.test(text) || hasPositiveAction(text, REALTIME_WEB_NEED));
  const localOnly = LOCAL_ONLY.test(text);
  const inlineTextOnly = INLINE_TEXT_OUTPUT.test(text)
    && !EXPLICIT_FILE_WRITE_TARGET.test(text)
    && !(Array.isArray(context.mentions) && context.mentions.some((item) => ['file', 'folder'].includes(String(item?.type || ''))));
  const intentSignals = [];
  let taskKind = 'general';

  if (hasSkillDiscovery && !hasSkillInstall && !hasSkillCreate) {
    taskKind = 'skill_discovery';
    intentSignals.push('skill_discovery');
  } else if (hasSkillInstall) {
    taskKind = 'skill_install';
    intentSignals.push('skill_install');
  } else if (hasSkillCreate) {
    taskKind = 'skill_create';
    intentSignals.push('skill_create');
  } else if (MCP_ACTION.test(text) && /新增|添加|配置|修改|测试|启用|停用|删除|移除|查看|列出/.test(text)) {
    taskKind = 'mcp_manage';
    intentSignals.push('mcp_manage');
  } else if (WRITE_ACTION.test(text) && !inlineTextOnly) {
    taskKind = 'file_write';
    intentSignals.push('file_write');
  } else if (explicitWeb) {
    taskKind = 'web_research';
    intentSignals.push('web_research');
  } else if (KNOWLEDGE_ACTION.test(text)) {
    taskKind = 'knowledge_research';
    intentSignals.push('knowledge_research');
  } else if (READ_ACTION.test(text)) {
    taskKind = 'file_read';
    intentSignals.push('file_read');
  }

  const currentFileRequested = Boolean(
    context.activeFile
    && CURRENT_FILE_REFERENCE.test(text)
    && !CURRENT_NON_FILE_REFERENCE.test(text)
  );
  const urlPairs = extractWebUrls(text).map((raw) => ({ raw: cleanExtractedUrl(raw), sanitized: sanitizeUrl(raw) })).filter((item) => item.sanitized);
  const urls = urlPairs.map((item) => item.sanitized);
  const selectedUrlCandidates = taskKind === 'skill_install'
    ? []
    : urlPairs.filter((item) => urlIsSelectedForInspection(text, item.raw)).map((item) => item.sanitized);
  const explicitlyBlockedUrls = urlPairs.filter((item) => urlIsNegated(text, item.raw)).map((item) => item.sanitized);
  const inspectUrls = webNegated ? [] : selectedUrlCandidates;
  const blockedUrls = webNegated ? urls : explicitlyBlockedUrls;
  const unclassifiedUrls = urls.filter((url) => !inspectUrls.includes(url) && !blockedUrls.includes(url));
  const ambiguousUrlSelection = urls.length > 1 && inspectUrls.length > 0 && unclassifiedUrls.length > 0;
  const conflictingWebInstruction = webNegated && (
    hasPositiveWebInstruction(text)
    || selectedUrlCandidates.length > 0
    || (hasSkillDiscovery && !localOnly)
  );

  const webRequired = taskKind === 'skill_discovery'
    ? (!webNegated && (explicitWeb || !localOnly))
    : explicitWeb;
  const knowledgePolicy = taskKind === 'skill_discovery' && !localOnly
    ? 'forbidden'
    : taskKind === 'knowledge_research' ? 'required' : 'allowed';
  const localSkillPolicy = taskKind === 'skill_discovery'
    ? (explicitWeb ? 'forbidden' : localOnly ? 'required' : 'forbidden')
    : 'allowed';
  const requiresWrite = taskKind === 'file_write' || taskKind === 'skill_create' || taskKind === 'skill_install' || taskKind === 'mcp_manage';
  const mixedSkillActions = hasSkill
    ? [hasSkillDiscovery, hasSkillInstall, hasSkillCreate].filter(Boolean).length
    : 0;
  const hasUnresolvedDeictic = /(?:这个|那个|它|上面这个|刚才那个)/.test(text)
    && !currentFileRequested
    && (context.mentions?.length || context.attachments?.length) > 1;
  const needsPlanner = mixedSkillActions > 1 || hasUnresolvedDeictic || conflictingWebInstruction || ambiguousUrlSelection;
  const needsClarification = mixedSkillActions > 1 || hasUnresolvedDeictic || conflictingWebInstruction || ambiguousUrlSelection;

  return {
    task_kind: taskKind,
    source_policy: {
      web: webRequired ? 'required' : webNegated ? 'forbidden' : context.webSearchEnabled ? 'allowed' : 'forbidden',
      knowledge: knowledgePolicy,
      local_skills: localSkillPolicy,
      direct_urls: inspectUrls.length ? 'inspect_selected' : 'do_not_inspect',
    },
    direct_url_policy: {
      inspect_urls: inspectUrls,
      blocked_urls: blockedUrls,
      pending_urls: conflictingWebInstruction ? selectedUrlCandidates : [],
      explicitly_blocked_urls: explicitlyBlockedUrls,
      tool_only_urls: taskKind === 'skill_install' ? urls : [],
    },
    material_policy: {
      priority: ['mentions_and_attachments', 'conversation', 'explicit_current_file'],
      use_current_file: currentFileRequested,
      active_file_id: currentFileRequested ? context.activeFile?.id || null : null,
    },
    allowed_actions: requiresWrite ? ['read', 'write'] : ['read'],
    forbidden_actions: taskKind === 'skill_discovery' ? ['skill_install', 'skill_create', 'knowledge_substitution'] : [],
    completion_criteria: {
      requires_web: webRequired,
      requires_write: taskKind === 'file_write',
      requires_skill_draft: taskKind === 'skill_create',
      requires_resource_change: taskKind === 'skill_install'
        || (taskKind === 'mcp_manage' && /新增|添加|配置|修改|启用|停用|删除|移除/.test(text)),
      requires_answer: true,
    },
    needs_planner: needsPlanner,
    needs_clarification: needsClarification,
    ambiguity_kind: mixedSkillActions > 1 ? 'skill_action' : conflictingWebInstruction ? 'web_permission' : ambiguousUrlSelection ? 'url_selection' : hasUnresolvedDeictic ? 'source_reference' : '',
    missing_slots: mixedSkillActions > 1 ? ['skill_action'] : conflictingWebInstruction ? ['web_permission'] : ambiguousUrlSelection ? ['url_selection'] : hasUnresolvedDeictic ? ['source_reference'] : [],
    signals: intentSignals,
  };
}

function compileIntent(taskKind, fallback = {}) {
  const kind = INTENT_TYPES.has(String(taskKind || '')) ? String(taskKind) : fallback.task_kind || 'general';
  const sourcePolicy = {
    web: 'forbidden',
    knowledge: 'allowed',
    local_skills: 'allowed',
    direct_urls: fallback.direct_url_policy?.inspect_urls?.length ? 'inspect_selected' : 'do_not_inspect',
  };
  let allowedActions = ['read'];
  let forbiddenActions = [];
  const completionCriteria = {
    requires_web: false,
    requires_write: false,
    requires_skill_draft: false,
    requires_resource_change: false,
    requires_answer: true,
  };
  if (kind === 'skill_discovery') {
    const localOnly = fallback.source_policy?.local_skills === 'required';
    sourcePolicy.web = localOnly ? 'forbidden' : 'required';
    sourcePolicy.knowledge = 'forbidden';
    sourcePolicy.local_skills = localOnly ? 'required' : 'forbidden';
    completionCriteria.requires_web = !localOnly;
    forbiddenActions = ['skill_install', 'skill_create', 'knowledge_substitution'];
  } else if (kind === 'skill_install') {
    sourcePolicy.knowledge = 'forbidden';
    sourcePolicy.local_skills = 'allowed';
    allowedActions = ['read', 'write'];
    completionCriteria.requires_resource_change = true;
  } else if (kind === 'skill_create') {
    sourcePolicy.knowledge = 'forbidden';
    sourcePolicy.local_skills = 'allowed';
    allowedActions = ['read', 'write'];
    completionCriteria.requires_skill_draft = true;
  } else if (kind === 'mcp_manage') {
    allowedActions = ['read', 'write'];
    completionCriteria.requires_resource_change = Boolean(fallback.completion_criteria?.requires_resource_change);
  } else if (kind === 'web_research') {
    sourcePolicy.web = 'required';
    sourcePolicy.knowledge = 'forbidden';
    sourcePolicy.local_skills = 'forbidden';
    completionCriteria.requires_web = true;
  } else if (kind === 'knowledge_research') {
    sourcePolicy.knowledge = 'required';
  } else if (kind === 'file_read') {
    sourcePolicy.web = fallback.source_policy?.web === 'required' ? 'required' : fallback.source_policy?.web === 'allowed' ? 'allowed' : 'forbidden';
  } else if (kind === 'file_write') {
    sourcePolicy.web = fallback.source_policy?.web === 'required' ? 'required' : fallback.source_policy?.web === 'allowed' ? 'allowed' : 'forbidden';
    allowedActions = ['read', 'write'];
    completionCriteria.requires_web = sourcePolicy.web === 'required';
    completionCriteria.requires_write = true;
  } else {
    sourcePolicy.web = fallback.source_policy?.web || 'forbidden';
    sourcePolicy.knowledge = fallback.source_policy?.knowledge || 'allowed';
    sourcePolicy.local_skills = fallback.source_policy?.local_skills || 'allowed';
    completionCriteria.requires_web = sourcePolicy.web === 'required';
  }
  return {
    ...fallback,
    task_kind: kind,
    source_policy: sourcePolicy,
    material_policy: { ...(fallback.material_policy || {}) },
    direct_url_policy: { ...(fallback.direct_url_policy || {}) },
    allowed_actions: allowedActions,
    forbidden_actions: forbiddenActions,
    completion_criteria: completionCriteria,
  };
}

function normalizePlannerIntent(raw = {}, fallback = {}) {
  const taskKind = INTENT_TYPES.has(String(raw.task_kind || '')) ? String(raw.task_kind) : fallback.task_kind;
  const confidence = Math.min(Math.max(Number(raw.confidence) || 0, 0), 1);
  const compiled = compileIntent(taskKind, fallback);
  return {
    ...compiled,
    needs_planner: false,
    needs_clarification: Boolean(fallback.needs_clarification) || Boolean(raw.needs_clarification) || confidence < 0.55,
    missing_slots: Array.isArray(raw.missing_slots) ? raw.missing_slots.map(String).slice(0, 5) : fallback.missing_slots,
    planner_confidence: confidence,
  };
}

async function semanticPlan({ userQuery, fallbackIntent, llmConfig, sessionId, runId } = {}) {
  if (!llmConfig?.llmApiKey || !llmConfig?.llmBaseUrl || !llmConfig?.llmModel) {
    return { intent: { ...fallbackIntent, needs_clarification: true }, used: false, failed: true };
  }
  try {
    const response = await completeChat([{
      role: 'user',
      content: [
        '把用户任务归一为 Notus Turn Frame。只返回 JSON，不解释。',
        'task_kind 只能是 general、skill_discovery、skill_install、skill_create、mcp_manage、web_research、knowledge_research、file_read、file_write。',
        '明确“搜索/寻找 Skill”不得归为安装；明确联网不得改为本地来源。',
        'JSON 字段：task_kind、source_policy、material_policy、completion_criteria、needs_clarification、missing_slots、confidence。',
        `用户任务：${normalizeText(userQuery)}`,
        `确定性候选：${JSON.stringify(fallbackIntent)}`,
      ].join('\n'),
    }], {
      responseFormat: { type: 'json_object' },
      taskType: 'agent_turn_frame',
      temperature: 0,
      maxOutputTokens: 420,
      config: llmConfig,
    });
    if (response?.usage && sessionId) {
      recordRunUsage({ sessionId, runId, sourceType: 'turn_planner', provider: llmConfig.llmProvider, model: llmConfig.llmModel, usage: response.usage, usageSource: 'provider' });
    }
    const parsed = JSON.parse(String(response?.message?.content || '{}'));
    return { intent: normalizePlannerIntent(parsed, fallbackIntent), used: true, failed: false };
  } catch {
    return { intent: { ...fallbackIntent, needs_clarification: true }, used: true, failed: true };
  }
}

function buildClarification(intent = {}) {
  if (!intent.needs_clarification) return null;
  const skillOptions = [
    { id: 'skill_discovery', label: '查找公开 Skill', answer_value: 'skill_discovery' },
    { id: 'skill_install', label: '安装 Skill', answer_value: 'skill_install' },
    { id: 'skill_create', label: '创建 Skill', answer_value: 'skill_create' },
  ];
  const generalOptions = [
    { id: 'research', label: '查找资料', answer_value: 'web_research' },
    { id: 'read', label: '读取并分析', answer_value: 'file_read' },
    { id: 'edit', label: '修改或创建内容', answer_value: 'file_write' },
  ];
  const specializedQuestions = intent.ambiguity_kind === 'web_permission'
    ? [{
      id: 'web_permission',
      slot: 'web_permission',
      label: '这次是否允许访问互联网？',
      type: 'single_select',
      required: true,
      options: [
        { id: 'web_required', label: '允许并进行联网搜索', answer_value: 'web_required' },
        { id: 'web_forbidden', label: '禁止联网，只用本地材料', answer_value: 'web_forbidden' },
      ],
      allow_custom: false,
    }]
    : intent.ambiguity_kind === 'url_selection'
    ? [{
      id: 'url_selection',
      slot: 'url_selection',
      label: '未明确指定的链接是否也要读取？',
      type: 'single_select',
      required: true,
      options: [
        { id: 'inspect_selected', label: '只读明确授权的链接', answer_value: 'inspect_selected' },
        { id: 'inspect_none', label: '不要读取任何链接', answer_value: 'inspect_none' },
      ],
      allow_custom: false,
    }]
    : null;
  return {
    reason_code: 'ambiguous_primary_intent',
    title: '需要确认任务范围',
    intro: '当前输入可能对应不同的材料或操作，请先确认后继续。',
    questions: specializedQuestions || [{
      id: 'primary_intent',
      slot: 'primary_intent',
      label: '这次希望 Notus 主要做什么？',
      type: 'single_select',
      required: true,
      options: intent.ambiguity_kind === 'skill_action' ? skillOptions : generalOptions,
      allow_custom: true,
    }],
  };
}

function clarificationIntent(interaction, fallback) {
  if (!interaction || interaction?.payload?.origin !== 'turn_composer' || interaction.status !== 'answered') return fallback;
  const webPermission = String(interaction?.response?.answers?.web_permission?.value || interaction?.response?.answers?.web_permission?.text || '').trim();
  if (['web_required', 'web_forbidden'].includes(webPermission)) {
    const sourcePolicy = {
      ...(fallback.source_policy || {}),
      web: webPermission === 'web_required' ? 'required' : 'forbidden',
    };
    const pendingUrls = webPermission === 'web_required' ? fallback.direct_url_policy?.pending_urls || [] : [];
    return {
      ...fallback,
      task_kind: webPermission === 'web_required' && fallback.task_kind === 'general' ? 'web_research' : fallback.task_kind,
      source_policy: sourcePolicy,
      direct_url_policy: {
        ...(fallback.direct_url_policy || {}),
        inspect_urls: pendingUrls,
        blocked_urls: webPermission === 'web_required'
          ? fallback.direct_url_policy?.explicitly_blocked_urls || []
          : fallback.direct_url_policy?.blocked_urls || [],
        pending_urls: [],
      },
      completion_criteria: {
        ...(fallback.completion_criteria || {}),
        requires_web: webPermission === 'web_required',
      },
      needs_clarification: false,
      missing_slots: [],
      planner_confidence: 1,
    };
  }
  if (fallback.ambiguity_kind === 'web_permission') {
    return {
      ...fallback,
      source_policy: { ...(fallback.source_policy || {}), web: 'forbidden' },
      completion_criteria: { ...(fallback.completion_criteria || {}), requires_web: false },
      needs_clarification: false,
      missing_slots: [],
      planner_confidence: 1,
    };
  }
  const urlSelection = String(interaction?.response?.answers?.url_selection?.value || interaction?.response?.answers?.url_selection?.text || '').trim();
  if (['inspect_selected', 'inspect_none'].includes(urlSelection)) {
    const inspectUrls = urlSelection === 'inspect_selected' ? fallback.direct_url_policy?.inspect_urls || [] : [];
    return {
      ...fallback,
      source_policy: { ...(fallback.source_policy || {}), direct_urls: inspectUrls.length ? 'inspect_selected' : 'do_not_inspect' },
      direct_url_policy: { ...(fallback.direct_url_policy || {}), inspect_urls: inspectUrls },
      needs_clarification: false,
      missing_slots: [],
      planner_confidence: 1,
    };
  }
  if (fallback.ambiguity_kind === 'url_selection') {
    return {
      ...fallback,
      source_policy: { ...(fallback.source_policy || {}), direct_urls: 'do_not_inspect' },
      direct_url_policy: { ...(fallback.direct_url_policy || {}), inspect_urls: [] },
      needs_clarification: false,
      missing_slots: [],
      planner_confidence: 1,
    };
  }
  const answer = interaction?.response?.answers?.primary_intent;
  const value = String(answer?.value || answer?.text || '').trim();
  if (!INTENT_TYPES.has(value)) return { ...fallback, needs_clarification: false };
  return {
    ...compileIntent(value, fallback),
    needs_clarification: false,
    missing_slots: [],
    planner_confidence: 1,
  };
}

async function composeTurnFrame({ task, session, userQuery, mentions = [], attachments = [], activeFileId = null, webSearchEnabled = false, llmConfig, runId = null, resumeInteraction = null, allowSemanticPlanner = true } = {}) {
  const existing = getTaskTurnFrame(task?.id);
  if (existing && !resumeInteraction) return { frame: existing, clarification: null, reused: true };
  const activeFile = activeFileId ? getFileById(activeFileId) : null;
  const normalizedMentions = (Array.isArray(mentions) ? mentions : []).map(normalizeMention);
  const attachmentFacts = (Array.isArray(attachments) ? attachments : []).map((item) => ({
    name: String(item?.name || item?.file_name || item?.filename || '').slice(0, 240),
    stored_name_digest: item?.stored_name || item?.storedName ? sha256(String(item.stored_name || item.storedName)) : '',
  }));
  const context = { activeFile, mentions: normalizedMentions, attachments: attachmentFacts, webSearchEnabled };
  const deterministic = deterministicIntent(userQuery, context);
  const planner = deterministic.needs_planner && allowSemanticPlanner
    ? await semanticPlan({ userQuery, fallbackIntent: deterministic, llmConfig, sessionId: session?.id, runId })
    : { intent: deterministic, used: false, failed: false };
  const intent = clarificationIntent(resumeInteraction, planner.intent);
  const facts = {
    input_hash: sha256(normalizeText(userQuery)),
    source_message_id: task?.user_message_id || null,
    mentions: normalizedMentions,
    attachments: attachmentFacts,
    active_file: activeFile ? { id: Number(activeFile.id), path: activeFile.path, title: activeFile.title, hash: activeFile.hash || sha256(activeFile.content || '') } : null,
    captured_at: new Date().toISOString(),
  };
  const fingerprint = sha256(JSON.stringify({ input_hash: facts.input_hash, facts: { mentions: facts.mentions, attachments: facts.attachments, active_file: facts.active_file }, intent }));
  const frame = createTurnFrame({
    conversationId: task?.conversation_id || session?.conversation_id,
    sessionId: session?.id,
    taskId: task?.id,
    sourceMessageId: task?.user_message_id,
    parentFrameId: existing?.id || null,
    changeReason: existing ? 'interaction_answer' : 'initial',
    facts,
    intent,
    provenance: {
      deterministic_signals: deterministic.signals,
      semantic_planner_used: planner.used,
      semantic_planner_failed: planner.failed,
      resumed_from_interaction_id: resumeInteraction?.id || null,
    },
    confidence: Number(intent.planner_confidence ?? (planner.used ? 0.6 : 0.98)),
    fingerprint,
  });
  return { frame, clarification: buildClarification(intent), reused: false };
}

function formatTurnFrameForPrompt(frame = {}) {
  const intent = frame.intent || {};
  const activeFile = intent.material_policy?.use_current_file ? frame.facts?.active_file : null;
  return [
    '## 当前轮任务契约',
    `- 主意图：${intent.task_kind || 'general'}`,
    `- 联网来源：${intent.source_policy?.web || 'allowed'}`,
    `- 知识库来源：${intent.source_policy?.knowledge || 'allowed'}`,
    `- 本地 Skill：${intent.source_policy?.local_skills || 'allowed'}`,
    `- 允许动作：${(intent.allowed_actions || []).join('、') || 'read'}`,
    `- 禁止动作：${(intent.forbidden_actions || []).join('、') || '无额外限制'}`,
    activeFile ? `- 本轮明确当前文件：${activeFile.path}` : '- 本轮没有明确使用编辑器当前文件。',
    '任务契约由运行时生成。不得把搜索升级成安装，不得用被禁止的来源代替必需来源。',
  ].join('\n');
}

module.exports = {
  CURRENT_FILE_REFERENCE,
  clarificationIntent,
  compileIntent,
  composeTurnFrame,
  deterministicIntent,
  formatTurnFrameForPrompt,
  sanitizeUrl,
};
