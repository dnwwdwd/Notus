const TASK_LIST_LINE_PATTERN = /^\s*(?:[-+*]|\d+\.)\s+\[(?: |x|X)]\s+.+$/;

function normalizeTaskListLine(line = '') {
  const source = String(line || '').replace(/\t/g, '  ');
  const match = source.match(/^(\s*)([-+*]|\d+\.)\s+\[([ xX])]\s+(.+)$/);
  if (!match) return '';
  const [, indent, marker, checked, content] = match;
  return `${indent}${marker} [${checked}] ${content.trimEnd()}`;
}

function extractMarkdownTaskList(text = '') {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return null;

  const lines = source.split('\n');
  const normalized = lines.map(normalizeTaskListLine);
  if (normalized.some((line) => !line)) return null;
  if (!normalized.some((line) => TASK_LIST_LINE_PATTERN.test(line))) return null;

  return normalized.join('\n');
}

module.exports = {
  extractMarkdownTaskList,
  TASK_LIST_LINE_PATTERN,
};
