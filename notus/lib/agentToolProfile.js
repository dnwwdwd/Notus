const READ_TOOLS = new Set([
  'search_knowledge', 'web_search', 'fetch_web_url', 'read_file', 'read_global_agent_file',
  'analyze_folder', 'check_links', 'get_task_activity', 'load_skill', 'read_skill_file',
  'list_skills', 'get_skill_details', 'list_mcp_servers', 'get_mcp_server_details',
  'test_mcp_server', 'read_tool_result',
]);
const OPERATION_SET_TOOLS = new Set([
  'create_note', 'preview_patch_files', 'preview_file_revision', 'preview_file_operations',
]);
const MANAGEMENT_TOOLS = new Set([
  'install_skill_from_git', 'create_skill_draft', 'validate_skill_draft', 'install_skill_draft',
  'update_skill_draft', 'set_skill_enabled', 'update_skill_from_git', 'uninstall_skill',
  'add_mcp_server', 'update_mcp_server', 'set_mcp_server_enabled', 'remove_mcp_server',
  'update_global_agent_file',
]);
const CONTROL_TOOLS = new Set(['ask_question_card', 'get_task_activity', 'read_tool_result']);

function isExternalMcpTool(definition = {}) {
  return Boolean(definition?.mcp);
}

function toolReplayPolicy(toolName, { externalMcp = false } = {}) {
  const name = String(toolName || '');
  if (externalMcp) return 'non_replayable';
  if (OPERATION_SET_TOOLS.has(name)) return 'operation_set';
  if (READ_TOOLS.has(name)) return 'read_only';
  if (name === 'ask_question_card') return 'non_replayable';
  if (MANAGEMENT_TOOLS.has(name)) return 'non_replayable';
  return 'non_replayable';
}

function allowedToolNames(intent = {}) {
  const taskKind = String(intent.task_kind || 'general');
  const webAllowed = intent.source_policy?.web !== 'forbidden';
  const knowledgeAllowed = intent.source_policy?.knowledge !== 'forbidden';
  const localSkillsAllowed = intent.source_policy?.local_skills !== 'forbidden';
  const base = new Set(CONTROL_TOOLS);
  const add = (...names) => names.forEach((name) => base.add(name));

  if (taskKind === 'skill_discovery') {
    if (webAllowed) add('web_search', 'fetch_web_url');
    if (localSkillsAllowed) add('list_skills', 'get_skill_details', 'load_skill', 'read_skill_file');
    return base;
  }
  if (taskKind === 'skill_install') {
    add('install_skill_from_git', 'install_skill_draft', 'list_skills', 'get_skill_details', 'validate_skill_draft');
    return base;
  }
  if (taskKind === 'skill_create') {
    add('list_skills', 'get_skill_details', 'create_skill_draft', 'validate_skill_draft', 'update_skill_draft');
    return base;
  }
  if (taskKind === 'mcp_manage') {
    add('list_mcp_servers', 'get_mcp_server_details', 'add_mcp_server', 'update_mcp_server', 'test_mcp_server', 'set_mcp_server_enabled', 'remove_mcp_server');
    return base;
  }
  if (taskKind === 'web_research') {
    if (webAllowed) add('web_search', 'fetch_web_url');
    return base;
  }
  if (taskKind === 'knowledge_research') {
    if (knowledgeAllowed) add('search_knowledge', 'read_file', 'analyze_folder', 'check_links');
    return base;
  }
  if (taskKind === 'file_read') {
    add('read_file', 'analyze_folder', 'check_links');
    if (knowledgeAllowed) add('search_knowledge');
    if (webAllowed) add('web_search', 'fetch_web_url');
    if (localSkillsAllowed) add('load_skill', 'read_skill_file');
    return base;
  }
  if (taskKind === 'file_write') {
    add('read_file', 'analyze_folder', 'check_links', 'create_note', 'preview_patch_files', 'preview_file_revision', 'preview_file_operations', 'read_global_agent_file', 'update_global_agent_file');
    if (knowledgeAllowed) add('search_knowledge');
    if (webAllowed) add('web_search', 'fetch_web_url');
    if (localSkillsAllowed) add('load_skill', 'read_skill_file');
    return base;
  }

  add('read_file', 'analyze_folder', 'check_links', 'read_global_agent_file');
  if (knowledgeAllowed) add('search_knowledge');
  if (webAllowed) add('web_search', 'fetch_web_url');
  if (localSkillsAllowed) add('load_skill', 'read_skill_file');
  return base;
}

function requiredToolNames(intent = {}) {
  const taskKind = String(intent.task_kind || 'general');
  const required = new Set(['ask_question_card', 'read_tool_result']);
  const add = (...names) => names.forEach((name) => required.add(name));
  if (taskKind === 'skill_discovery' || taskKind === 'web_research' || intent.source_policy?.web === 'required') add('web_search', 'fetch_web_url');
  if (taskKind === 'skill_install') add('list_skills', 'get_skill_details', 'install_skill_from_git', 'install_skill_draft', 'validate_skill_draft');
  if (taskKind === 'skill_create') add('list_skills', 'get_skill_details', 'create_skill_draft', 'validate_skill_draft', 'update_skill_draft');
  if (taskKind === 'mcp_manage') add('list_mcp_servers', 'get_mcp_server_details', 'add_mcp_server', 'update_mcp_server', 'test_mcp_server', 'set_mcp_server_enabled', 'remove_mcp_server');
  if (taskKind === 'file_write') add('read_file', ...OPERATION_SET_TOOLS);
  if (taskKind === 'file_read' || taskKind === 'knowledge_research') add('read_file');
  return required;
}

function projectToolDefinitions(definitions = [], frame = null) {
  if (!frame?.intent) return definitions;
  const allowed = allowedToolNames(frame.intent);
  return (Array.isArray(definitions) ? definitions : []).filter((definition) => {
    if (isExternalMcpTool(definition)) {
      return frame.intent?.source_policy?.web !== 'required'
        && !['skill_discovery', 'web_research'].includes(String(frame.intent?.task_kind || ''));
    }
    return allowed.has(String(definition?.name || ''));
  });
}

module.exports = {
  CONTROL_TOOLS,
  MANAGEMENT_TOOLS,
  OPERATION_SET_TOOLS,
  READ_TOOLS,
  allowedToolNames,
  isExternalMcpTool,
  projectToolDefinitions,
  requiredToolNames,
  toolReplayPolicy,
};
