const { getDb } = require('./db');
const { hasUnknownToolOutcome } = require('./agentRuntimeFacts');

const RESOURCE_MUTATION_TOOLS = new Set([
  'install_skill_from_git', 'install_skill_draft', 'update_skill_draft',
  'set_skill_enabled', 'update_skill_from_git', 'uninstall_skill',
  'add_mcp_server', 'update_mcp_server', 'set_mcp_server_enabled', 'remove_mcp_server',
  'skill_install_git', 'skill_install', 'skill_update', 'skill_uninstall', 'skill_disable', 'mcp_remove',
]);

function isResourceMutationTool(toolName = '') {
  return RESOURCE_MUTATION_TOOLS.has(String(toolName || ''));
}

function hasSuccessfulResearch(sessionId, sourceType) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM agent_research_receipts
    WHERE session_id = ? AND source_type = ? AND status IN ('success','partial')
      AND (result_count > 0 OR source_ref != '')
    LIMIT 1
  `).get(Number(sessionId), String(sourceType)));
}

function hasOperationSet(sessionId) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM canvas_operation_sets
    WHERE agent_session_id = ?
    LIMIT 1
  `).get(Number(sessionId)));
}

function hasResourceChangeEvidence(sessionId) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM agent_runtime_facts
    WHERE session_id = ?
      AND fact_type IN ('tool_call_completed','tool_call_outcome_resolved')
      AND json_extract(payload_json, '$.tool_name') IN (
          'install_skill_from_git','install_skill_draft','update_skill_draft',
          'set_skill_enabled','update_skill_from_git','uninstall_skill',
          'add_mcp_server','update_mcp_server','set_mcp_server_enabled','remove_mcp_server',
          'skill_install_git','skill_install','skill_update','skill_uninstall','skill_disable','mcp_remove'
        )
      AND json_extract(payload_json, '$.resource_changed') = 1
    LIMIT 1
  `).get(Number(sessionId)));
}

function hasSkillDraftEvidence(sessionId) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM agent_runtime_facts
    WHERE session_id = ? AND fact_type = 'tool_call_completed'
      AND json_extract(payload_json, '$.tool_name') IN ('create_skill_draft','update_skill_draft')
    LIMIT 1
  `).get(Number(sessionId)));
}

function evaluateCompletion({ sessionId, frame, finalText = '', correctionCount = 0 } = {}) {
  const criteria = frame?.intent?.completion_criteria || {};
  const reasons = [];
  if (hasUnknownToolOutcome(sessionId)) reasons.push('存在无法确认外部结果的工具调用');
  if (criteria.requires_web && !hasSuccessfulResearch(sessionId, 'web')) reasons.push('用户要求联网，但没有成功的联网来源事实');
  if (criteria.requires_write && !hasOperationSet(sessionId)) reasons.push('用户要求修改或创建文件，但没有文件预览或变更记录');
  if (criteria.requires_skill_draft && !hasSkillDraftEvidence(sessionId)) reasons.push('用户要求创建 Skill，但没有生成并校验 Skill 草稿');
  if (criteria.requires_resource_change && !hasResourceChangeEvidence(sessionId)) reasons.push('用户要求资源变更，但没有已执行的资源变更事实');
  if (criteria.requires_answer && !String(finalText || '').trim()) reasons.push('没有可交付的回答');
  if (!reasons.length) return { complete: true, reasons: [], correctable: false, feedback: '' };
  const correctable = correctionCount < 1 && !hasUnknownToolOutcome(sessionId);
  return {
    complete: false,
    reasons,
    correctable,
    feedback: [
      '## 运行时完成检查',
      '当前结果还没有满足本轮任务契约：',
      ...reasons.map((reason) => `- ${reason}`),
      '请只补充缺失步骤；不要声称未发生的搜索、读取、安装或文件修改已经完成。',
    ].join('\n'),
  };
}

module.exports = {
  evaluateCompletion,
  hasOperationSet,
  hasResourceChangeEvidence,
  hasSkillDraftEvidence,
  hasSuccessfulResearch,
  isResourceMutationTool,
};
