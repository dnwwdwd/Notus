const crypto = require('crypto');
const { estimateTextTokens } = require('./llmBudget');

function generateStableId() {
  return `notus_${crypto.randomBytes(12).toString('hex')}`;
}

function parseScalar(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function parseTags(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map(parseScalar)
      .filter(Boolean);
  }
  return raw
    .split(',')
    .map(parseScalar)
    .filter(Boolean);
}

function parseFrontmatter(content = '') {
  const source = String(content || '').replace(/\r\n/g, '\n');
  if (!source.startsWith('---\n')) {
    return { data: {}, raw: '', body: source, start: -1, end: -1 };
  }

  const end = source.indexOf('\n---', 4);
  if (end === -1) {
    return { data: {}, raw: '', body: source, start: -1, end: -1 };
  }

  const closeEnd = source.indexOf('\n', end + 1);
  const raw = source.slice(4, end).trim();
  const body = closeEnd === -1 ? '' : source.slice(closeEnd + 1);
  const data = {};

  raw.split('\n').forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === 'tags') data[key] = parseTags(value);
    else data[key] = parseScalar(value);
  });

  return { data, raw, body, start: 0, end: closeEnd === -1 ? source.length : closeEnd + 1 };
}

function formatFrontmatterValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`;
  return JSON.stringify(String(value || ''));
}

function injectFrontmatterId(content = '', stableId = generateStableId()) {
  const source = String(content || '').replace(/\r\n/g, '\n');
  const parsed = parseFrontmatter(source);
  if (parsed.data.id) return source;

  if (parsed.raw) {
    const nextRaw = [`id: ${formatFrontmatterValue(stableId)}`, parsed.raw].filter(Boolean).join('\n');
    return `---\n${nextRaw}\n---\n${parsed.body}`;
  }

  return `---\nid: ${formatFrontmatterValue(stableId)}\n---\n\n${source.replace(/^\n+/, '')}`;
}

function shouldHideSystemFrontmatter(frontmatter = {}) {
  const keys = Object.keys(frontmatter || {});
  if (keys.length !== 1 || keys[0] !== 'id') return false;
  const value = String(frontmatter.id || '').trim();
  return value.startsWith('notus_');
}

function splitEditorVisibleMarkdown(content = '') {
  const source = String(content || '').replace(/\r\n/g, '\n');
  const parsed = parseFrontmatter(source);
  if (!parsed.raw || !shouldHideSystemFrontmatter(parsed.data)) {
    return {
      visibleContent: source,
      hiddenFrontmatter: '',
      hiddenFrontmatterData: null,
    };
  }

  const hiddenBlock = source.slice(0, parsed.end);
  return {
    visibleContent: String(parsed.body || '').replace(/^\n+/, ''),
    hiddenFrontmatter: hiddenBlock,
    hiddenFrontmatterData: parsed.data,
  };
}

function mergeEditorVisibleMarkdown(visibleContent = '', hiddenFrontmatter = '') {
  const body = String(visibleContent || '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const frontmatterBlock = String(hiddenFrontmatter || '').replace(/\r\n/g, '\n').trim();
  if (!frontmatterBlock) return body;
  if (!body) return `${frontmatterBlock}\n`;
  return `${frontmatterBlock}\n\n${body}`;
}

function extractHeadingOutline(content = '') {
  return String(content || '')
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (!match) return null;
      return {
        level: match[1].length,
        title: match[2].trim(),
        line: index + 1,
      };
    })
    .filter(Boolean);
}

function extractVisiblePrimaryHeading(content = '') {
  const source = String(content || '').replace(/\r\n/g, '\n');
  const parsed = parseFrontmatter(source);
  const body = String(parsed.raw || '') ? String(parsed.body || '').replace(/^\n+/, '') : source;
  const firstHeading = extractHeadingOutline(body).find((item) => item.level === 1);
  return String(firstHeading?.title || '').trim();
}

function normalizeFileNameBase(value = '') {
  const normalized = String(value || '')
    .replace(/\r\n/g, ' ')
    .replace(/[\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[. ]+$/g, '')
    .replace(/\u0000/g, '');

  return normalized;
}

function rewriteVisibleMarkdownPrimaryHeading(visibleContent = '', headingTitle = '') {
  const source = String(visibleContent || '').replace(/\r\n/g, '\n');
  const nextTitle = String(headingTitle || '').trim();
  if (!nextTitle) return source;

  const parsed = parseFrontmatter(source);
  const body = String(parsed.raw || '') ? String(parsed.body || '').replace(/^\n+/, '') : source;
  const bodyLines = body ? body.split('\n') : [];
  let replaced = false;
  const nextBodyLines = bodyLines.map((line) => {
    if (!replaced && /^#\s+/.test(line)) {
      replaced = true;
      return `# ${nextTitle}`;
    }
    return line;
  });

  let nextBody = nextBodyLines.join('\n').replace(/\n+$/g, '\n');
  if (!replaced) {
    nextBody = body
      ? `# ${nextTitle}\n\n${body.replace(/^\n+/, '')}`
      : `# ${nextTitle}\n`;
  }

  if (String(parsed.raw || '')) {
    return `${source.slice(0, parsed.end)}\n${nextBody}`;
  }
  return nextBody;
}

function buildMarkdownMetadata(content = '', filePath = '', stat = null) {
  const source = String(content || '');
  const frontmatter = parseFrontmatter(source);
  const headingOutline = extractHeadingOutline(source);
  const firstHeading = headingOutline.find((item) => item.level === 1) || headingOutline[0] || null;
  const title = String(frontmatter.data.title || firstHeading?.title || '').trim();
  const tags = Array.isArray(frontmatter.data.tags) ? frontmatter.data.tags : [];

  return {
    frontmatterId: String(frontmatter.data.id || '').trim(),
    title,
    tags,
    frontmatter: frontmatter.data,
    headingOutline,
    size: stat ? Number(stat.size || 0) : Buffer.byteLength(source, 'utf8'),
    mtime: stat ? Math.floor(Number(stat.mtimeMs || 0)) : 0,
    charCount: source.length,
    tokenCount: estimateTextTokens(source),
    filePath,
  };
}

module.exports = {
  buildMarkdownMetadata,
  extractHeadingOutline,
  extractVisiblePrimaryHeading,
  generateStableId,
  injectFrontmatterId,
  mergeEditorVisibleMarkdown,
  parseFrontmatter,
  normalizeFileNameBase,
  rewriteVisibleMarkdownPrimaryHeading,
  splitEditorVisibleMarkdown,
};
