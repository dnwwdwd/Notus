const TABLE_SEPARATOR_CELL_PATTERN = /^\s*:?-{3,}:?\s*$/;

function normalizeMarkdownTableLine(value = '') {
  return String(value || '').trim();
}

function stripOptionalOuterPipes(value = '') {
  let line = normalizeMarkdownTableLine(value);
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|')) line = line.slice(0, -1);
  return line;
}

function splitMarkdownTableLine(value = '') {
  const line = stripOptionalOuterPipes(value);
  if (!line.includes('|')) return [];
  return line.split('|').map((cell) => cell.trim());
}

function isMarkdownTableRow(value = '') {
  return splitMarkdownTableLine(value).length >= 2;
}

function isMarkdownTableSeparatorRow(value = '') {
  const cells = splitMarkdownTableLine(value);
  return cells.length >= 2 && cells.every((cell) => TABLE_SEPARATOR_CELL_PATTERN.test(cell));
}

function looksLikeMarkdownTableLines(lines = []) {
  const normalized = Array.isArray(lines)
    ? lines.map((line) => normalizeMarkdownTableLine(line)).filter(Boolean)
    : [];

  if (normalized.length < 3) return false;
  if (!isMarkdownTableRow(normalized[0])) return false;
  if (!isMarkdownTableSeparatorRow(normalized[1])) return false;

  const columnCount = splitMarkdownTableLine(normalized[0]).length;
  if (splitMarkdownTableLine(normalized[1]).length !== columnCount) return false;

  return normalized.slice(2).every((line) => (
    isMarkdownTableRow(line)
    && splitMarkdownTableLine(line).length === columnCount
  ));
}

function canonicalizeMarkdownTableLines(lines = []) {
  return lines.map((line) => {
    const cells = splitMarkdownTableLine(line);
    return `| ${cells.join(' | ')} |`;
  });
}

function findMarkdownTableBlock(lines = [], activeIndex = -1) {
  if (!Array.isArray(lines) || !Number.isInteger(activeIndex)) return null;
  if (activeIndex < 0 || activeIndex >= lines.length) return null;

  const isCandidateLine = (line) => isMarkdownTableRow(line) || isMarkdownTableSeparatorRow(line);
  if (!isCandidateLine(lines[activeIndex])) return null;

  let start = activeIndex;
  while (start > 0 && isCandidateLine(lines[start - 1])) {
    start -= 1;
  }

  let end = activeIndex;
  while (end < lines.length - 1 && isCandidateLine(lines[end + 1])) {
    end += 1;
  }

  const blockLines = lines.slice(start, end + 1).map((line) => normalizeMarkdownTableLine(line));
  if (!looksLikeMarkdownTableLines(blockLines)) return null;

  return {
    start,
    end,
    lines: canonicalizeMarkdownTableLines(blockLines),
  };
}

export {
  normalizeMarkdownTableLine,
  splitMarkdownTableLine,
  isMarkdownTableRow,
  isMarkdownTableSeparatorRow,
  looksLikeMarkdownTableLines,
  canonicalizeMarkdownTableLines,
  findMarkdownTableBlock,
};
