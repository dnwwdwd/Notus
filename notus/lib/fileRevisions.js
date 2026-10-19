const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { getFileByPath, getFileById, resolveFileReferencePath, updateFile } = require('./files');
const { repairImageHeadingMarkdown } = require('../utils/markdownImageHeadings');
const { parseFrontmatter } = require('./markdownMeta');
const { triggerIncrementalIndex } = require('./indexer');
const {
  createDiffHunks,
  hashRevisionContent,
  normalizeRevisionContent,
} = require('./fileRevisionDiff');
const {
  createOperationSet,
  getOperationSetById,
  updateOperationSet,
} = require('./canvasOperationSets');
const {
  buildMediaChanges,
  ensureConversationImagesInMarkdown,
  materializeConversationImages,
} = require('./conversationImageAssets');
const {
  getSession,
  normalizeAgentPath,
  resolveInsideNotes,
  validateWrite,
} = require('./agentSession');

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function isFileRevisionSet(operationSet = {}) {
  return String(operationSet?.revision_type || operationSet?.type || operationSet?.mode || '').trim() === 'file_revision';
}

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function getRevisionStorageSet(operationSetId) {
  const id = normalizePositiveInt(operationSetId);
  if (!id) return null;
  const row = getDb().prepare(`
    SELECT *
    FROM canvas_operation_sets
    WHERE id = ?
  `).get(id);
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    agent_session_id: normalizePositiveInt(row.agent_session_id),
    conversation_id: normalizePositiveInt(row.conversation_id),
    file_id: normalizePositiveInt(row.file_id),
  };
}

function extractGoalFilePath(goal = '') {
  const text = String(goal || '');
  const match = text.match(/当前文章路径：([^\n\r]+)/);
  return match ? match[1].trim() : '';
}

function resolveRevisionFilePath(session = {}, inputPath = '') {
  const explicit = String(inputPath || '').trim();
  if (explicit) return resolveFileReferencePath(explicit);

  const row = getDb().prepare(`
    SELECT files.path
    FROM conversations
    JOIN files ON files.id = conversations.file_id
    WHERE conversations.id = ?
    LIMIT 1
  `).get(normalizePositiveInt(session.conversation_id));
  if (row?.path) return normalizeAgentPath(row.path, { ensureMarkdown: true });

  const goalPath = extractGoalFilePath(session.goal);
  if (goalPath) return normalizeAgentPath(goalPath, { ensureMarkdown: true });

  throw new Error('当前会话没有绑定文件，请在 preview_file_revision 中提供 file_path');
}

function scheduleIncrementalIndex(relativePath) {
  triggerIncrementalIndex(relativePath).catch((error) => {
    console.warn('[AgentLoop] file_revision 增量索引失败（非致命）:', relativePath, error.message);
  });
}

function syncDirectory(targetPath) {
  try {
    const fd = fs.openSync(path.dirname(targetPath), 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
}

function atomicWriteRevisionFile(relativePath, content, operationSetId, notesDir = getEffectiveConfig().notesDir) {
  const target = resolveInsideNotes(notesDir, relativePath);
  fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
  const tmpPath = `${target.absolutePath}.notus-revision-${operationSetId || process.pid}-${Date.now()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, normalizeRevisionContent(content), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, target.absolutePath);
    syncDirectory(target.absolutePath);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    throw error;
  }
  return target.relativePath;
}

function updateRevisionFailure(operationSet, status, errorMessage) {
  return updateOperationSet(operationSet.id, {
    status,
    revisionError: String(errorMessage || ''),
  });
}

function markSupersededPendingRevisions({ conversationId, fileId, filePath, excludeId = null }) {
  const db = getDb();
  const params = [
    Number(conversationId),
    Number(fileId || 0),
    String(filePath || ''),
    Number(excludeId || 0),
  ];
  db.prepare(`
    UPDATE canvas_operation_sets
    SET status = 'superseded',
        updated_at = datetime('now')
    WHERE conversation_id = ?
      AND status = 'pending'
      AND COALESCE(revision_type, '') = 'file_revision'
      AND (
        (file_id IS NOT NULL AND file_id = ?)
        OR revision_file_path = ?
      )
      AND id != ?
  `).run(...params);
}

function nextSequenceNo(conversationId, fileId, filePath) {
  const row = getDb().prepare(`
    SELECT MAX(COALESCE(revision_sequence_no, 0)) AS sequence_no
    FROM canvas_operation_sets
    WHERE conversation_id = ?
      AND COALESCE(revision_type, '') = 'file_revision'
      AND (
        (file_id IS NOT NULL AND file_id = ?)
        OR revision_file_path = ?
      )
  `).get(Number(conversationId), Number(fileId || 0), String(filePath || ''));
  return Number(row?.sequence_no || 0) + 1;
}

function isDestructiveEmptyRevision(baseContent = '', draftContent = '') {
  return String(baseContent || '').trim().length > 0 && String(draftContent || '').trim().length === 0;
}

function countLines(content = '') {
  const value = normalizeRevisionContent(content);
  if (!value) return 0;
  return value.split('\n').length;
}

function countNonWhitespaceChars(content = '') {
  return String(content || '').replace(/\s+/g, '').length;
}

function startsWithFrontmatter(content = '') {
  return /^---\n[\s\S]*?\n---(?:\n|$)/.test(normalizeRevisionContent(content));
}

// 全文修订草稿通常只包含正文。原文的 frontmatter（含 Notus 内部 id 与用户元数据）
// 不应因为模型没有重复输出就丢失：草稿缺少 frontmatter 时原样保留原文元数据。
// 模型显式提交新的合法 frontmatter，或用户明确要求删除元数据时，以草稿为准。
function hasExplicitFrontmatterRemovalIntent(goal = '') {
  const text = String(goal || '').trim();
  if (!text) return false;
  return [
    /(删除|移除|去掉|清除)[^。！？；\n]{0,12}(frontmatter|元数据|头部属性|文件属性)/i,
    /(frontmatter|元数据)[^。！？；\n]{0,12}(删除|移除|去掉|清除)/i,
  ].some((pattern) => pattern.test(text));
}

function looksLikeFrontmatterStart(content = '') {
  // 只把“开头连续若干行都是 key: value”视为残缺 frontmatter；
  // 正文分隔线后跟普通段落或 URL 时不提示。
  const lines = normalizeRevisionContent(content).split('\n').slice(1);
  const head = [];
  for (const line of lines) {
    if (!line.trim()) break;
    if (head.length >= 20) break;
    head.push(line);
  }
  if (head.length === 0) return false;
  return head.every((line) => /^[A-Za-z_][A-Za-z0-9_-]*:\s*(?!\/\/)\S/.test(line));
}

function mergeMissingSystemFrontmatter(baseContent = '', draftContent = '') {
  const baseParsed = parseFrontmatter(baseContent);
  const draftParsed = parseFrontmatter(draftContent);
  if (!baseParsed.raw || !draftParsed.raw) return draftContent;
  return injectMissingSystemFields(baseParsed.data, draftContent, draftParsed);
}

function injectMissingSystemFields(baseData = {}, draftContent = '', draftParsed = {}) {
  // 模型自己写了 frontmatter 但漏掉 Notus 内部字段时补齐，避免文件丢失稳定 id，
  // 也避免系统元数据被编辑器当成正文显示。
  const missing = ['id', 'created_by'].filter((key) => (
    String(baseData[key] || '').trim()
    && !String(draftParsed.data?.[key] || '').trim()
  ));
  if (missing.length === 0) return draftContent;
  const extra = missing
    .map((key) => {
      const value = String(baseData[key]).trim();
      // created_by 在原文中通常是不带引号的裸值，保持原样可读。
      const literal = key === 'created_by' && /^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value);
      return `${key}: ${literal}`;
    })
    .join('\n');
  const draftBlock = draftContent.slice(0, draftParsed.end).replace(/\n+$/, '');
  const closingIndex = draftBlock.lastIndexOf('\n---');
  const inner = draftBlock.slice(4, closingIndex);
  const body = draftContent.slice(draftParsed.end).replace(/^\n+/, '');
  return `---\n${extra}\n${inner}\n---\n\n${body}`;
}

// 草稿以 `---` 开头、后面连续是 key: value 但没有闭合时，按残缺 frontmatter 修复：
// 补齐原文内部字段并补上结束分隔线，避免残缺块被当成正文。
function repairIncompleteFrontmatter(baseData = {}, draftContent = '') {
  const normalized = normalizeRevisionContent(draftContent);
  if (!/^---\n/.test(normalized) || startsWithFrontmatter(normalized) || !looksLikeFrontmatterStart(normalized)) {
    return null;
  }
  const lines = normalized.split('\n');
  let end = 1;
  while (end < lines.length && lines[end].trim()) end += 1;
  const frontmatterLines = lines.slice(1, end);
  const body = lines.slice(end).join('\n').replace(/^\n+/, '');
  const repaired = `---\n${frontmatterLines.join('\n')}\n---\n\n${body}`;
  const parsed = parseFrontmatter(repaired);
  return injectMissingSystemFields(baseData, repaired, parsed);
}

function preserveBaseFrontmatter(baseContent = '', draftContent = '', goal = '') {
  const base = normalizeRevisionContent(baseContent);
  const draft = normalizeRevisionContent(draftContent);
  // 空草稿保持为空；补回 frontmatter 会让“误生成空草稿”看起来像正常修改。
  if (!draft.trim()) return draft;
  if (!startsWithFrontmatter(base)) return draft;
  if (hasExplicitFrontmatterRemovalIntent(goal)) return draft;
  const parsed = parseFrontmatter(base);
  if (!parsed.raw) return draft;
  // 草稿提交了合法 frontmatter 时以草稿为准，但补齐 Notus 内部稳定 id。
  if (startsWithFrontmatter(draft)) return mergeMissingSystemFrontmatter(base, draft);
  // 草稿写了残缺 frontmatter：补齐内部字段并闭合。
  const repaired = repairIncompleteFrontmatter(parsed.data, draft);
  if (repaired) return repaired;
  // 草稿没有 frontmatter（或开头是正文分隔线）时保留原文元数据。
  const block = base.slice(0, parsed.end).replace(/\n+$/, '');
  return `${block}\n\n${draft.replace(/^\n+/, '')}`;
}

function hasUnbalancedCodeFence(content = '') {
  const matches = normalizeRevisionContent(content).match(/^```/gm);
  return Boolean(matches && matches.length % 2 === 1);
}

function hasTruncationMarker(content = '') {
  return /\[(?:已按上下文预算截断|已截断|内容截断|truncated)\]|\.{3}\s*\[已截断/.test(String(content || ''));
}

function hasExplicitEmptyRevisionIntent(goal = '') {
  const text = String(goal || '').trim();
  if (!text) return false;
  return [
    /清空.*(文章|正文|内容|文档|文件)/,
    /(文章|正文|内容|文档|文件).*清空/,
    /删除.*(全文|全部内容|所有内容|整篇|文章内容|正文内容)/,
    /(全文|全部内容|所有内容|整篇|文章内容|正文内容).*删除/,
    /删掉.*(全文|全部内容|所有内容|整篇|文章内容|正文内容)/,
    /(全文|全部内容|所有内容|整篇|文章内容|正文内容).*删掉/,
  ].some((pattern) => pattern.test(text));
}

function hasExplicitReductionIntent(goal = '') {
  const text = String(goal || '').trim();
  if (!text) return false;
  return [
    /精简/,
    /压缩/,
    /缩短/,
    /删减/,
    /裁剪/,
    /摘要/,
    /提炼/,
    /提纲/,
    /浓缩/,
    /减少.*(字数|篇幅|内容|段落)/,
    /(字数|篇幅|内容|段落).*减少/,
  ].some((pattern) => pattern.test(text));
}

function hasExplicitRewriteIntent(goal = '') {
  const text = String(goal || '').trim();
  if (!text) return false;
  return [
    /重写/,
    /改写/,
    /重构/,
    /重组/,
    /重新组织/,
    /整体调整/,
    /整篇.*(改|写|优化|润色)/,
    /(全文|整篇).*重/,
    // 用户明确要求大范围/全面改写时，正文比例变化是预期结果，不应被当成截断。
    /(大范围|大面积|大规模|全面|大幅|大量|整体|批量|全篇|全文|整篇|全部)[^。！？；\n]{0,12}(修改|改写|重写|调整|更新|优化|润色|改造|改|变成|换成)/,
    /(修改|改写|重写|调整|更新|优化|润色|改造|改成|改为|换成)[^。！？；\n]{0,12}(大范围|大面积|大规模|全面|大幅|大量|整体|批量|全篇|全文|整篇|全部)/,
    /大改|大修|全部改|整体重做|重新写/,
  ].some((pattern) => pattern.test(text));
}

function analyzeRevisionSafety({
  baseContent = '',
  draftContent = '',
  goal = '',
} = {}) {
  const base = normalizeRevisionContent(baseContent);
  const rawDraft = normalizeRevisionContent(draftContent);
  const draft = preserveBaseFrontmatter(base, rawDraft, goal);
  const baseChars = countNonWhitespaceChars(base);
  const draftChars = countNonWhitespaceChars(draft);
  const baseLines = countLines(base);
  const draftLines = countLines(draft);
  const explicitEmpty = hasExplicitEmptyRevisionIntent(goal);
  const explicitReduction = hasExplicitReductionIntent(goal);
  const explicitRewrite = hasExplicitRewriteIntent(goal);
  const reasons = [];

  if (isDestructiveEmptyRevision(base, draft) && !explicitEmpty) {
    reasons.push('草稿为空，会清空当前非空文件');
  }
  // 绝对下限：即使明确要求大范围改写，也不能接受只回一句摘要就覆盖全文。
  if (
    baseChars >= 200
    && draftChars > 0
    && draftChars < Math.min(120, Math.floor(baseChars * 0.08))
    && !explicitReduction
    && !explicitEmpty
  ) {
    reasons.push('草稿体量远小于原文，疑似只生成了片段或摘要');
  }
  if (
    baseChars >= 1000
    && draftChars > 0
    && (baseChars - draftChars) / Math.max(baseChars, 1) >= 0.65
    && !explicitReduction
    && !explicitEmpty
    && !explicitRewrite
  ) {
    reasons.push('草稿删除了原文大部分内容，但用户任务没有明确要求大幅删减或改写');
  }
  if (
    baseLines >= 20
    && draftLines > 0
    && draftLines <= Math.max(3, Math.floor(baseLines * 0.2))
    && !explicitReduction
    && !explicitEmpty
    && !explicitRewrite
  ) {
    reasons.push('草稿行数骤降，疑似遗漏未修改段落');
  }
  if (hasTruncationMarker(draft)) {
    reasons.push('草稿包含截断标记，不能作为完整文件落盘');
  }
  // 只有草稿确实像是未闭合的 frontmatter 时才提示；正文开头的 Markdown 分隔线不算。
  if (/^---\n/.test(rawDraft) && !startsWithFrontmatter(rawDraft) && looksLikeFrontmatterStart(rawDraft)) {
    reasons.push('草稿的 frontmatter 没有正确闭合');
  }
  if (hasUnbalancedCodeFence(draft) && !hasUnbalancedCodeFence(base)) {
    reasons.push('草稿中的 Markdown 代码围栏没有闭合');
  }

  // 自动模式始终应用修改；这些检查只作为提示写进 Diff 与回执，由回滚兜底，
  // 不再把自动模式降级成人工确认。手动模式本来就由用户确认，无需依赖该字段。
  const warnings = reasons;
  return {
    warnings,
    reasons: warnings,
    risk_level: warnings.length > 0 ? 'high' : 'normal',
    base_char_count: baseChars,
    draft_char_count: draftChars,
    base_line_count: baseLines,
    draft_line_count: draftLines,
    // 保留元数据后的最终草稿；预览、diff、应用和回滚都使用这份内容。
    draft_content: draft,
    message: warnings.length > 0
      ? `本次全文修订存在需要留意的变化：${warnings.join('；')}。修改仍会按当前确认方式应用，可在 Diff 中核对或回滚。`
      : '',
  };
}

async function previewFileRevision({
  filePath = '',
  file_path: snakeFilePath = '',
  allow_image_changes = false,
  draftContent = '',
  draft_content: snakeDraftContent = '',
  parentOperationSetId = null,
  parent_operation_set_id: snakeParentOperationSetId = null,
} = {}, sessionId, _notesDir, context = {}) {
  const session = getSession(sessionId);
  let normalizedPath;
  try {
    normalizedPath = resolveRevisionFilePath(session, filePath || snakeFilePath);
  } catch (error) {
    return { error: error.code || 'FILE_PATH_REQUIRED', message: error.message };
  }

  const check = validateWrite(session.session_token, normalizedPath, 'modify');
  if (!check.valid) return { error: 'PERMISSION_DENIED', reason: check.reason, path: normalizedPath };
  const file = getFileByPath(normalizedPath);
  if (!file) return { error: 'FILE_NOT_FOUND', path: normalizedPath };

  const baseContent = normalizeRevisionContent(file.content || '');
  // 只做图片与标题边界修复；frontmatter 补齐统一由 analyzeRevisionSafety 完成，
  // 确保提示与实际写入使用同一份草稿。
  const rawDraft = normalizeRevisionContent(repairImageHeadingMarkdown(ensureConversationImagesInMarkdown(draftContent || snakeDraftContent, {
    conversationId: session.conversation_id,
    taskText: session.goal,
  })));
  const safety = analyzeRevisionSafety({
    baseContent,
    draftContent: rawDraft,
    goal: session.goal,
  });
  const draft = safety.draft_content;
  const imageIssue = require('./agentVision').validateImageChanges(baseContent, draft, { allow_image_changes });
  if (imageIssue) return imageIssue;
  const baseHash = hashRevisionContent(baseContent);
  const draftHash = hashRevisionContent(draft);
  if (baseHash === draftHash) {
    return {
      no_change: true,
      status: 'no_change',
      file_path: file.path,
      base_hash: baseHash,
      draft_hash: draftHash,
      message: '草稿内容与当前文件一致，没有生成修改预览。',
    };
  }

  markSupersededPendingRevisions({
    conversationId: session.conversation_id,
    fileId: file.id,
    filePath: file.path,
  });

  const operationSet = createOperationSet({
    conversationId: session.conversation_id,
    agentSessionId: session.id,
    executionSegmentId: context.executionSegmentId,
    toolUseId: context.toolUseId,
    fileId: file.id,
    articleHash: baseHash,
    mode: 'file_revision',
    operations: [],
    patches: [],
    status: 'pending',
    revisionType: 'file_revision',
    revisionFilePath: file.path,
    revisionBaseHash: baseHash,
    revisionDraftHash: draftHash,
    revisionBaseContent: baseContent,
    revisionDraftContent: draft,
    mediaChanges: buildMediaChanges({
      baseContent,
      draftContent: draft,
      filePath: file.path,
      fileId: file.id,
      conversationId: session.conversation_id,
    }),
    // 安全提示只进入工具回执与完成文案，不写入 revision_error，避免 Diff 把它显示成红色错误。
    revisionError: '',
    revisionParentId: parentOperationSetId || snakeParentOperationSetId,
    revisionSequenceNo: nextSequenceNo(session.conversation_id, file.id, file.path),
  });

  const latest = getOperationSetById(operationSet.id) || operationSet;
  return {
    operation_set_id: operationSet.id,
    status: latest.status || 'pending',
    file_path: file.path,
    base_hash: baseHash,
    draft_hash: draftHash,
    diff_hunks: createDiffHunks(baseContent, draft),
    changed_files: [],
    media_changes: latest.media_changes || [],
    applied: false,
    safety,
    requires_confirmation: false,
    message: safety.message,
  };
}

async function applyFileRevision(operationSetId, sessionId) {
  const set = getRevisionStorageSet(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (!isFileRevisionSet(set)) return { success: false, error: 'NOT_FILE_REVISION' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  if (set.status === 'applied') {
    return { success: true, applied: true, changed_files: [], file_id: set.file_id, file_path: set.revision_file_path, operation_set: getOperationSetById(set.id), status: 'applied' };
  }
  if (!['pending', 'apply_failed'].includes(set.status)) return { success: false, error: 'REVISION_NOT_PENDING', revision_status: set.status };

  const recordedPath = set.revision_file_path;
  let file = recordedPath ? getFileByPath(recordedPath) : null;
  if (!file && set.file_id) {
    // 预览后文件可能已被改名，按旧路径找不到时回退按 file_id 定位当前文件。
    file = getFileById(set.file_id);
  }
  if (!file) {
    const failed = updateRevisionFailure(set, 'apply_failed', 'FILE_NOT_FOUND');
    return { success: false, error: 'FILE_NOT_FOUND', operation_set: failed, status: 'apply_failed' };
  }
  const filePath = file.path;
  if (set.file_id && file.id !== set.file_id) {
    const stale = updateRevisionFailure(set, 'stale', '预览目标文件已变化，需要重新生成预览');
    return { success: false, conflict: true, error: 'FILE_IDENTITY_CHANGED', operation_set: stale, status: 'stale' };
  }
  // 自动模式不再因草稿形态降级为人工确认：真正写入仍受 base_hash 冲突检查保护，
  // 应用后可用回滚恢复。手动模式由用户自行确认。

  const currentContent = normalizeRevisionContent(file.content || '');
  const currentHash = hashRevisionContent(currentContent);
  if (currentHash !== set.revision_base_hash) {
    const stale = updateRevisionFailure(set, 'stale', '文件内容已变化，需要重新生成预览');
    return { success: false, conflict: true, error: 'REVISION_STALE', status: 'stale', operation_set: stale };
  }

  try {
    const existingMediaChanges = getOperationSetById(set.id)?.media_changes || [];
    const materialized = await materializeConversationImages({
      conversationId: set.conversation_id,
      content: set.revision_draft_content || '',
      filePath,
      fileId: file.id,
      mediaChanges: existingMediaChanges,
    });
    const latestSet = getRevisionStorageSet(set.id);
    if (latestSet?.status === 'applied') return { success: true, applied: true, changed_files: [], operation_set: getOperationSetById(set.id) };
    if (!['pending', 'apply_failed'].includes(latestSet?.status)) return { success: false, error: 'REVISION_NOT_PENDING' };
    const currentFile = getFileByPath(filePath);
    if (!currentFile || currentFile.id !== file.id || hashRevisionContent(normalizeRevisionContent(currentFile.content || '')) !== set.revision_base_hash) {
      const stale = updateRevisionFailure(set, 'stale', '文件内容已变化，需要重新生成预览');
      return { success: false, conflict: true, error: 'REVISION_STALE', operation_set: stale };
    }
    const savedFile = updateFile(file.id, normalizeRevisionContent(materialized.content));
    const finalPath = savedFile.path;
    const nextFile = getFileByPath(finalPath);
    const savedContent = normalizeRevisionContent(nextFile?.content || '');
    const appliedHash = hashRevisionContent(savedContent);
    const mediaChanges = materialized.media_changes.map((change) => (
      String(change?.file_path || '') === String(filePath)
        ? { ...change, file_path: finalPath }
        : change
    ));
    const operationSet = updateOperationSet(set.id, {
      status: 'applied',
      revisionFilePath: finalPath,
      revisionDraftContent: savedContent,
      revisionDraftHash: appliedHash,
      revisionAppliedHash: appliedHash,
      revisionAppliedAt: nowSql(),
      revisionError: '',
      mediaChanges,
    });
    scheduleIncrementalIndex(finalPath);
    return {
      success: true,
      applied: true,
      changed_files: [finalPath],
      operation_set: operationSet,
      status: 'applied',
      applied_hash: appliedHash,
      file_id: file.id,
      file_path: finalPath,
    };
  } catch (error) {
    const failed = updateRevisionFailure(set, 'apply_failed', error.message || 'APPLY_FAILED');
    return { success: false, error: 'APPLY_FAILED', message: error.message, operation_set: failed, status: 'apply_failed' };
  }
}

async function discardFileRevision(operationSetId, sessionId) {
  const set = getRevisionStorageSet(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (!isFileRevisionSet(set)) return { success: false, error: 'NOT_FILE_REVISION' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  if (!['pending', 'stale', 'apply_failed', 'rollback_conflict'].includes(String(set.status || ''))) {
    return { success: true, discarded: false, operation_set: getOperationSetById(set.id), status: set.status };
  }
  const operationSet = updateOperationSet(set.id, {
    status: 'discarded',
    revisionDiscardedAt: nowSql(),
    revisionError: '',
  });
  return { success: true, discarded: true, operation_set: operationSet, status: 'discarded' };
}

async function rollbackFileRevision(operationSetId, sessionId, { force = false } = {}) {
  const set = getRevisionStorageSet(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (!isFileRevisionSet(set)) return { success: false, error: 'NOT_FILE_REVISION' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  if (!['applied', 'rollback_conflict'].includes(String(set.status || ''))) {
    return { success: false, error: 'REVISION_NOT_APPLIED', revision_status: set.status };
  }
  const dependencyError = require('./agentOperationGuards').rollbackDependencyError(set);
  if (dependencyError) return dependencyError;
  if (!set.revision_applied_hash) {
    const conflict = updateRevisionFailure(set, 'rollback_conflict', '缺少 applied_hash，不能安全回滚');
    return { success: false, conflict: true, error: 'APPLIED_HASH_REQUIRED', operation_set: conflict, status: 'rollback_conflict' };
  }

  const recordedPath = set.revision_file_path;
  let file = recordedPath ? getFileByPath(recordedPath) : null;
  if (!file && set.file_id) {
    // 应用后文件可能已被改名，按旧路径找不到时回退按 file_id 定位当前文件。
    file = getFileById(set.file_id);
  }
  if (!file) {
    const conflict = updateRevisionFailure(set, 'rollback_conflict', 'FILE_NOT_FOUND');
    return { success: false, conflict: true, error: 'FILE_NOT_FOUND', operation_set: conflict, status: 'rollback_conflict' };
  }
  const filePath = file.path;
  if (set.file_id && file.id !== set.file_id) {
    const conflict = updateRevisionFailure(set, 'rollback_conflict', '回滚目标文件已变化');
    return { success: false, conflict: true, error: 'FILE_IDENTITY_CHANGED', operation_set: conflict, status: 'rollback_conflict' };
  }

  const currentHash = hashRevisionContent(file.content || '');
  if (currentHash !== set.revision_applied_hash && !force) {
    // 文件在应用后被外部改动。默认不覆盖，但允许用户二次确认后强制回滚。
    return {
      success: false,
      conflict: true,
      requires_force_confirmation: true,
      error: 'ROLLBACK_CONFLICT',
      message: '文件在应用后已被修改。继续回滚会覆盖这些外部改动，请确认后再试。',
      file_path: filePath,
      current_hash: currentHash,
      applied_hash: set.revision_applied_hash,
      status: String(set.status || ''),
    };
  }

  try {
    const savedFile = updateFile(file.id, normalizeRevisionContent(set.revision_base_content || ''));
    const restoredPath = savedFile.path;
    const mediaChanges = (Array.isArray(set.media_changes) ? set.media_changes : []).map((change) => (
      String(change?.file_path || '') === String(filePath)
        ? { ...change, file_path: restoredPath }
        : change
    ));
    const operationSet = updateOperationSet(set.id, {
      status: 'rolled_back',
      revisionFilePath: restoredPath,
      revisionRolledBackAt: nowSql(),
      revisionError: '',
      mediaChanges,
    });
    scheduleIncrementalIndex(restoredPath);
    return {
      success: true,
      rolled_back: true,
      changed_files: [restoredPath],
      operation_set: operationSet,
      status: 'rolled_back',
    };
  } catch (error) {
    const conflict = updateRevisionFailure(set, 'rollback_conflict', error.message || 'ROLLBACK_FAILED');
    return { success: false, error: 'ROLLBACK_FAILED', message: error.message, operation_set: conflict, status: 'rollback_conflict' };
  }
}

module.exports = {
  analyzeRevisionSafety,
  applyFileRevision,
  discardFileRevision,
  isFileRevisionSet,
  previewFileRevision,
  rollbackFileRevision,
};
