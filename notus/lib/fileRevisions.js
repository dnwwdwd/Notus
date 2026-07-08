const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { getFileByPath } = require('./files');
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
  if (explicit) return normalizeAgentPath(explicit, { ensureMarkdown: true });

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
  ].some((pattern) => pattern.test(text));
}

function analyzeRevisionSafety({
  baseContent = '',
  draftContent = '',
  goal = '',
} = {}) {
  const base = normalizeRevisionContent(baseContent);
  const draft = normalizeRevisionContent(draftContent);
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
  if (baseChars >= 200 && draftChars > 0 && draftChars < Math.min(120, Math.floor(baseChars * 0.08))) {
    reasons.push('草稿体量远小于原文，疑似只生成了片段或摘要');
  }
  if (
    baseChars >= 1000
    && draftChars > 0
    && (baseChars - draftChars) / Math.max(baseChars, 1) >= 0.65
    && !explicitReduction
    && !explicitEmpty
  ) {
    reasons.push('草稿删除了原文大部分内容，但用户任务没有明确要求大幅删减');
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
  if (startsWithFrontmatter(base) && !startsWithFrontmatter(draft)) {
    reasons.push('原文包含 frontmatter，但草稿丢失了文件元数据');
  }
  if (hasUnbalancedCodeFence(draft)) {
    reasons.push('草稿中的 Markdown 代码围栏没有闭合');
  }

  const requiresConfirmation = reasons.length > 0;
  return {
    requires_confirmation: requiresConfirmation,
    risk_level: requiresConfirmation ? 'high' : 'normal',
    reasons,
    base_char_count: baseChars,
    draft_char_count: draftChars,
    base_line_count: baseLines,
    draft_line_count: draftLines,
    message: requiresConfirmation
      ? `全文修订草稿存在高风险：${reasons.join('；')}。已保留预览等待手动确认，自动模式不会写入正式文件。`
      : '',
  };
}

async function previewFileRevision({
  filePath = '',
  file_path: snakeFilePath = '',
  draftContent = '',
  draft_content: snakeDraftContent = '',
  parentOperationSetId = null,
  parent_operation_set_id: snakeParentOperationSetId = null,
} = {}, sessionId) {
  const session = getSession(sessionId);
  let normalizedPath;
  try {
    normalizedPath = resolveRevisionFilePath(session, filePath || snakeFilePath);
  } catch (error) {
    return { error: 'FILE_PATH_REQUIRED', message: error.message };
  }

  const check = validateWrite(session.session_token, normalizedPath, 'modify');
  if (!check.valid) return { error: 'PERMISSION_DENIED', reason: check.reason, path: normalizedPath };
  const file = getFileByPath(normalizedPath);
  if (!file) return { error: 'FILE_NOT_FOUND', path: normalizedPath };

  const baseContent = normalizeRevisionContent(file.content || '');
  const draft = normalizeRevisionContent(draftContent || snakeDraftContent);
  const baseHash = hashRevisionContent(baseContent);
  const draftHash = hashRevisionContent(draft);
  const safety = analyzeRevisionSafety({
    baseContent,
    draftContent: draft,
    goal: session.goal,
  });
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
    revisionError: safety.message,
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
    applied: false,
    safety,
    requires_confirmation: safety.requires_confirmation,
    message: safety.message,
  };
}

async function applyFileRevision(operationSetId, sessionId, { auto = false } = {}) {
  const set = getRevisionStorageSet(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (!isFileRevisionSet(set)) return { success: false, error: 'NOT_FILE_REVISION' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  if (set.status === 'applied') {
    return { success: true, applied: true, changed_files: [], operation_set: getOperationSetById(set.id), status: 'applied' };
  }
  if (set.status !== 'pending') return { success: false, error: 'REVISION_NOT_PENDING', revision_status: set.status };

  const filePath = set.revision_file_path;
  const file = filePath ? getFileByPath(filePath) : null;
  if (!file) {
    const failed = updateRevisionFailure(set, 'apply_failed', 'FILE_NOT_FOUND');
    return { success: false, error: 'FILE_NOT_FOUND', operation_set: failed, status: 'apply_failed' };
  }
  if (auto) {
    const session = getSession(sessionId);
    const safety = analyzeRevisionSafety({
      baseContent: set.revision_base_content || '',
      draftContent: set.revision_draft_content || '',
      goal: session.goal,
    });
    if (safety.requires_confirmation) {
      const operationSet = updateRevisionFailure(set, 'pending', safety.message || 'REVISION_REQUIRES_CONFIRMATION');
      return {
        success: true,
        applied: false,
        requires_confirmation: true,
        error: 'REVISION_REQUIRES_CONFIRMATION',
        message: safety.message || '全文修订草稿存在高风险，已保留预览等待手动确认，正式文件尚未修改。',
        changed_files: [],
        operation_set: operationSet,
        safety,
        status: 'pending',
      };
    }
  }

  const currentContent = normalizeRevisionContent(file.content || '');
  const currentHash = hashRevisionContent(currentContent);
  if (currentHash !== set.revision_base_hash) {
    const stale = updateRevisionFailure(set, 'stale', '文件内容已变化，需要重新生成预览');
    return { success: false, conflict: true, error: 'REVISION_STALE', status: 'stale', operation_set: stale };
  }

  try {
    atomicWriteRevisionFile(filePath, set.revision_draft_content || '', set.id);
    const nextFile = getFileByPath(filePath);
    const appliedHash = hashRevisionContent(nextFile?.content || '');
    const operationSet = updateOperationSet(set.id, {
      status: 'applied',
      revisionAppliedHash: appliedHash,
      revisionAppliedAt: nowSql(),
      revisionError: '',
    });
    scheduleIncrementalIndex(filePath);
    return {
      success: true,
      applied: true,
      changed_files: [filePath],
      operation_set: operationSet,
      status: 'applied',
      applied_hash: appliedHash,
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

async function rollbackFileRevision(operationSetId, sessionId) {
  const set = getRevisionStorageSet(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (!isFileRevisionSet(set)) return { success: false, error: 'NOT_FILE_REVISION' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  if (!['applied', 'rollback_conflict'].includes(String(set.status || ''))) {
    return { success: false, error: 'REVISION_NOT_APPLIED', revision_status: set.status };
  }
  if (!set.revision_applied_hash) {
    const conflict = updateRevisionFailure(set, 'rollback_conflict', '缺少 applied_hash，不能安全回滚');
    return { success: false, conflict: true, error: 'APPLIED_HASH_REQUIRED', operation_set: conflict, status: 'rollback_conflict' };
  }

  const filePath = set.revision_file_path;
  const file = filePath ? getFileByPath(filePath) : null;
  if (!file) {
    const conflict = updateRevisionFailure(set, 'rollback_conflict', 'FILE_NOT_FOUND');
    return { success: false, conflict: true, error: 'FILE_NOT_FOUND', operation_set: conflict, status: 'rollback_conflict' };
  }

  const currentHash = hashRevisionContent(file.content || '');
  if (currentHash !== set.revision_applied_hash) {
    const conflict = updateRevisionFailure(set, 'rollback_conflict', '文件已在应用后发生变化，不能安全回滚');
    return { success: false, conflict: true, error: 'ROLLBACK_CONFLICT', operation_set: conflict, status: 'rollback_conflict' };
  }

  try {
    atomicWriteRevisionFile(filePath, set.revision_base_content || '', set.id);
    const operationSet = updateOperationSet(set.id, {
      status: 'rolled_back',
      revisionRolledBackAt: nowSql(),
      revisionError: '',
    });
    scheduleIncrementalIndex(filePath);
    return {
      success: true,
      rolled_back: true,
      changed_files: [filePath],
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
