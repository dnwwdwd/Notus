const fs = require('fs');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { getFileByPath, sha256 } = require('./files');
const { getOperationSetById } = require('./canvasOperationSets');
const { resolveInsideNotes } = require('./agentPathRules');

function normalizePositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function parseJson(value, fallback = []) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function replaceOnce(content, oldText, newText) {
  const source = String(content || '');
  const oldValue = String(oldText || '');
  const nextValue = String(newText || '');
  if (!oldValue) return source ? source : nextValue;
  const index = source.indexOf(oldValue);
  if (index < 0) return source;
  return `${source.slice(0, index)}${nextValue}${source.slice(index + oldValue.length)}`;
}

function contentHash(exists, content) {
  return exists ? sha256(String(content || '')) : '';
}

function formatSummary(row, counts = {}) {
  if (!row) return null;
  return {
    id: Number(row.id),
    session_id: Number(row.session_id),
    conversation_id: normalizePositiveInt(row.conversation_id),
    approval_mode: String(row.approval_mode || 'auto_confirm'),
    status: String(row.status || 'empty'),
    current_operation_set_id: normalizePositiveInt(row.current_operation_set_id),
    version: Number(row.version || 0),
    file_count: Number(counts.file_count || 0),
    directory_count: Number(counts.directory_count || 0),
    pending_count: Number(counts.pending_count || 0),
    applied_count: Number(counts.applied_count || 0),
    rolled_back_count: Number(counts.rolled_back_count || 0),
    discarded_count: Number(counts.discarded_count || 0),
    media_change_count: Number(counts.media_change_count || 0),
    conflict_count: Number(counts.conflict_count || 0),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    completed_at: row.completed_at || null,
  };
}

function getCounts(changeSetId, db = getDb()) {
  const itemCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN resource_kind = 'file' THEN 1 ELSE 0 END) AS file_count,
      SUM(CASE WHEN resource_kind = 'directory' THEN 1 ELSE 0 END) AS directory_count,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied_count,
      SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) AS conflict_count
    FROM agent_task_change_items WHERE change_set_id = ?
  `).get(changeSetId) || {};
  const operationSetIds = db.prepare(`
    SELECT id FROM canvas_operation_sets WHERE task_change_set_id = ? ORDER BY batch_sequence_no ASC
  `).all(changeSetId);
  const statusPaths = {
    applied: new Set(),
    rolled_back: new Set(),
    discarded: new Set(),
  };
  let mediaChangeCount = 0;
  operationSetIds.forEach((row) => {
    const operationSet = getOperationSetById(row.id);
    if (!operationSet) return;
    mediaChangeCount += Array.isArray(operationSet.media_changes) ? operationSet.media_changes.length : 0;
    const entries = operationSet.revision_type === 'file_revision'
      ? [{
        status: operationSet.status,
        file_path: operationSet.revision?.file_path || operationSet.revision_file_path,
      }]
      : (Array.isArray(operationSet.patches) ? operationSet.patches : []);
    entries.forEach((entry, index) => {
      const status = String(entry?.status || '').trim();
      const pathKey = String(entry?.file_path || entry?.new_path || entry?.old_path || `${row.id}:${index}`);
      if (['applied', 'auto_applied'].includes(status)) statusPaths.applied.add(pathKey);
      if (status === 'rolled_back') statusPaths.rolled_back.add(pathKey);
      if (status === 'discarded') statusPaths.discarded.add(pathKey);
    });
  });
  return {
    ...itemCounts,
    applied_count: Math.max(Number(itemCounts.applied_count || 0), statusPaths.applied.size),
    rolled_back_count: statusPaths.rolled_back.size,
    discarded_count: statusPaths.discarded.size,
    media_change_count: mediaChangeCount,
  };
}

function getTaskChangeSetBySession(sessionId) {
  const sid = normalizePositiveInt(sessionId);
  if (!sid) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_task_change_sets WHERE session_id = ?').get(sid);
  return row ? formatSummary(row, getCounts(row.id, db)) : null;
}

function ensureTaskChangeSet({ sessionId, conversationId = null, approvalMode = 'auto_confirm' } = {}) {
  const sid = normalizePositiveInt(sessionId);
  if (!sid) throw new Error('session_id is required');
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_task_change_sets (session_id, conversation_id, approval_mode)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      conversation_id = COALESCE(excluded.conversation_id, agent_task_change_sets.conversation_id),
      approval_mode = excluded.approval_mode,
      updated_at = datetime('now')
  `).run(sid, normalizePositiveInt(conversationId), String(approvalMode || 'auto_confirm'));
  return getTaskChangeSetBySession(sid);
}

function findItemForPath(db, changeSetId, filePath) {
  return db.prepare(`
    SELECT * FROM agent_task_change_items
    WHERE change_set_id = ? AND resource_kind = 'file'
      AND (pending_path = ? OR applied_path = ? OR base_path = ? OR resource_key = ?)
    ORDER BY id ASC LIMIT 1
  `).get(changeSetId, filePath, filePath, filePath, filePath);
}

function findDirectoryItemForPath(db, changeSetId, folderPath) {
  return db.prepare(`
    SELECT * FROM agent_task_change_items
    WHERE change_set_id = ? AND resource_kind = 'directory'
      AND (pending_path = ? OR applied_path = ? OR base_path = ? OR resource_key = ?)
    ORDER BY id ASC LIMIT 1
  `).get(changeSetId, folderPath, folderPath, folderPath, folderPath);
}

function upsertFileItem(db, changeSet, batchNo, patch, revision = null) {
  const filePath = String(revision?.file_path || patch?.file_path || patch?.path || '');
  if (!filePath) return;
  const existing = findItemForPath(db, changeSet.id, filePath);
  const diskFile = getFileByPath(filePath);
  const isCreate = String(patch?.change_type || '') === 'create' && !diskFile;
  const baseExists = existing ? Boolean(existing.base_exists) : !isCreate && Boolean(diskFile || revision?.base_hash);
  const baseContent = existing ? existing.base_content : String(revision?.base_content ?? diskFile?.content ?? '');
  const appliedExists = existing ? Boolean(existing.applied_exists) : baseExists;
  const appliedContent = existing ? existing.applied_content : baseContent;
  const sourceContent = existing ? existing.pending_content : baseContent;
  const pendingContent = revision
    ? String(revision.draft_content || '')
    : replaceOnce(sourceContent, patch?.old, patch?.new);
  const pendingExists = String(patch?.change_type || '') !== 'delete';
  const resourceKey = existing?.resource_key || filePath;
  const values = {
    baseExists,
    basePath: existing?.base_path || filePath,
    baseContent,
    appliedExists,
    appliedPath: existing?.applied_path || filePath,
    appliedContent,
    pendingExists,
    pendingPath: filePath,
    pendingContent,
  };
  db.prepare(`
    INSERT INTO agent_task_change_items (
      change_set_id, resource_key, resource_kind,
      base_exists, base_path, base_hash, base_content,
      applied_exists, applied_path, applied_hash, applied_content,
      pending_exists, pending_path, pending_hash, pending_content,
      status, first_batch_no, last_batch_no
    ) VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(change_set_id, resource_key) DO UPDATE SET
      pending_exists = excluded.pending_exists,
      pending_path = excluded.pending_path,
      pending_hash = excluded.pending_hash,
      pending_content = excluded.pending_content,
      status = 'pending',
      last_batch_no = excluded.last_batch_no,
      updated_at = datetime('now')
  `).run(
    changeSet.id,
    resourceKey,
    values.baseExists ? 1 : 0,
    values.basePath,
    contentHash(values.baseExists, values.baseContent),
    values.baseContent,
    values.appliedExists ? 1 : 0,
    values.appliedPath,
    contentHash(values.appliedExists, values.appliedContent),
    values.appliedContent,
    values.pendingExists ? 1 : 0,
    values.pendingPath,
    contentHash(values.pendingExists, values.pendingContent),
    values.pendingContent,
    batchNo,
    batchNo
  );
}

function upsertPathItem(db, changeSet, batchNo, patch) {
  const changeType = String(patch?.change_type || '');
  if (!changeType) return;
  if (changeType === 'move_file') {
    const oldPath = String(patch.old_path || patch.file_path || '');
    const existing = findItemForPath(db, changeSet.id, oldPath);
    if (existing) {
      db.prepare(`
        UPDATE agent_task_change_items
        SET pending_path = ?, pending_hash = ?, status = 'pending', last_batch_no = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(String(patch.new_path || ''), existing.pending_hash || existing.applied_hash || existing.base_hash || '', batchNo, existing.id);
      return;
    }
    const diskFile = getFileByPath(oldPath);
    const content = String(diskFile?.content || '');
    const nextPath = String(patch.new_path || '');
    db.prepare(`
      INSERT INTO agent_task_change_items (
        change_set_id, resource_key, resource_kind,
        base_exists, base_path, base_hash, base_content,
        applied_exists, applied_path, applied_hash, applied_content,
        pending_exists, pending_path, pending_hash, pending_content,
        status, first_batch_no, last_batch_no
      ) VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?)
    `).run(
      changeSet.id,
      oldPath,
      diskFile ? 1 : 0,
      oldPath,
      contentHash(Boolean(diskFile), content),
      content,
      diskFile ? 1 : 0,
      oldPath,
      contentHash(Boolean(diskFile), content),
      content,
      nextPath,
      contentHash(true, content),
      content,
      batchNo,
      batchNo
    );
    return;
  }
  const oldPath = String(patch.old_path || patch.folder_path || patch.file_path || '');
  const newPath = String(patch.new_path || patch.folder_path || patch.file_path || '');
  const resourceKey = oldPath || newPath;
  if (!resourceKey) return;
  const existing = findDirectoryItemForPath(db, changeSet.id, oldPath || newPath);
  const baseExists = changeType !== 'create_folder';
  const pendingExists = changeType !== 'delete_folder';
  db.prepare(`
    INSERT INTO agent_task_change_items (
      change_set_id, resource_key, resource_kind,
      base_exists, base_path, applied_exists, applied_path,
      pending_exists, pending_path, status, first_batch_no, last_batch_no
    ) VALUES (?, ?, 'directory', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(change_set_id, resource_key) DO UPDATE SET
      pending_exists = excluded.pending_exists,
      pending_path = excluded.pending_path,
      status = 'pending',
      last_batch_no = excluded.last_batch_no,
      updated_at = datetime('now')
  `).run(
    changeSet.id,
    existing?.resource_key || resourceKey,
    existing ? Number(existing.base_exists) : (baseExists ? 1 : 0),
    existing?.base_path || oldPath,
    existing ? Number(existing.applied_exists) : (baseExists ? 1 : 0),
    existing?.applied_path || oldPath,
    pendingExists ? 1 : 0,
    newPath,
    batchNo,
    batchNo
  );
}

function registerOperationSet({ operationSetId, sessionId, conversationId, approvalMode, executionSegmentId, toolUseId } = {}) {
  const operationSet = getOperationSetById(operationSetId);
  if (!operationSet) throw new Error('operation_set not found');
  const sid = normalizePositiveInt(sessionId || operationSet.agent_session_id);
  if (!sid || Number(operationSet.agent_session_id) !== sid) throw new Error('session operation set mismatch');
  const changeSet = ensureTaskChangeSet({ sessionId: sid, conversationId: conversationId || operationSet.conversation_id, approvalMode });
  const db = getDb();
  return db.transaction(() => {
    const linked = db.prepare('SELECT task_change_set_id, batch_sequence_no FROM canvas_operation_sets WHERE id = ?').get(operationSet.id);
    if (linked?.task_change_set_id) return getTaskChangeSetBySession(sid);
    const next = linked?.batch_sequence_no
      ? Number(linked.batch_sequence_no)
      : Number(db.prepare('SELECT COALESCE(MAX(batch_sequence_no), 0) + 1 AS value FROM canvas_operation_sets WHERE task_change_set_id = ?').get(changeSet.id)?.value || 1);
    db.prepare(`
      UPDATE canvas_operation_sets
      SET task_change_set_id = ?, execution_segment_id = ?, batch_sequence_no = ?, tool_use_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(changeSet.id, normalizePositiveInt(executionSegmentId), next, String(toolUseId || '') || null, operationSet.id);

    const raw = db.prepare('SELECT * FROM canvas_operation_sets WHERE id = ?').get(operationSet.id);
    if (String(raw.revision_type || '') === 'file_revision') {
      upsertFileItem(db, changeSet, next, null, {
        file_path: raw.revision_file_path,
        base_hash: raw.revision_base_hash,
        base_content: raw.revision_base_content,
        draft_content: raw.revision_draft_content,
      });
    } else {
      parseJson(raw.pathes_json, []).forEach((patch) => {
        if (['create_folder', 'rename_folder', 'move_folder', 'move_file', 'delete_folder'].includes(String(patch?.change_type || ''))) {
          upsertPathItem(db, changeSet, next, patch);
        } else {
          upsertFileItem(db, changeSet, next, patch);
        }
      });
    }
    db.prepare(`
      UPDATE agent_task_change_sets
      SET current_operation_set_id = ?, status = 'pending', version = version + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(operationSet.id, changeSet.id);
    return getTaskChangeSetBySession(sid);
  })();
}

function readDiskSnapshot(resourceKind, relativePath) {
  const normalizedPath = String(relativePath || '');
  if (!normalizedPath) return { exists: false, path: normalizedPath, content: '', hash: '' };
  try {
    const target = resolveInsideNotes(getEffectiveConfig().notesDir, normalizedPath);
    if (!fs.existsSync(target.absolutePath)) return { exists: false, path: target.relativePath, content: '', hash: '' };
    if (resourceKind === 'directory') {
      const exists = fs.statSync(target.absolutePath).isDirectory();
      return { exists, path: target.relativePath, content: '', hash: '' };
    }
    const content = fs.readFileSync(target.absolutePath, 'utf8');
    return { exists: true, path: target.relativePath, content, hash: sha256(content) };
  } catch {
    return { exists: false, path: normalizedPath, content: '', hash: '' };
  }
}

function patchTouchesAliases(patch, aliases) {
  return [patch?.file_path, patch?.folder_path, patch?.old_path, patch?.new_path]
    .map((value) => String(value || ''))
    .some((value) => value && aliases.has(value));
}

function buildExpectedSnapshot(item, patches, rawSet) {
  let exists = Boolean(item.applied_exists);
  let currentPath = String(item.applied_path || item.base_path || item.pending_path || '');
  let content = String(item.applied_content || '');
  const aliases = new Set([item.resource_key, item.base_path, item.applied_path, item.pending_path].map((value) => String(value || '')).filter(Boolean));
  if (String(rawSet?.revision_type || '') === 'file_revision' && ['applied', 'partial'].includes(String(rawSet.status || ''))) {
    exists = true;
    currentPath = String(rawSet.revision_file_path || currentPath);
    content = String(rawSet.revision_draft_content || '');
  }
  (Array.isArray(patches) ? patches : []).forEach((patch) => {
    if (!patchTouchesAliases(patch, aliases)) return;
    const status = String(patch?.status || 'pending');
    if (!['applied', 'auto_applied'].includes(status)) return;
    const nextPath = String(patch?.new_path || patch?.file_path || patch?.folder_path || '');
    const oldPath = String(patch?.old_path || patch?.file_path || patch?.folder_path || '');
    if (oldPath) aliases.add(oldPath);
    if (nextPath) aliases.add(nextPath);
    const changeType = String(patch?.change_type || 'modify');
    if (['move_file', 'rename_folder', 'move_folder'].includes(changeType) && nextPath) currentPath = nextPath;
    else if (changeType === 'create_folder') {
      exists = true;
      currentPath = nextPath;
    } else if (changeType === 'delete_folder' || changeType === 'delete') {
      exists = false;
      content = '';
    } else if (changeType === 'create') {
      exists = true;
      currentPath = String(patch.file_path || currentPath);
      content = String(patch.new || '');
    } else if (item.resource_kind === 'file') {
      currentPath = String(patch.file_path || currentPath);
      content = replaceOnce(content, patch.old, patch.new);
    }
  });
  return {
    exists,
    path: currentPath,
    content: exists && item.resource_kind === 'file' ? content : '',
    hash: exists && item.resource_kind === 'file' ? sha256(content) : '',
  };
}

function snapshotsMatch(expected, actual, resourceKind) {
  if (Boolean(expected.exists) !== Boolean(actual.exists)) return false;
  if (!expected.exists) return true;
  if (String(expected.path || '') !== String(actual.path || '')) return false;
  if (resourceKind === 'directory') return true;
  return String(expected.hash || '') === String(actual.hash || '');
}

function resolveOperationSetInDb(db, { operationSetId, sessionId, resolution, toolResult = {} } = {}) {
  const setId = normalizePositiveInt(operationSetId);
  const sid = normalizePositiveInt(sessionId);
  if (!setId || !sid) throw new Error('operation_set_id and session_id are required');
  const set = db.prepare('SELECT * FROM canvas_operation_sets WHERE id = ? AND agent_session_id = ?').get(setId, sid);
  if (!set?.task_change_set_id) return getTaskChangeSetBySession(sid);
  const operationSet = getOperationSetById(setId);
  const patches = Array.isArray(operationSet?.patches) ? operationSet.patches : [];
    db.prepare(`
      INSERT INTO agent_operation_resolutions (session_id, operation_set_id, resolution, tool_result_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(operation_set_id) DO UPDATE SET
        resolution = excluded.resolution,
        tool_result_json = excluded.tool_result_json,
        status = 'resolved',
        updated_at = datetime('now')
    `).run(sid, setId, String(resolution || 'discarded'), JSON.stringify(toolResult || {}));
  const items = db.prepare(`
    SELECT * FROM agent_task_change_items WHERE change_set_id = ? AND last_batch_no = ?
  `).all(set.task_change_set_id, Number(set.batch_sequence_no || 0));
  items.forEach((item) => {
    const snapshot = buildExpectedSnapshot(item, patches, set);
    const diskSnapshot = readDiskSnapshot(item.resource_kind, snapshot.path);
    if (!snapshotsMatch(snapshot, diskSnapshot, item.resource_kind)) {
      db.prepare(`
        UPDATE agent_task_change_items
        SET pending_exists = ?, pending_path = ?, pending_hash = ?, pending_content = ?,
            status = 'conflict', updated_at = datetime('now')
        WHERE id = ?
      `).run(snapshot.exists ? 1 : 0, snapshot.path, snapshot.hash, snapshot.content, item.id);
      return;
    }
    db.prepare(`
      UPDATE agent_task_change_items
      SET applied_exists = ?, applied_path = ?, applied_hash = ?, applied_content = ?,
          pending_exists = ?, pending_path = ?, pending_hash = ?, pending_content = ?,
          status = 'applied', updated_at = datetime('now')
      WHERE id = ?
    `).run(
      snapshot.exists ? 1 : 0,
      snapshot.path,
      snapshot.hash,
      snapshot.content,
      snapshot.exists ? 1 : 0,
      snapshot.path,
      snapshot.hash,
      snapshot.content,
      item.id
    );
  });
    db.prepare(`
      DELETE FROM agent_task_change_items
      WHERE change_set_id = ?
        AND base_exists = applied_exists
        AND base_path = applied_path
        AND base_hash = applied_hash
        AND pending_exists = applied_exists
        AND pending_path = applied_path
        AND pending_hash = applied_hash
    `).run(set.task_change_set_id);
    const pending = db.prepare("SELECT COUNT(*) AS value FROM agent_task_change_items WHERE change_set_id = ? AND status = 'pending'").get(set.task_change_set_id);
    const conflicts = db.prepare("SELECT COUNT(*) AS value FROM agent_task_change_items WHERE change_set_id = ? AND status = 'conflict'").get(set.task_change_set_id);
    db.prepare(`
      UPDATE agent_task_change_sets
      SET status = ?, version = version + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(Number(conflicts?.value || 0) > 0 ? 'conflict' : (Number(pending?.value || 0) > 0 ? 'pending' : 'applied'), set.task_change_set_id);
  return getTaskChangeSetBySession(sid);
}

function resolveOperationSet(options = {}) {
  const db = getDb();
  return db.transaction(() => resolveOperationSetInDb(db, options))();
}

function resumeNonManualOperationConfirmation({ operationSetId, sessionId, resolution, toolResult = {} } = {}) {
  const setId = normalizePositiveInt(operationSetId);
  const sid = normalizePositiveInt(sessionId);
  if (!setId || !sid) return { resumed: false, changeSet: null };
  const db = getDb();
  return db.transaction(() => {
    const checkpoint = db.prepare(`
      SELECT * FROM agent_checkpoints
      WHERE session_id = ? AND status = 'active' AND pending_operation_set_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(sid, setId);
    const session = db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(sid);
    if (!checkpoint || !['waiting_operation_confirmation', 'queued_resume'].includes(String(session?.status || ''))) {
      return { resumed: false, changeSet: getTaskChangeSetBySession(sid) };
    }
    const changeSet = resolveOperationSetInDb(db, { operationSetId: setId, sessionId: sid, resolution, toolResult });
    db.prepare(`
      UPDATE agent_checkpoints
      SET resume_tool_result_json = ?, phase = 'after_tools'
      WHERE id = ?
    `).run(JSON.stringify({
      content: typeof toolResult?.content === 'string' ? toolResult.content : JSON.stringify(toolResult || {}),
      is_error: Boolean(toolResult?.is_error),
    }), checkpoint.id);
    if (checkpoint.execution_segment_id) {
      db.prepare(`
        UPDATE agent_execution_segments
        SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(checkpoint.execution_segment_id);
    }
    db.prepare(`
      UPDATE agent_sessions
      SET status = 'queued_resume', waiting_since = NULL,
          state_version = state_version + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(sid);
    db.prepare(`
      UPDATE agent_task_queue
      SET status = CASE WHEN status = 'waiting_operation_confirmation' THEN 'queued' ELSE status END,
          resume_requested = CASE WHEN status = 'running' THEN 1 ELSE 0 END,
          run_id = CASE WHEN status = 'waiting_operation_confirmation' THEN NULL ELSE run_id END,
          last_error_json = NULL, updated_at = datetime('now')
      WHERE session_id = ? AND status NOT IN ('completed','cancelled','failed')
    `).run(sid);
    return { resumed: true, changeSet };
  })();
}

function markTaskChangeSetFinished(sessionId, sessionStatus) {
  const sid = normalizePositiveInt(sessionId);
  if (!sid) return null;
  const db = getDb();
  const status = ['failed', 'cancelled'].includes(String(sessionStatus || '')) ? String(sessionStatus) : 'completed';
  db.prepare(`
    UPDATE agent_task_change_sets
    SET status = CASE WHEN status = 'pending' THEN status ELSE ? END,
        completed_at = datetime('now'), updated_at = datetime('now')
    WHERE session_id = ?
  `).run(status, sid);
  return getTaskChangeSetBySession(sid);
}

function getTaskChangeSetDetail(sessionId) {
  const summary = getTaskChangeSetBySession(sessionId);
  if (!summary) return null;
  const db = getDb();
  const items = db.prepare(`
    SELECT * FROM agent_task_change_items
    WHERE change_set_id = ? ORDER BY first_batch_no ASC, id ASC
  `).all(summary.id).map((row) => ({
    id: Number(row.id),
    resource_key: row.resource_key,
    resource_kind: row.resource_kind,
    base_exists: Boolean(row.base_exists),
    base_path: row.base_path,
    base_hash: row.base_hash,
    base_content: row.base_content,
    applied_exists: Boolean(row.applied_exists),
    applied_path: row.applied_path,
    applied_hash: row.applied_hash,
    applied_content: row.applied_content,
    pending_exists: Boolean(row.pending_exists),
    pending_path: row.pending_path,
    pending_hash: row.pending_hash,
    pending_content: row.pending_content,
    status: row.status,
    first_batch_no: Number(row.first_batch_no),
    last_batch_no: Number(row.last_batch_no),
  }));
  const operationSets = db.prepare(`
    SELECT id, status, batch_sequence_no, execution_segment_id, tool_use_id, created_at, updated_at
    FROM canvas_operation_sets WHERE task_change_set_id = ? ORDER BY batch_sequence_no ASC
  `).all(summary.id).map((row) => ({
    id: Number(row.id),
    status: row.status,
    batch_sequence_no: Number(row.batch_sequence_no),
    execution_segment_id: normalizePositiveInt(row.execution_segment_id),
    tool_use_id: row.tool_use_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  const operationSetSources = operationSets.map((summary) => {
    const operationSet = getOperationSetById(summary.id);
    return {
      ...summary,
      revision_file_path: operationSet?.revision?.file_path || operationSet?.revision_file_path || '',
      patches: Array.isArray(operationSet?.patches) ? operationSet.patches : [],
      media_changes: Array.isArray(operationSet?.media_changes) ? operationSet.media_changes : [],
    };
  });
  const segmentSequences = new Map(db.prepare(
    'SELECT id, sequence_no FROM agent_execution_segments WHERE session_id = ?'
  ).all(summary.session_id).map((row) => [Number(row.id), Number(row.sequence_no || 0)]));
  const patches = items.map((item) => ({
    patch_id: `task-change-${item.id}`,
    file_path: item.pending_path || item.applied_path || item.base_path,
    old_path: item.base_path,
    new_path: item.pending_path || item.applied_path,
    old: item.resource_kind === 'file' ? item.base_content : item.base_path,
    new: item.resource_kind === 'file' ? (['pending', 'conflict'].includes(item.status) ? item.pending_content : item.applied_content) : (item.pending_path || item.applied_path),
    change_type: item.resource_kind === 'directory'
      ? (!item.base_exists ? 'create_folder' : 'move_folder')
      : (!item.base_exists ? 'create' : (!item.pending_exists && !item.applied_exists ? 'delete' : 'modify')),
    status: item.status,
    source_batches: operationSetSources.filter((batch) => {
      const aliases = new Set([
        item.resource_key,
        item.base_path,
        item.applied_path,
        item.pending_path,
      ].map((value) => String(value || '')).filter(Boolean));
      if (String(batch.revision_file_path || '') && aliases.has(String(batch.revision_file_path))) return true;
      return batch.patches.some((patch) => patchTouchesAliases(patch, aliases));
    }).map((batch) => ({
      batch_sequence_no: batch.batch_sequence_no,
      execution_segment_id: batch.execution_segment_id,
      execution_segment_sequence_no: segmentSequences.get(Number(batch.execution_segment_id)) || 0,
      status: batch.status,
    })),
  }));
  return {
    ...summary,
    items,
    operation_sets: operationSets,
    operation_set_view: {
      id: summary.current_operation_set_id || summary.id,
      task_change_set_id: summary.id,
      agent_session_id: summary.session_id,
      conversation_id: summary.conversation_id,
      mode: 'task_cumulative',
      type: 'task_cumulative',
      status: summary.status,
      operations: [],
      patches,
      media_changes: operationSetSources.flatMap((batch) => batch.media_changes || []),
      created_at: summary.created_at,
      updated_at: summary.updated_at,
    },
  };
}

module.exports = {
  ensureTaskChangeSet,
  getTaskChangeSetBySession,
  getTaskChangeSetDetail,
  markTaskChangeSetFinished,
  registerOperationSet,
  resumeNonManualOperationConfirmation,
  resolveOperationSet,
};
