let parserPromise = null;

async function getMarkdownParser() {
  if (!parserPromise) {
    parserPromise = Promise.all([
      import('unified'),
      import('remark-parse'),
      import('remark-gfm'),
    ]).then(([unifiedModule, remarkParseModule, remarkGfmModule]) => ({
      unified: unifiedModule.unified || unifiedModule.default || unifiedModule,
      remarkParse: remarkParseModule.default || remarkParseModule,
      remarkGfm: remarkGfmModule.default || remarkGfmModule,
    }));
  }
  return parserPromise;
}

function createBlock(index, type, content, meta = {}) {
  return {
    id: `b_${index}`,
    type,
    content,
    headingLevel: meta.headingLevel || 0,
    headingPath: meta.headingPath || '',
    lineStart: meta.lineStart || null,
    lineEnd: meta.lineEnd || null,
    semanticGroup: meta.semanticGroup || 'semantic',
  };
}

function normalizeBlockContent(content = '') {
  return String(content).replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
}

function detectType(chunk) {
  const text = normalizeBlockContent(chunk);
  if (!text) return 'paragraph';
  if (/^#{1,6}\s/.test(text)) return 'heading';
  if (/^```/.test(text)) return 'code';
  if (/^\|.+\|$/m.test(text)) return 'table';
  if (/^>\s/m.test(text)) return 'blockquote';
  if (/^([-*+]|\d+\.)\s/m.test(text)) return 'list';
  if (/^---+$/.test(text)) return 'divider';
  return 'paragraph';
}

function extractRange(source, startLine, endLine) {
  const lines = String(source || '').split('\n');
  return normalizeBlockContent(lines.slice(Math.max(startLine - 1, 0), Math.max(endLine, 0)).join('\n'));
}

async function safeParseMarkdown(source) {
  try {
    const { unified, remarkParse, remarkGfm } = await getMarkdownParser();
    return unified().use(remarkParse).use(remarkGfm).parse(source);
  } catch {
    return null;
  }
}

function getHeadingText(source, node) {
  const text = extractRange(source, node.position?.start?.line, node.position?.end?.line);
  return normalizeBlockContent(text).replace(/^#{1,6}\s*/, '');
}

function buildHeadingIndex(source, tree) {
  return (tree?.children || [])
    .filter((node) => node.type === 'heading' && node.position?.start?.line && node.position?.end?.line)
    .map((node) => ({
      depth: Number(node.depth || 0),
      lineStart: Number(node.position.start.line),
      lineEnd: Number(node.position.end.line),
      text: getHeadingText(source, node),
    }));
}

function getHeadingPathForLine(headings, line) {
  const stack = [];
  headings.forEach((heading) => {
    if (heading.lineStart > line) return;
    while (stack.length > 0 && stack[stack.length - 1].depth >= heading.depth) {
      stack.pop();
    }
    stack.push({ depth: heading.depth, text: heading.text });
  });
  return stack.map((item) => item.text).filter(Boolean).join(' > ');
}

function choosePreferredHeadingDepth(headings) {
  const counts = headings.reduce((accumulator, heading) => {
    if (heading.depth >= 2) {
      accumulator[heading.depth] = (accumulator[heading.depth] || 0) + 1;
    }
    return accumulator;
  }, {});

  const maxDepth = Math.max(0, ...Object.keys(counts).map((key) => Number(key)));
  for (let depth = maxDepth; depth >= 2; depth -= 1) {
    if ((counts[depth] || 0) >= 2) return depth;
  }
  return null;
}

function createRange(type, source, startLine, endLine, meta = {}) {
  const content = extractRange(source, startLine, endLine);
  if (!content) return null;
  return {
    type: type || detectType(content),
    content,
    headingLevel: meta.headingLevel || 0,
    headingPath: meta.headingPath || '',
    lineStart: startLine,
    lineEnd: endLine,
    semanticGroup: meta.semanticGroup || 'semantic',
  };
}

function buildHeadingDrivenRanges(source, tree, preferredDepth) {
  const headings = buildHeadingIndex(source, tree);
  const boundaries = headings.filter((heading) => heading.depth <= preferredDepth);
  if (boundaries.length === 0) return [];

  const totalLines = String(source || '').split('\n').length;
  const ranges = [];

  if (boundaries[0].lineStart > 1) {
    const preamble = createRange(
      'paragraph',
      source,
      1,
      boundaries[0].lineStart - 1,
      {
        headingLevel: 0,
        headingPath: '',
        semanticGroup: 'semantic-preamble',
      }
    );
    if (preamble) ranges.push(preamble);
  }

  boundaries.forEach((heading, index) => {
    const nextBoundary = boundaries[index + 1];
    const endLine = nextBoundary ? nextBoundary.lineStart - 1 : totalLines;
    const range = createRange(
      'heading',
      source,
      heading.lineStart,
      endLine,
      {
        headingLevel: heading.depth,
        headingPath: getHeadingPathForLine(headings, heading.lineStart),
        semanticGroup: `heading-depth-${heading.depth}`,
      }
    );
    if (range) ranges.push(range);
  });

  return ranges;
}

function classifyAstNode(node, content) {
  if (!node) return detectType(content);
  if (node.type === 'heading') return 'heading';
  if (node.type === 'code') return 'code';
  if (node.type === 'table') return 'table';
  if (node.type === 'blockquote') return 'blockquote';
  if (node.type === 'list') return 'list';
  if (node.type === 'thematicBreak') return 'divider';
  return detectType(content);
}

function buildSemanticRanges(source, tree) {
  const children = Array.isArray(tree?.children) ? tree.children : [];
  const headings = buildHeadingIndex(source, tree);
  const ranges = [];
  let paragraphBuffer = [];
  let bufferStart = null;
  let bufferEnd = null;
  let bufferChars = 0;

  const flushParagraphBuffer = () => {
    if (paragraphBuffer.length === 0 || bufferStart === null || bufferEnd === null) return;
    const content = normalizeBlockContent(paragraphBuffer.join('\n\n'));
    if (!content) {
      paragraphBuffer = [];
      bufferStart = null;
      bufferEnd = null;
      bufferChars = 0;
      return;
    }
    ranges.push({
      type: 'paragraph',
      content,
      headingLevel: 0,
      headingPath: getHeadingPathForLine(headings, bufferStart),
      lineStart: bufferStart,
      lineEnd: bufferEnd,
      semanticGroup: 'semantic-paragraph',
    });
    paragraphBuffer = [];
    bufferStart = null;
    bufferEnd = null;
    bufferChars = 0;
  };

  children.forEach((node) => {
    if (!node?.position?.start?.line || !node?.position?.end?.line) return;
    const lineStart = Number(node.position.start.line);
    const lineEnd = Number(node.position.end.line);
    const content = extractRange(source, lineStart, lineEnd);
    if (!content) return;

    const type = classifyAstNode(node, content);
    const isAtomic = ['heading', 'code', 'table', 'blockquote', 'list', 'divider'].includes(type);
    const charCount = normalizeBlockContent(content).length;

    if (isAtomic) {
      flushParagraphBuffer();
      ranges.push({
        type,
        content,
        headingLevel: type === 'heading' ? Number(node.depth || 0) : 0,
        headingPath: getHeadingPathForLine(headings, lineStart),
        lineStart,
        lineEnd,
        semanticGroup: type === 'heading' ? `semantic-heading-${Number(node.depth || 0)}` : `semantic-${type}`,
      });
      return;
    }

    if (bufferChars >= 300 && bufferChars + charCount > 800) {
      flushParagraphBuffer();
    }

    if (bufferStart === null) bufferStart = lineStart;
    bufferEnd = lineEnd;
    bufferChars += charCount;
    paragraphBuffer.push(content);
  });

  flushParagraphBuffer();

  if (ranges.length > 1) {
    const last = ranges[ranges.length - 1];
    const prev = ranges[ranges.length - 2];
    if (
      last.type === 'paragraph'
      && prev.type === 'paragraph'
      && normalizeBlockContent(last.content).length < 120
    ) {
      prev.content = normalizeBlockContent(`${prev.content}\n\n${last.content}`);
      prev.lineEnd = last.lineEnd;
      ranges.pop();
    }
  }

  return ranges;
}

function splitMarkdownFallback(markdown = '') {
  const source = normalizeBlockContent(markdown);
  if (!source) return [];

  const blocks = [];
  const lines = source.split('\n');
  let buffer = [];
  let inCode = false;

  const flush = (lineEnd) => {
    const content = normalizeBlockContent(buffer.join('\n'));
    if (content) {
      const lineStart = Math.max(1, lineEnd - buffer.length + 1);
      blocks.push({
        type: detectType(content),
        content,
        headingLevel: 0,
        headingPath: '',
        lineStart,
        lineEnd,
        semanticGroup: 'fallback',
      });
    }
    buffer = [];
  };

  lines.forEach((line, index) => {
    const currentLine = index + 1;
    if (line.trim().startsWith('```')) {
      buffer.push(line);
      if (inCode) {
        flush(currentLine);
        inCode = false;
      } else {
        inCode = true;
      }
      return;
    }

    if (inCode) {
      buffer.push(line);
      return;
    }

    if (!line.trim()) {
      flush(currentLine - 1);
      return;
    }

    if (/^#{1,6}\s/.test(line) && buffer.length > 0) {
      flush(currentLine - 1);
    }
    buffer.push(line);
  });

  flush(lines.length);
  return blocks;
}

async function markdownToCanvasBlocks(markdown = '') {
  const source = normalizeBlockContent(markdown);
  if (!source) return [];

  const tree = await safeParseMarkdown(source);
  const headings = buildHeadingIndex(source, tree);
  const preferredDepth = choosePreferredHeadingDepth(headings);
  const ranges = preferredDepth
    ? buildHeadingDrivenRanges(source, tree, preferredDepth)
    : buildSemanticRanges(source, tree);
  const normalizedRanges = ranges.length > 0 ? ranges : splitMarkdownFallback(source);

  return normalizedRanges
    .map((range, index) => createBlock(index + 1, range.type || detectType(range.content), range.content, range))
    .filter((block) => normalizeBlockContent(block.content));
}

function blocksToMarkdown(blocks = []) {
  return blocks
    .map((block) => normalizeBlockContent(block.content))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

async function articleFromMarkdown({ id = null, file_id = null, title = '', markdown = '' } = {}) {
  return {
    id,
    file_id,
    title,
    blocks: await markdownToCanvasBlocks(markdown),
  };
}

module.exports = {
  markdownToCanvasBlocks,
  blocksToMarkdown,
  articleFromMarkdown,
};
