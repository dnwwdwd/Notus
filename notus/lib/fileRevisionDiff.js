const crypto = require('crypto');

function normalizeRevisionContent(content = '') {
  return String(content ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function hashRevisionContent(content = '') {
  return crypto.createHash('sha256').update(normalizeRevisionContent(content), 'utf8').digest('hex');
}

function splitLines(content = '') {
  const value = normalizeRevisionContent(content);
  if (value === '') return [];
  return value.split('\n');
}

function buildDiffEntries(oldLines = [], newLines = []) {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  if (oldLength * newLength > 1000000) {
    return buildLargeDiffEntries(oldLines, newLines);
  }
  const dp = Array.from({ length: oldLength + 1 }, () => Array(newLength + 1).fill(0));

  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? dp[oldIndex + 1][newIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const entries = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLength && newIndex < newLength) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      entries.push({
        type: 'context',
        content: oldLines[oldIndex],
        oldLineNumber: oldIndex + 1,
        newLineNumber: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
      entries.push({
        type: 'delete',
        content: oldLines[oldIndex],
        oldLineNumber: oldIndex + 1,
      });
      oldIndex += 1;
    } else {
      entries.push({
        type: 'insert',
        content: newLines[newIndex],
        newLineNumber: newIndex + 1,
      });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLength) {
    entries.push({
      type: 'delete',
      content: oldLines[oldIndex],
      oldLineNumber: oldIndex + 1,
    });
    oldIndex += 1;
  }

  while (newIndex < newLength) {
    entries.push({
      type: 'insert',
      content: newLines[newIndex],
      newLineNumber: newIndex + 1,
    });
    newIndex += 1;
  }

  return entries;
}

function buildLargeDiffEntries(oldLines = [], newLines = []) {
  const entries = [];
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    entries.push({
      type: 'context',
      content: oldLines[prefix],
      oldLineNumber: prefix + 1,
      newLineNumber: prefix + 1,
    });
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  const suffix = [];
  while (
    oldSuffix >= prefix
    && newSuffix >= prefix
    && oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    suffix.unshift({
      type: 'context',
      content: oldLines[oldSuffix],
      oldLineNumber: oldSuffix + 1,
      newLineNumber: newSuffix + 1,
    });
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  for (let index = prefix; index <= oldSuffix; index += 1) {
    entries.push({
      type: 'delete',
      content: oldLines[index],
      oldLineNumber: index + 1,
    });
  }
  for (let index = prefix; index <= newSuffix; index += 1) {
    entries.push({
      type: 'insert',
      content: newLines[index],
      newLineNumber: index + 1,
    });
  }

  entries.push(...suffix);
  return entries;
}

function hasChange(entries = [], start = 0, end = entries.length - 1) {
  for (let index = start; index <= end; index += 1) {
    if (entries[index]?.type !== 'context') return true;
  }
  return false;
}

function createHunk(entries = [], start = 0, end = entries.length - 1) {
  const lines = entries.slice(start, end + 1);
  const oldNumbers = lines.map((line) => line.oldLineNumber).filter((value) => Number.isFinite(value));
  const newNumbers = lines.map((line) => line.newLineNumber).filter((value) => Number.isFinite(value));
  return {
    oldStart: oldNumbers.length > 0 ? Math.min(...oldNumbers) : 0,
    oldLines: lines.filter((line) => line.type !== 'insert').length,
    newStart: newNumbers.length > 0 ? Math.min(...newNumbers) : 0,
    newLines: lines.filter((line) => line.type !== 'delete').length,
    lines,
  };
}

function createDiffHunks(baseContent = '', draftContent = '', contextLines = 3) {
  const oldLines = splitLines(baseContent);
  const newLines = splitLines(draftContent);
  const entries = buildDiffEntries(oldLines, newLines);
  if (!entries.some((entry) => entry.type !== 'context')) return [];

  const context = Math.max(0, Number(contextLines) || 0);
  const hunks = [];
  let index = 0;
  while (index < entries.length) {
    while (index < entries.length && entries[index].type === 'context') index += 1;
    if (index >= entries.length) break;

    let start = Math.max(0, index - context);
    let end = index;
    let trailingContext = 0;
    index += 1;

    while (index < entries.length) {
      if (entries[index].type === 'context') {
        trailingContext += 1;
        if (trailingContext > context) break;
      } else {
        trailingContext = 0;
      }
      end = index;
      index += 1;
    }

    end = Math.min(entries.length - 1, end);
    if (hunks.length > 0 && start <= hunks[hunks.length - 1]._end + 1) {
      const previous = hunks.pop();
      start = previous._start;
    }
    if (hasChange(entries, start, end)) {
      hunks.push({ ...createHunk(entries, start, end), _start: start, _end: end });
    }
  }

  return hunks.map(({ _start, _end, ...hunk }) => hunk);
}

module.exports = {
  createDiffHunks,
  hashRevisionContent,
  normalizeRevisionContent,
};
