function getQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function stripMarkdownSyntax(value = '') {
  return String(value || '')
    .replace(/!\[([^\]]*)]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]]\s+)?/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\|/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeText(value = '') {
  return stripMarkdownSyntax(value).replace(/\s+/g, ' ').trim();
}

function previewFromLines(markdown, lineStart, lineEnd) {
  const start = Number(lineStart);
  const end = Number(lineEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) return '';
  const lines = String(markdown || '').split('\n');
  return normalizeText(lines.slice(start - 1, end).join(' '));
}

function getMarkdownLines(markdown) {
  return String(markdown || '').split('\n');
}

function getHeadingLineInfo(markdown, lineStart, lineEnd) {
  const start = Number(lineStart);
  const end = Number(lineEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) return null;

  const lines = getMarkdownLines(markdown);
  const segment = lines.slice(start - 1, end).map((line) => String(line || '').trim()).filter(Boolean);
  if (segment.length !== 1) return null;

  const match = segment[0].match(/^#{1,6}\s+(.*)$/);
  if (!match) return null;

  return {
    level: segment[0].match(/^#{1,6}/)?.[0]?.length || null,
    text: normalizeText(match[1]),
  };
}

function previewFromHeadingBody(markdown, lineStart, lineEnd) {
  const headingInfo = getHeadingLineInfo(markdown, lineStart, lineEnd);
  if (!headingInfo?.level) return '';

  const lines = getMarkdownLines(markdown);
  const collected = [];

  for (let index = Number(lineEnd); index < lines.length; index += 1) {
    const rawLine = String(lines[index] || '');
    const trimmed = rawLine.trim();

    if (trimmed.match(/^#{1,6}\s+/)) {
      if (collected.length > 0) break;
      continue;
    }

    if (!trimmed) {
      if (collected.length > 0) break;
      continue;
    }

    collected.push(rawLine);
    if (collected.join('\n').length >= 240) break;
  }

  return normalizeText(collected.join('\n'));
}

function uniqueNormalizedValues(values = []) {
  const seen = new Set();
  const result = [];

  values.forEach((value) => {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });

  return result;
}

function buildPreviewCandidates(options = {}) {
  const exactPreview = previewFromLines(options.markdown, options.lineStart, options.lineEnd);
  const sectionBodyPreview = previewFromHeadingBody(options.markdown, options.lineStart, options.lineEnd);
  const headingInfo = getHeadingLineInfo(options.markdown, options.lineStart, options.lineEnd);
  const rawPreview = normalizeText(options.preview);
  const headingPreview = normalizeText(options.headingPath ? String(options.headingPath).split('>').pop() : '');
  const preferSectionBody = Boolean(sectionBodyPreview && (headingInfo || rawPreview.length <= 24));

  return {
    previews: preferSectionBody
      ? uniqueNormalizedValues([sectionBodyPreview, rawPreview, exactPreview, headingPreview])
      : uniqueNormalizedValues([rawPreview, exactPreview, sectionBodyPreview, headingPreview]),
    preferBodyCandidate: preferSectionBody,
  };
}

function getEditorRoot(editor) {
  try {
    return editor?.view?.dom || null;
  } catch {
    return null;
  }
}

function getEditorScrollContainer(editor) {
  return getEditorRoot(editor)?.closest('.wysiwyg-root') || null;
}

function getHeadingLevel(node) {
  const match = node?.tagName?.match(/^H([1-6])$/i);
  return match ? Number(match[1]) : null;
}

function splitHeadingPath(headingPath = '') {
  return String(headingPath || '')
    .split('>')
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
}

function scoreHeadingSegment(actual, expected) {
  if (!actual || !expected) return 0;
  if (actual === expected) return expected.length + 120;
  if (actual.includes(expected) || expected.includes(actual)) {
    return Math.min(actual.length, expected.length) + 40;
  }

  const expectedWords = expected.split(' ').filter(Boolean);
  return expectedWords.reduce((count, word) => (actual.includes(word) ? count + word.length : count), 0);
}

function scoreHeadingPathMatch(trailSegments = [], targetSegments = []) {
  if (!trailSegments.length || !targetSegments.length) return 0;

  let matchedSuffix = 0;
  let textScore = 0;
  const maxDepth = Math.min(trailSegments.length, targetSegments.length);

  for (let index = 1; index <= maxDepth; index += 1) {
    const actual = trailSegments[trailSegments.length - index];
    const expected = targetSegments[targetSegments.length - index];
    const segmentScore = scoreHeadingSegment(actual, expected);
    if (segmentScore <= 0) break;
    matchedSuffix += 1;
    textScore += segmentScore;
  }

  if (matchedSuffix === 0) return 0;
  return matchedSuffix * 1000 + textScore;
}

function findHeadingMatches(root, headingPath) {
  if (!root) return [];

  const targetSegments = splitHeadingPath(headingPath);
  if (targetSegments.length === 0) return [];

  const headingNodes = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const stack = [];
  const matches = [];

  headingNodes.forEach((node) => {
    const level = getHeadingLevel(node);
    const text = normalizeText(node.textContent);
    if (!level || !text) return;

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    stack.push({ level, text });

    const trailSegments = stack.map((item) => item.text);
    const score = scoreHeadingPathMatch(trailSegments, targetSegments);
    if (score <= 0) return;

    matches.push({
      node,
      score,
      trailSegments,
    });
  });

  return matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.trailSegments.length - left.trailSegments.length;
  });
}

function scorePreviewAgainstText(text, preview) {
  if (!preview) return text.length > 0 ? 1 : -1;
  if (text.includes(preview)) return preview.length + 1000;
  if (preview.includes(text)) return text.length;

  const previewWords = preview.split(' ').filter(Boolean);
  return previewWords.reduce((count, word) => (text.includes(word) ? count + word.length : count), 0);
}

function scoreCandidateNode(node, previews = [], options = {}) {
  const text = normalizeText(node?.textContent);
  if (!text) return -1;

  const normalizedPreviews = Array.isArray(previews) ? previews : [previews];
  let bestScore = normalizedPreviews.length === 0 ? 1 : -1;

  normalizedPreviews.forEach((preview, index) => {
    const nextScore = scorePreviewAgainstText(text, preview);
    if (nextScore < 0) return;
    bestScore = Math.max(bestScore, nextScore - index * 8);
  });

  if (options.preferBodyCandidate && /^H[1-6]$/i.test(node?.tagName || '')) {
    bestScore -= 400;
  }

  return bestScore;
}

function collectScopedCandidates(root, headingMatch) {
  if (!root) return [];
  if (!headingMatch) {
    return [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,td,th')];
  }

  const level = getHeadingLevel(headingMatch);
  if (!level) {
    return [headingMatch, ...headingMatch.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,td,th')];
  }

  const candidates = [];
  let current = headingMatch;

  while (current) {
    if (current !== headingMatch && /^H[1-6]$/i.test(current.tagName || '')) {
      const currentLevel = getHeadingLevel(current);
      if (currentLevel && currentLevel <= level) break;
    }

    if (current.matches?.('h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,td,th')) {
      candidates.push(current);
    }

    if (current.querySelectorAll) {
      candidates.push(...current.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,td,th'));
    }

    current = current.nextElementSibling;
  }

  return [...new Set(candidates)];
}

function findFallbackBodyCandidate(candidates = []) {
  return candidates.find((node) => {
    if (!node || /^H[1-6]$/i.test(node.tagName || '')) return false;
    return Boolean(normalizeText(node.textContent));
  }) || null;
}

function findBestMatchElement(editor, options = {}) {
  const root = getEditorRoot(editor);
  if (!root) return null;

  const { previews, preferBodyCandidate } = buildPreviewCandidates(options);
  let bestNode = null;
  let bestScore = -1;
  let bestHeadingMatch = null;
  let bestBodyFallback = null;
  let bestBodyFallbackScore = -1;

  const headingMatches = findHeadingMatches(root, options.headingPath);
  const scopes = headingMatches.length > 0
    ? headingMatches
    : [{ node: null, score: 0, trailSegments: [] }];

  scopes.forEach((scope, scopeIndex) => {
    const headingMatch = scope.node || null;
    const candidates = collectScopedCandidates(root, headingMatch);
    const fallbackBodyCandidate = findFallbackBodyCandidate(candidates);
    const scopeBonus = Math.min(Number(scope.score || 0), 4000) / 12 - scopeIndex * 4;

    if (headingMatch && !bestHeadingMatch) {
      bestHeadingMatch = headingMatch;
    }

    if (preferBodyCandidate && fallbackBodyCandidate && scopeBonus > bestBodyFallbackScore) {
      bestBodyFallback = fallbackBodyCandidate;
      bestBodyFallbackScore = scopeBonus;
    }

    candidates.forEach((node) => {
      const previewScore = scoreCandidateNode(node, previews, { preferBodyCandidate });
      if (previewScore < 0) return;

      const totalScore = previewScore + scopeBonus;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestNode = node;
        if (headingMatch) bestHeadingMatch = headingMatch;
      }
    });
  });

  if (bestScore > 0 && bestNode) return bestNode;
  if (preferBodyCandidate && bestBodyFallback) return bestBodyFallback;
  return bestHeadingMatch;
}

function resolveCitationMatch(editor, options = {}) {
  const matched = findBestMatchElement(editor, options);
  if (matched) return matched;

  const preferredNode = options.preferredNode;
  if (preferredNode?.isConnected) return preferredNode;
  return null;
}

function clearCitationHighlights(editor) {
  const root = getEditorRoot(editor);
  if (!root) return;
  root.querySelectorAll('.citation-highlight, .citation-highlight-persistent, [data-citation-highlight]')
    .forEach((node) => {
      node.classList.remove('citation-highlight', 'citation-highlight-persistent');
      node.removeAttribute('data-citation-highlight');
      node.style.removeProperty('background-color');
      node.style.removeProperty('box-shadow');
      node.style.removeProperty('border-radius');
      node.style.removeProperty('outline');
      node.style.removeProperty('outline-offset');
      node.style.removeProperty('animation');
    });
}

function addHighlightClass(node, className, options = {}) {
  if (!node) return null;
  node.classList.add(className);
  node.setAttribute('data-citation-highlight', options.persistent ? 'persistent' : 'flash');
  node.style.setProperty('background-color', 'var(--citation-highlight-bg)', 'important');
  node.style.setProperty('border-radius', 'var(--radius-sm)', 'important');
  node.style.setProperty('outline', '2px solid var(--citation-highlight-bar)', 'important');
  node.style.setProperty('outline-offset', '2px', 'important');
  if (options.persistent) {
    node.style.setProperty('box-shadow', '0 0 0 1px var(--citation-highlight-ring)', 'important');
    node.style.removeProperty('animation');
  } else {
    node.style.setProperty('box-shadow', '0 0 0 1px var(--citation-highlight-ring)', 'important');
    node.style.setProperty('animation', 'citationFlash 3s ease forwards', 'important');
  }
  if (!options.persistent && typeof window !== 'undefined') {
    window.setTimeout(() => {
      node.classList.remove(className);
      node.removeAttribute('data-citation-highlight');
      node.style.removeProperty('background-color');
      node.style.removeProperty('box-shadow');
      node.style.removeProperty('border-radius');
      node.style.removeProperty('outline');
      node.style.removeProperty('outline-offset');
      node.style.removeProperty('animation');
    }, options.duration || 3000);
  }
  return node;
}

function findBodySibling(headingNode) {
  if (!headingNode || !/^H[1-6]$/i.test(headingNode.tagName || '')) return null;
  let sibling = headingNode.nextElementSibling;
  while (sibling) {
    if (/^H[1-6]$/i.test(sibling.tagName || '')) return null;
    if (normalizeText(sibling.textContent)) return sibling;
    sibling = sibling.nextElementSibling;
  }
  return null;
}

function attachCitationHighlight(editor, target = {}, options = {}) {
  const resolvedNode = options.resolvedNode?.isConnected ? options.resolvedNode : null;
  const match = resolvedNode || resolveCitationMatch(editor, {
    preview: target.preview,
    headingPath: target.headingPath,
    lineStart: target.lineStart,
    lineEnd: target.lineEnd,
    markdown: options.markdown || target.markdown || '',
    preferredNode: options.preferredNode || null,
  });
  if (!match) {
    clearCitationHighlights(editor);
    return null;
  }

  clearCitationHighlights(editor);
  const className = options.persistent ? 'citation-highlight-persistent' : 'citation-highlight';
  addHighlightClass(match, className, options);

  if (/^H[1-6]$/i.test(match.tagName || '')) {
    const bodySibling = findBodySibling(match);
    if (bodySibling) {
      addHighlightClass(bodySibling, className, options);
    }
  }

  return match;
}

function schedulePersistentReattach(editor, target = {}, options = {}) {
  if (typeof window === 'undefined' || !options.persistent) return;

  window.requestAnimationFrame(() => {
    attachCitationHighlight(editor, target, options);
    window.requestAnimationFrame(() => {
      attachCitationHighlight(editor, target, options);
    });
  });
}

function observePersistentCitationHighlight(editor, target = {}, options = {}) {
  if (typeof window === 'undefined' || !options.persistent) return () => {};

  const root = getEditorRoot(editor);
  if (!root || typeof window.MutationObserver !== 'function') return () => {};

  let rafId = 0;
  let reattaching = false;
  const ensureHighlight = () => {
    if (rafId || reattaching) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      if (!root.isConnected) return;
      if (!root.querySelector('.citation-highlight-persistent')) {
        reattaching = true;
        attachCitationHighlight(editor, target, options);
        reattaching = false;
      }
    });
  };

  const observer = new window.MutationObserver(() => {
    ensureHighlight();
  });

  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-citation-highlight'],
  });

  return () => {
    observer.disconnect();
    if (rafId) window.cancelAnimationFrame(rafId);
  };
}

function scrollNodeIntoContainer(container, node, offset) {
  if (!container || !node) return;
  const containerRect = container.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const scrollTop = container.scrollTop + (nodeRect.top - containerRect.top) - offset;
  container.scrollTo({ top: Math.max(scrollTop, 0), behavior: 'smooth' });
}

function focusCitationTarget(editor, target = {}, options = {}) {
  const container = getEditorScrollContainer(editor);
  const match = resolveCitationMatch(editor, {
    preview: target.preview,
    headingPath: target.headingPath,
    lineStart: target.lineStart,
    lineEnd: target.lineEnd,
    markdown: options.markdown || target.markdown || '',
    preferredNode: options.preferredNode || null,
  });

  if (!container || !match) {
    clearCitationHighlights(editor);
    return null;
  }

  clearCitationHighlights(editor);

  if (options.scroll !== false) {
    scrollNodeIntoContainer(container, match, 56);
  }

  if (options.select !== false) {
    try {
      const pos = editor.view.posAtDOM(match, 0);
      editor.commands.setTextSelection(pos);
    } catch {}
  }

  const liveMatch = attachCitationHighlight(editor, target, {
    ...options,
    resolvedNode: match,
  });
  if (!liveMatch) return null;
  schedulePersistentReattach(editor, target, options);
  return liveMatch;
}

function retryFocusCitationTarget(editor, target = {}, options = {}, callbacks = {}) {
  const onResolved = typeof callbacks.onResolved === 'function' ? callbacks.onResolved : () => {};
  const maxAttempts = Math.max(0, Number(options.maxAttempts ?? 20));
  const retryDelay = Math.max(16, Number(options.retryDelay ?? 80));

  if (typeof window === 'undefined') {
    onResolved(focusCitationTarget(editor, target, options), 0);
    return () => {};
  }

  let cancelled = false;
  let rafId = 0;
  let timeoutId = 0;

  const run = (attempt = 0) => {
    if (cancelled) return;

    const match = focusCitationTarget(editor, target, options);
    if (match) {
      onResolved(match, attempt);
      return;
    }

    if (attempt >= maxAttempts) {
      onResolved(null, attempt);
      return;
    }

    rafId = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => run(attempt + 1), retryDelay);
    });
  };

  run();

  return () => {
    cancelled = true;
    if (rafId) window.cancelAnimationFrame(rafId);
    if (timeoutId) window.clearTimeout(timeoutId);
  };
}

module.exports = {
  attachCitationHighlight,
  clearCitationHighlights,
  findBestMatchElement,
  focusCitationTarget,
  retryFocusCitationTarget,
  getEditorRoot,
  getEditorScrollContainer,
  getQueryValue,
  normalizeText,
  observePersistentCitationHighlight,
  previewFromLines,
};
