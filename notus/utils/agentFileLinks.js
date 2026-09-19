export const INTERNAL_FILE_LINK_PREFIX = 'notus://file/';

export function internalFileLinkHref(fileId) {
  return `${INTERNAL_FILE_LINK_PREFIX}${Number(fileId)}`;
}

export function parseInternalFileLink(href = '') {
  const matched = String(href || '').trim().match(/^notus:\/\/file\/([1-9]\d*)(?:[?#].*)?$/i);
  if (!matched) return null;
  const fileId = Number(matched[1]);
  return Number.isFinite(fileId) && fileId > 0 ? fileId : null;
}

function normalizePath(value = '') {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function fileName(file = {}) {
  const path = normalizePath(file.path);
  return String(file.name || path.split('/').pop() || file.title || '').trim();
}

function hasFileBoundary(value = '', index, direction) {
  const cursor = direction === 'before' ? index - 1 : index;
  const character = value.charAt(cursor);
  return !character || !/[A-Za-z0-9_./\\-]/.test(character);
}

export function buildAgentFileLinkCandidates(files = []) {
  const pathCandidates = new Map();
  const nameCandidates = new Map();

  (Array.isArray(files) ? files : []).forEach((file) => {
    const id = Number(file?.id);
    const path = normalizePath(file?.path);
    const name = fileName(file);
    if (!Number.isInteger(id) || id <= 0 || !path) return;
    const reference = { id, path, name };
    pathCandidates.set(path, reference);
    if (!name) return;
    if (!nameCandidates.has(name)) nameCandidates.set(name, reference);
    else if (nameCandidates.get(name)?.id !== id) nameCandidates.set(name, null);
  });

  const candidates = new Map(pathCandidates);
  nameCandidates.forEach((reference, name) => {
    if (reference && !candidates.has(name)) candidates.set(name, reference);
  });
  return [...candidates.entries()]
    .map(([value, reference]) => ({ value, reference }))
    .sort((left, right) => right.value.length - left.value.length || left.value.localeCompare(right.value));
}

function linkifyAgentFileTextWithCandidates(value = '', candidates = []) {
  const source = String(value || '');
  if (!source || candidates.length === 0) return [{ type: 'text', value: source }];

  const parts = [];
  let cursor = 0;
  let textStart = 0;
  while (cursor < source.length) {
    const candidate = candidates.find(({ value: candidateValue }) => (
      source.startsWith(candidateValue, cursor)
      && hasFileBoundary(source, cursor, 'before')
      && hasFileBoundary(source, cursor + candidateValue.length, 'after')
    ));
    if (!candidate) {
      cursor += 1;
      continue;
    }
    if (textStart < cursor) parts.push({ type: 'text', value: source.slice(textStart, cursor) });
    parts.push({
      type: 'link',
      url: internalFileLinkHref(candidate.reference.id),
      children: [{ type: 'text', value: source.slice(cursor, cursor + candidate.value.length) }],
    });
    cursor += candidate.value.length;
    textStart = cursor;
  }
  if (textStart < source.length) parts.push({ type: 'text', value: source.slice(textStart) });
  return parts.length > 0 ? parts : [{ type: 'text', value: source }];
}

export function linkifyAgentFileText(value = '', files = []) {
  return linkifyAgentFileTextWithCandidates(value, buildAgentFileLinkCandidates(files));
}

function replaceTextChildren(node, candidates = []) {
  if (!Array.isArray(node?.children)) return;
  node.children = node.children.flatMap((child) => {
    if (child?.type === 'text') return linkifyAgentFileTextWithCandidates(child.value, candidates);
    if (!['link', 'linkReference', 'code', 'inlineCode', 'html'].includes(child?.type)) replaceTextChildren(child, candidates);
    return child;
  });
}

export function remarkLinkifyAgentFileReferences({ files = [] } = {}) {
  const candidates = buildAgentFileLinkCandidates(files);
  return (tree) => replaceTextChildren(tree, candidates);
}
