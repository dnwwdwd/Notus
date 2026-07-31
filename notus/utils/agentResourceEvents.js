const SKILL_RESOURCE_MUTATIONS = new Set([
  'install_skill_from_git',
  'set_skill_enabled',
  'update_skill_from_git',
  'skill_install',
  'skill_update',
  'skill_uninstall',
  'skill_disable',
]);

const MCP_RESOURCE_MUTATIONS = new Set([
  'add_mcp_server',
  'update_mcp_server',
  'set_mcp_server_enabled',
  'mcp_remove',
]);

export function getAgentResourceChangeEvents(operation = '') {
  const name = String(operation || '').trim();
  if (SKILL_RESOURCE_MUTATIONS.has(name)) return ['notus-skills-changed'];
  if (MCP_RESOURCE_MUTATIONS.has(name)) return ['notus-mcp-servers-changed'];
  return [];
}

export function dispatchAgentResourceChange(operation = '') {
  const events = getAgentResourceChangeEvents(operation);
  if (typeof window === 'undefined') return events;
  events.forEach((eventName) => window.dispatchEvent(new Event(eventName)));
  return events;
}
