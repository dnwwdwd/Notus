function createBlock(index, type, content, meta = {}) {
  return {
    id: `b_${index}`,
    type,
    content,
    ...meta,
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

function splitMarkdown(markdown = '') {
  const source = normalizeBlockContent(markdown);
  if (!source) return [];

  const blocks = [];
  const lines = source.split('\n');
  let buffer = [];
  let inCode = false;

  const flush = () => {
    const content = normalizeBlockContent(buffer.join('\n'));
    if (content) blocks.push(content);
    buffer = [];
  };

  lines.forEach((line) => {
    if (line.trim().startsWith('```')) {
      buffer.push(line);
      if (inCode) {
        flush();
        inCode = false;
      } else {
        if (buffer.length > 1) {
          const last = buffer.pop();
          flush();
          buffer.push(last);
        }
        inCode = true;
      }
      return;
    }

    if (inCode) {
      buffer.push(line);
      return;
    }

    if (!line.trim()) {
      flush();
      return;
    }

    if (/^#{1,6}\s/.test(line) && buffer.length > 0) flush();
    buffer.push(line);
  });

  flush();
  return blocks;
}

function markdownToCanvasBlocks(markdown = '') {
  return splitMarkdown(markdown).map((chunk, index) => createBlock(index + 1, detectType(chunk), chunk));
}

function blocksToMarkdown(blocks = []) {
  return blocks
    .map((block) => normalizeBlockContent(block.content))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function articleFromMarkdown({ id = null, file_id = null, title = '', markdown = '' } = {}) {
  return {
    id,
    file_id,
    title,
    blocks: markdownToCanvasBlocks(markdown),
  };
}

module.exports = {
  markdownToCanvasBlocks,
  blocksToMarkdown,
  articleFromMarkdown,
};
