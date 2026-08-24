const { getDb } = require('./db');
const { getSkill } = require('./skills');
const { getServer } = require('./mcp');
const { listInteractionsByConversation } = require('./conversationInteractions');

const MAX_RESOURCE_EVENTS = 80;
const MAX_RESOURCES_PER_TYPE = 3;

const SKILL_TOOLS = new Set([
  'load_skill',
  'get_skill_details',
  'install_skill_from_git',
  'update_skill_draft',
  'set_skill_enabled',
  'update_skill_from_git',
  'uninstall_skill',
]);

const MCP_TOOLS = new Set([
  'add_mcp_server',
  'get_mcp_server_details',
  'update_mcp_server',
  'test_mcp_server',
  'set_mcp_server_enabled',
  'remove_mcp_server',
]);

function parseJson(value, fallback = {}) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizePositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function eventTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function createReference(type, id, {
  action = '',
  sessionId = null,
  createdAt = null,
  source = 'tool_log',
} = {}) {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return null;
  return {
    type,
    id: normalizedId,
    action: String(action || '').trim(),
    sessionId: normalizePositiveInt(sessionId),
    createdAt: createdAt || null,
    source,
  };
}

function referencesFromToolLog(row) {
  const toolName = String(row?.tool_name || '');
  if (!SKILL_TOOLS.has(toolName) && !MCP_TOOLS.has(toolName)) return [];
  const input = parseJson(row?.tool_input, {});
  const result = parseJson(row?.tool_result, {});
  if (result.error) return [];
  const metadata = {
    action: toolName,
    sessionId: row?.session_id,
    createdAt: row?.created_at,
    source: 'tool_log',
  };

  if (SKILL_TOOLS.has(toolName)) {
    const installed = Array.isArray(result?.installed) ? result.installed : [];
    const ids = installed.map((item) => item?.id).filter(Boolean);
    if (ids.length > 0) return ids.map((id) => createReference('skill', id, metadata)).filter(Boolean);
    const id = result?.skill?.id || result?.id || input.skill_id;
    return [createReference('skill', id, metadata)].filter(Boolean);
  }

  const id = result?.server?.id || input.server_id;
  return [createReference('mcp', id, metadata)].filter(Boolean);
}

function referencesFromInteraction(interaction) {
  if (interaction?.kind !== 'resource_approval' || interaction?.status !== 'answered') return [];
  const payload = interaction.payload || {};
  const response = interaction.response || {};
  if (!response.approved) return [];
  const metadata = {
    action: payload.action || response.action,
    sessionId: payload.agent_session_id,
    createdAt: interaction.answered_at || interaction.updated_at || interaction.created_at,
    source: 'resource_approval',
  };
  const action = String(payload.action || response.action || '');
  if (action.startsWith('skill_')) {
    return [createReference('skill', response?.skill?.id || payload.skill_id, metadata)].filter(Boolean);
  }
  if (action.startsWith('mcp_')) {
    return [createReference('mcp', response?.server?.id || payload.server_id, metadata)].filter(Boolean);
  }
  return [];
}

function listRecentResourceReferences(conversationId) {
  const id = normalizePositiveInt(conversationId);
  if (!id) return [];
  const logs = getDb().prepare(`
    SELECT logs.*, sessions.conversation_id
    FROM agent_run_logs logs
    INNER JOIN agent_sessions sessions ON sessions.id = logs.session_id
    WHERE sessions.conversation_id = ?
      AND logs.status = 'success'
    ORDER BY logs.created_at DESC, logs.id DESC
    LIMIT ?
  `).all(id, MAX_RESOURCE_EVENTS);
  const interactions = listInteractionsByConversation(id, { statuses: ['answered'] });
  return logs.flatMap(referencesFromToolLog)
    .concat(interactions.flatMap(referencesFromInteraction))
    .sort((left, right) => eventTime(right.createdAt) - eventTime(left.createdAt));
}

function resolveResource(reference) {
  if (reference.type === 'skill') {
    const skill = getSkill(reference.id);
    if (!skill || skill.status !== 'valid') return null;
    return {
      ...reference,
      name: String(skill.name || '').trim(),
      enabled: Boolean(skill.enabled),
      managed: Boolean(skill.managed),
      status: String(skill.status || ''),
    };
  }
  const server = getServer(reference.id);
  if (!server) return null;
  return {
    ...reference,
    name: String(server.name || '').trim(),
    enabled: Boolean(server.enabled),
    transport: String(server.transport || ''),
  };
}

function buildConversationResourceContext(conversationId) {
  const seen = new Set();
  const resources = [];
  listRecentResourceReferences(conversationId).forEach((reference) => {
    const key = `${reference.type}:${reference.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const resolved = resolveResource(reference);
    if (resolved) resources.push(resolved);
  });

  const skills = resources.filter((item) => item.type === 'skill').slice(0, MAX_RESOURCES_PER_TYPE);
  const mcpServers = resources.filter((item) => item.type === 'mcp').slice(0, MAX_RESOURCES_PER_TYPE);
  const latest = resources[0] || null;
  const sameSessionCandidates = latest?.sessionId
    ? resources.filter((item) => item.type === latest.type && item.sessionId === latest.sessionId)
    : latest ? [latest] : [];
  const ambiguousTypes = sameSessionCandidates.length > 1 ? [latest.type] : [];

  return {
    skills,
    mcpServers,
    latest,
    ambiguousTypes,
    hasResources: resources.length > 0,
  };
}

function formatResource(resource) {
  if (resource.type === 'skill') {
    return `${resource.name}（ID: ${resource.id}，${resource.managed ? 'Notus 受管' : '外部扫描'}，${resource.enabled ? '已启用' : '已停用'}）`;
  }
  return `${resource.name}（ID: ${resource.id}，${resource.transport || '未知传输'}，${resource.enabled ? '已启用' : '已停用'}）`;
}

function formatConversationResourceContext(context) {
  if (!context?.hasResources) return '';
  const sections = [
    '## 当前受管资源上下文（高于最近对话文本）',
    '以下对象来自同一对话的真实资源操作记录；每轮都已按稳定 ID 从当前 Skill/MCP 存储重新校验。它们不是笔记、文章或工作区文件。',
  ];
  if (context.latest && !context.ambiguousTypes.includes(context.latest.type)) {
    sections.push(`当前对象：${context.latest.type === 'skill' ? 'Skill' : 'MCP Server'} ${formatResource(context.latest)}。`);
  }
  if (context.skills.length > 0) {
    sections.push(`近期 Skill：${context.skills.map(formatResource).join('；')}`);
  }
  if (context.mcpServers.length > 0) {
    sections.push(`近期 MCP Server：${context.mcpServers.map(formatResource).join('；')}`);
  }
  if (context.ambiguousTypes.length > 0) {
    const label = context.ambiguousTypes.includes('skill') ? 'Skill' : 'MCP Server';
    sections.push(`本轮最近操作中存在多个 ${label} 候选。用户没有明确名称或 ID 时，必须追问，不能按名称猜测、更不能转去修改文章或文件。`);
  }
  sections.push('用户使用“这个”“它”“刚才那个”“改名”等承接表达时，若当前对象唯一，先以它的 ID 调用对应详情或管理工具；只有用户明确指向文章、文件或新资源时才切换目标。若对象已失效、同类候选并列或用户意图仍不清楚，先澄清。');
  return sections.join('\n');
}

module.exports = {
  buildConversationResourceContext,
  formatConversationResourceContext,
  listRecentResourceReferences,
};
