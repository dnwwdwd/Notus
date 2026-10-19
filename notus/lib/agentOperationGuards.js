const { getDb } = require('./db');
const { getOperationSetById } = require('./canvasOperationSets');

function findPendingManualOperation(conversationId) {
  const rows = getDb().prepare(`SELECT o.id FROM canvas_operation_sets o
    JOIN agent_task_queue q ON q.session_id = o.agent_session_id
    WHERE o.conversation_id = ? AND q.approval_mode IN ('manual', 'manual_confirm')
      AND o.status IN ('pending', 'partial', 'apply_failed', 'stale', 'rollback_conflict')
    ORDER BY o.id DESC`).all(Number(conversationId));
  return rows.map(row => getOperationSetById(row.id)).find(set => set && (set.revision_type === 'file_revision'
    || set.patches?.some(patch => ['pending', 'failed', 'applying'].includes(patch.status || 'pending')))) || null;
}

function patchPaths(patch = {}) {
  return [patch.file_path, patch.folder_path, patch.old_path, patch.new_path, patch.revision_file_path].filter(Boolean);
}

// 回滚按真实依赖倒序执行，避免先撤销目录移动后留下指向旧路径的文件回执。
function rollbackDependencyError(set, patchIndex = null) {
  const patch = patchIndex === null ? set : set.patches?.[patchIndex];
  if (!patch) return null;
  const paths = patchPaths(patch);
  const rows = getDb().prepare('SELECT id FROM canvas_operation_sets WHERE agent_session_id = ? AND id >= ? ORDER BY id').all(set.agent_session_id, set.id);
  for (const row of rows) {
    const candidate = getOperationSetById(row.id);
    const items = candidate.revision_type === 'file_revision' ? [candidate] : candidate.patches || [];
    const later = items.filter((item, index) => (row.id > set.id || (patchIndex !== null && index > patchIndex))
      && ['applied', 'auto_applied'].includes(item.status));
    const isTextPatch = item => !item.revision_type && !/create|folder|move|delete|rename/.test(item.change_type || '') && typeof item.old === 'string' && typeof item.new === 'string' && item.old && item.new;
    const independentText = item => isTextPatch(item) && isTextPatch(patch) && ![item.old, item.new].some(text => [patch.old, patch.new].some(prior => text.includes(prior) || prior.includes(text)));
    if (later.some(item => !independentText(item) && ((patch.file_id && Number(item.file_id) === Number(patch.file_id))
      || patchPaths(item).some(right => paths.some(left => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)))))) {
      return { success: false, conflict: true, error: 'LATER_OPERATION_APPLIED', message: '请先回滚同一文件或目录的后续修改，再回滚这项操作。' };
    }
  }
  return null;
}
module.exports = { findPendingManualOperation, rollbackDependencyError };
