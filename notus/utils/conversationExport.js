import { getConversationTitle } from './conversations';

function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function escapeFence(value) {
  return asText(value).replace(/```/g, '`\u200b``');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateForFile(date = new Date()) {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('')
    + '-' + [pad(date.getHours()), pad(date.getMinutes())].join('');
}

function formatTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

function roleLabel(role = '') {
  const map = { user: '用户', assistant: 'AI', tool: '工具', system: '系统' };
  return map[role] || role || '消息';
}

function pushJsonBlock(lines, title, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value) && value.length === 0) return;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return;
  lines.push('**' + title + '**', '', '```json', escapeFence(value), '```', '');
}

function pushTextBlock(lines, title, value) {
  const text = asText(value).trim();
  if (!text) return;
  lines.push('**' + title + '**', '', text, '');
}

function formatToolSteps(lines, steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) return;
  lines.push('**前端工具链步骤**', '');
  list.forEach((step, index) => {
    lines.push(String(index + 1) + '. ' + (step.label || step.tool || '工具步骤') + ' · ' + (step.status || 'done'));
    if (step.detail) lines.push('   - 说明：' + asText(step.detail));
    if (step.tool) lines.push('   - 工具：' + step.tool);
    if (step.input) lines.push('   - 输入摘要：' + asText(step.input));
    if (step.result) lines.push('   - 结果摘要：' + asText(step.result));
  });
  lines.push('');
}

function formatCitations(lines, citations = []) {
  const list = Array.isArray(citations) ? citations : [];
  if (list.length === 0) return;
  lines.push('**引用来源**', '');
  list.forEach((citation, index) => {
    const label = citation.file_title || citation.file || citation.file_path || citation.title || ('来源 ' + (index + 1));
    const preview = citation.preview || citation.quote || citation.content || '';
    lines.push('- ' + label + (preview ? '：' + String(preview).slice(0, 240) : ''));
  });
  lines.push('');
}

function formatOperationSetSummary(lines, operationSet) {
  if (!operationSet) return;
  lines.push('**修改预览**', '');
  lines.push('- 预览 ID：' + (operationSet.id || operationSet.operation_set_id || '未知'));
  if (operationSet.status) lines.push('- 状态：' + operationSet.status);
  const patches = Array.isArray(operationSet.patches) ? operationSet.patches : [];
  const operations = Array.isArray(operationSet.operations) ? operationSet.operations : [];
  if (patches.length > 0) {
    lines.push('- 文件修改数：' + patches.length);
    patches.forEach((patch) => lines.push('  - ' + (patch.file_path || patch.path || '未知文件')));
  } else if (operations.length > 0) {
    lines.push('- 块操作数：' + operations.length);
  }
  lines.push('');
  pushJsonBlock(lines, '修改预览原始数据', operationSet);
}

function formatMessage(lines, message = {}, index = 0) {
  lines.push('## ' + (index + 1) + '. ' + roleLabel(message.role), '');
  const time = formatTime(message.created_at || message.updated_at);
  if (time) lines.push('时间：' + time, '');
  pushTextBlock(lines, '正文', message.content || '（空消息）');
  if (Array.isArray(message.attachments) && message.attachments.length > 0) pushJsonBlock(lines, '附件', message.attachments);
  formatCitations(lines, message.citations);
  formatToolSteps(lines, message.toolSteps || message.tool_steps || message.meta?.tool_steps);
  formatOperationSetSummary(lines, message.operationSet || message.operation_set);
  pushJsonBlock(lines, '消息 Meta', message.meta);
}

function formatAgentSessions(lines, sessions = []) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (list.length === 0) return;
  lines.push('# Agent Loop 运行记录', '');
  list.forEach((session) => {
    lines.push('## Session #' + session.id, '');
    lines.push('- 状态：' + (session.status || '未知'));
    if (session.reason) lines.push('- 结束原因：' + session.reason);
    lines.push('- 执行轮次：' + (session.loop_count || 0));
    lines.push('- 快照数量：' + (session.snapshots_count || 0));
    if (session.goal) lines.push('- 目标：' + session.goal);
    if (Array.isArray(session.authorized_paths)) lines.push('- 授权路径：' + (session.authorized_paths.join(', ') || '知识库根目录'));
    if (Array.isArray(session.authorized_ops)) lines.push('- 授权操作：' + session.authorized_ops.join(', '));
    lines.push('');

    const logs = Array.isArray(session.run_logs) ? session.run_logs : [];
    if (logs.length > 0) {
      lines.push('### 工具调用与思考过程', '');
      logs.forEach((log, index) => {
        lines.push('#### ' + (index + 1) + '. 第 ' + (log.loop_index || '?') + ' 轮 · ' + (log.tool_name || '模型回复') + ' · ' + (log.status || 'unknown'), '');
        if (log.thinking) pushTextBlock(lines, '思考文本', log.thinking);
        pushJsonBlock(lines, '工具输入', log.tool_input);
        pushJsonBlock(lines, '工具输出', log.tool_result);
        if (log.duration_ms) lines.push('耗时：' + log.duration_ms + ' ms', '');
      });
    }

    const operationSets = Array.isArray(session.operation_sets) ? session.operation_sets : [];
    if (operationSets.length > 0) {
      lines.push('### 修改预览集合', '');
      operationSets.forEach((operationSet) => formatOperationSetSummary(lines, operationSet));
    }
  });
}

export function sanitizeExportFileName(name = 'Notus 对话') {
  const forbidden = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
  const cleaned = Array.from(String(name || 'Notus 对话'))
    .map((char) => (forbidden.has(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Notus 对话';
}

export function buildConversationExportFileName(conversation) {
  return sanitizeExportFileName(getConversationTitle(conversation)) + '-' + formatDateForFile() + '.md';
}

export function formatConversationExportMarkdown({
  conversation = {},
  messages = [],
  agentSessions = [],
  pendingOperationSets = [],
  source = 'Notus',
} = {}) {
  const lines = [];
  const title = getConversationTitle(conversation);
  lines.push('# ' + title, '');
  lines.push('导出来源：' + source);
  lines.push('导出时间：' + formatTime(new Date().toISOString()));
  if (conversation.id) lines.push('对话 ID：' + conversation.id);
  if (conversation.kind) lines.push('对话类型：' + conversation.kind);
  if (conversation.file_id) lines.push('关联文件 ID：' + conversation.file_id);
  lines.push('');

  const messageList = Array.isArray(messages) ? messages : [];
  lines.push('# 对话消息', '');
  if (messageList.length > 0) messageList.forEach((message, index) => formatMessage(lines, message, index));
  else lines.push('暂无可导出的消息。', '');

  formatAgentSessions(lines, agentSessions);

  if (Array.isArray(pendingOperationSets) && pendingOperationSets.length > 0) {
    lines.push('# 待处理修改预览', '');
    pendingOperationSets.forEach((operationSet) => formatOperationSetSummary(lines, operationSet));
  }

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

export function downloadTextFile(filename, content, mimeType = 'text/markdown;charset=utf-8') {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  return true;
}
