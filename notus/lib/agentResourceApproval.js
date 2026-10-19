async function applyResourceApproval(payload, action) {
  if (action !== 'confirm') {
    if (payload.input_secret_id) await require('./secretStore').removeSecret(payload.input_secret_id);
    return { cancelled: true, action: payload.action };
  }
  if (payload.action === 'agent_resource_tool') {
    const { readSecret, removeSecret } = require('./secretStore');
    try {
      const input = JSON.parse(await readSecret(payload.input_secret_id));
      const result = await require('./agentTools').executeApprovedResourceTool(payload.tool_name, input, payload.agent_session_id);
      return { approved: true, action: payload.action, ...result };
    } finally { await removeSecret(payload.input_secret_id).catch(() => {}); }
  }
  if (payload.action === 'skill_install_git') {
    return require('./skills').installFromGit({
      repositoryUrl: String(payload.repository_url || '').trim(),
      conflictPolicy: 'reject',
    }).then((installed) => ({
      approved: true,
      action: payload.action,
      installed: (installed.skills || []).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        enabled: Boolean(skill.enabled),
      })),
    }));
  }
  if (payload.action === 'skill_install' || payload.action === 'skill_update') {
    const skill = require('./skills').installSkillDraft(payload.draft_id, payload.action === 'skill_update' ? 'replace' : 'reject');
    return { approved: true, action: payload.action, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } };
  }
  if (payload.action === 'skill_uninstall') {
    require('./skills').deleteSkill(payload.skill_id);
    return { approved: true, action: payload.action, deleted: true };
  }
  if (payload.action === 'skill_update_git') {
    const result = await require('./skills').updateSkillFromGit(payload.skill_id);
    return { approved: true, action: payload.action, job_id: result.jobId, skill: { id: result.skill.id, name: result.skill.name, enabled: result.skill.enabled } };
  }
  if (payload.action === 'skill_set_enabled' || payload.action === 'skill_disable') {
    const skill = require('./skills').setSkillEnabled(payload.skill_id, payload.action === 'skill_disable' ? false : Boolean(payload.enabled));
    return { approved: true, action: payload.action, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } };
  }
  if (payload.action === 'mcp_remove') {
    return Promise.resolve(require('./mcp').removeServer(payload.server_id))
      .then(() => ({ approved: true, action: payload.action, deleted: true }));
  }
  throw Object.assign(new Error('未知资源操作'), { code: 'RESOURCE_ACTION_UNKNOWN', status: 400 });
}

function publishResourceResolution(interaction) {
  const sessionId = Number(interaction?.payload?.agent_session_id);
  if (!sessionId) return;
  require('./agentRunEventBus').publish({ sessionId, event: {
    type: 'artifact', artifact_type: 'resource_resolution', interaction_id: interaction.id,
    status: interaction.status === 'failed' ? 'failed' : interaction.response?.cancelled || interaction.status === 'cancelled' ? 'cancelled' : 'answered',
    text: interaction.response?.message || '',
  } });
}
module.exports = { applyResourceApproval, publishResourceResolution };
