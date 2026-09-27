function normalizeRevisionContent(content = '') {
  return String(content ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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

// Myers 按编辑距离扩展，对长文少量修改保持逐行精度；共同首尾先剥离。
function buildLargeDiffEntries(oldLines = [], newLines = []) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const left = oldLines.slice(prefix, oldEnd);
  const right = newLines.slice(prefix, newEnd);
  let middle;
  if (left.length * right.length <= 1000000) middle = buildDiffEntries(left, right);
  else middle = myersEntries(left, right);
  const entries = oldLines.slice(0, prefix).map((content, index) => ({ type: 'context', content, oldLineNumber: index + 1, newLineNumber: index + 1 }));
  for (const line of middle) entries.push({ ...line,
    ...(line.oldLineNumber ? { oldLineNumber: line.oldLineNumber + prefix } : {}),
    ...(line.newLineNumber ? { newLineNumber: line.newLineNumber + prefix } : {}),
  });
  for (let i = oldEnd, j = newEnd; i < oldLines.length; i++, j++) {
    entries.push({ type: 'context', content: oldLines[i], oldLineNumber: i + 1, newLineNumber: j + 1 });
  }
  return entries;
}

function myersEntries(left, right) {
  const frontier = new Map([[1, 0]]);
  const trace = [];
  // 极端全篇改写限制搜索内存；超过预算后用共同唯一行继续分段对齐。
  for (let d = 0; d <= Math.min(left.length + right.length, 512); d++) {
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
        ? (frontier.get(k + 1) || 0) : (frontier.get(k - 1) || 0) + 1;
      let y = x - k;
      while (x < left.length && y < right.length && left[x] === right[y]) { x++; y++; }
      frontier.set(k, x);
      if (x < left.length || y < right.length) continue;
      const result = [];
      for (let depth = d; depth >= 0; depth--) {
        const previous = trace[depth];
        const diagonal = x - y;
        const previousK = diagonal === -depth || (diagonal !== depth && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1))
          ? diagonal + 1 : diagonal - 1;
        const previousX = previous.get(previousK) || 0;
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
          result.push({ type: 'context', content: left[x - 1], oldLineNumber: x, newLineNumber: y }); x--; y--;
        }
        if (depth === 0) break;
        if (x === previousX) { result.push({ type: 'insert', content: right[y - 1], newLineNumber: y }); y--; }
        else { result.push({ type: 'delete', content: left[x - 1], oldLineNumber: x }); x--; }
      }
      return result.reverse();
    }
  }
  return anchoredEntries(left, right);
}

function anchoredEntries(left, right) {
  const locations = (lines) => {
    const map = new Map();
    lines.forEach((line, i) => map.set(line, map.has(line) ? -1 : i));
    return map;
  };
  const leftMap = locations(left), rightMap = locations(right);
  const pairs = [];
  left.forEach((line, i) => { if (leftMap.get(line) === i && rightMap.get(line) >= 0) pairs.push([i, rightMap.get(line)]); });
  const tails = [], previous = [];
  pairs.forEach((pair, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < pair[1]) lo = mid + 1; else hi = mid; }
    previous[i] = lo ? tails[lo - 1] : -1; tails[lo] = i;
  });
  if (!tails.length) return left.map((content, i) => ({ type: 'delete', content, oldLineNumber: i + 1 }))
    .concat(right.map((content, i) => ({ type: 'insert', content, newLineNumber: i + 1 })));
  const anchors = [];
  for (let i = tails[tails.length - 1]; i >= 0; i = previous[i]) anchors.push(pairs[i]);
  anchors.reverse(); anchors.push([left.length, right.length]);
  const entries = []; let oldStart = 0, newStart = 0;
  for (const [x, y] of anchors) {
    for (const line of buildDiffEntries(left.slice(oldStart, x), right.slice(newStart, y))) entries.push({ ...line,
      ...(line.oldLineNumber ? { oldLineNumber: line.oldLineNumber + oldStart } : {}),
      ...(line.newLineNumber ? { newLineNumber: line.newLineNumber + newStart } : {}),
    });
    if (x < left.length) entries.push({ type: 'context', content: left[x], oldLineNumber: x + 1, newLineNumber: y + 1 });
    oldStart = x + 1; newStart = y + 1;
  }
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
    oldStart: oldNumbers.length > 0 ? oldNumbers[0] : 0,
    oldLines: lines.filter((line) => line.type !== 'insert').length,
    newStart: newNumbers.length > 0 ? newNumbers[0] : 0,
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

module.exports = { createDiffHunks, normalizeRevisionContent };
