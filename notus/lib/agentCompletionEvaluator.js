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

function normalizeEvidenceText(value = '') {
  return String(value || '').toLocaleLowerCase().replace(/[\s_-]+/g, '');
}

function hasMatchingVerificationEvidence(sessionId, frame = {}) {
  const verification = frame?.intent?.verification || {};
  if (verification.policy === 'direct') return true;
  const subjects = (verification.research_subjects || []).map((item) => normalizeEvidenceText(item.raw_name)).filter(Boolean);
  const rows = getDb().prepare(`
    SELECT query, source_title, source_ref, summary, details_json
    FROM agent_research_receipts
    WHERE session_id = ? AND source_type IN ('web','explicit_url')
      AND status IN ('success','partial') AND (result_count > 0 OR source_ref != '')
    ORDER BY id DESC LIMIT 100
  `).all(Number(sessionId));
  if (!rows.length) return false;
  if (!subjects.length) return true;
  return subjects.every((subject) => rows.some((row) => normalizeEvidenceText([
    row.query, row.source_title, row.source_ref, row.summary, row.details_json,
  ].join(' ')).includes(subject)));
}

function hasOperationSet(sessionId, appliedOnly = false) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM canvas_operation_sets
    WHERE agent_session_id = ? AND (? = 0 OR status = 'applied')
    LIMIT 1
  `).get(Number(sessionId), appliedOnly ? 1 : 0));
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
  const verification = frame?.intent?.verification || {};
  if (verification.policy && verification.policy !== 'direct' && verification.network_allowed !== false
    && !hasMatchingVerificationEvidence(sessionId, frame)) {
    reasons.push('查证证据没有对应用户指定的完整研究对象或待核实问题');
  }
  if (verification.negative_claim_requires_evidence
    && /不存在|没有这个|用户记错|你记错|无法部署|不能部署|不支持|虚构/i.test(String(finalText || ''))
    && !hasMatchingVerificationEvidence(sessionId, frame)) {
    reasons.push('确定性否定结论缺少对应对象的可核验证据；没有结果只能说明本次未查到');
  }
  if (criteria.requires_write && !hasOperationSet(sessionId, criteria.requires_applied_write)) reasons.push(criteria.requires_applied_write
    ? '用户要求继续保存文件，但本轮没有已应用的文件变更'
    : '用户要求修改或创建文件，但没有文件预览或变更记录');
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
  hasMatchingVerificationEvidence,
  isResourceMutationTool,
};
