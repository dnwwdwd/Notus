const { getDb } = require('./db');
const { getOperationSetById } = require('./canvasOperationSets');
const { getSession, updateSessionStatus } = require('./agentSession');
const { cancelTask, getTaskBySession } = require('./agentTaskQueue');
const { getTaskChangeSetBySession, resolveOperationSet, resumeNonManualOperationConfirmation } = require('./agentTaskChangeSets');

// 只处理当前 checkpoint 所等待的批次。旧完成任务、重复确认和其他批次不能唤醒任务。
function resolveManualConfirmation({ operationSetId, sessionId, action, toolResult = {} }) {
  const db = getDb();
  return db.transaction(() => {
    const set = getOperationSetById(operationSetId);
    const session = getSession(sessionId);
    const unchanged = () => ({ resumed: false, changeSet: getTaskChangeSetBySession(sessionId) });
    if (!set || Number(set.agent_session_id) !== Number(sessionId) || !toolResult.success) return unchanged();
    const checkpoint = db.prepare(`SELECT id FROM agent_checkpoints WHERE session_id = ?
      AND pending_operation_set_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`).get(sessionId, operationSetId);
    const task = getTaskBySession(sessionId);
    if (!task || ['completed', 'cancelled', 'failed'].includes(task.status) || !checkpoint || session?.status !== 'waiting_operation_confirmation') return unchanged();
    const patches = Array.isArray(set.patches) ? set.patches : [];
    const rejected = /^(discard|rollback)/.test(action)
      || patches.some(patch => ['discarded', 'rolled_back'].includes(patch.status));
    if (rejected) {
      resolveOperationSet({ operationSetId, sessionId, resolution: 'discarded', toolResult });
      require('./agentControlPlane').requestCancellation(sessionId);
      updateSessionStatus(sessionId, 'cancelled');
      cancelTask(sessionId);
      return unchanged();
    }
    const fullyApplied = set.revision_type === 'file_revision' ? set.status === 'applied'
      : patches.length > 0 && patches.every(patch => ['applied', 'auto_applied'].includes(patch.status));
    if (!/^(apply|apply_all|apply_file)$/.test(action) || !fullyApplied) return unchanged();
    return resumeNonManualOperationConfirmation({ operationSetId, sessionId, resolution: 'applied',
      toolResult: { ...toolResult, operation_set_id: Number(operationSetId), applied: true,
        approval_mode: 'manual_confirm', message: '本批已应用。继续完成原任务剩余步骤，后续写入仍须生成预览等待用户确认。' } });
  })();
}

module.exports = { resolveManualConfirmation };
