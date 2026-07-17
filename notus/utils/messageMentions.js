function cleanPath(value = '') {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
}

function labelFromPath(path = '', type = 'file') {
  const normalized = cleanPath(path);
  if (!normalized) return type === 'folder' ? '未命名目录' : '未命名文件';
  return normalized.split('/').pop() || normalized;
}

export function normalizeMessageMentions(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).reduce((result, item) => {
    const type = item?.type === 'folder' ? 'folder' : 'file';
    const path = cleanPath(item?.path || item?.preview || '');
    const id = String(item?.id || item?.value || (path ? `${type}:${path}` : '')).trim();
    const name = String(item?.name || item?.label || labelFromPath(path, type)).trim();
    const key = `${type}:${id || path}`;
    if ((!id && !path) || !name || seen.has(key)) return result;
    seen.add(key);
    result.push({ id: id || `${type}:${path}`, type, name, path });
    return result;
  }, []);
}

export function parseLegacyMentions(content = '') {
  const mentions = [];
  const segments = [];
  let cursor = 0;
  const source = String(content || '');
  source.replace(/@\{(folder:)?([^}]+)\}/g, (token, folderPrefix, rawPath, offset) => {
    const text = source.slice(cursor, offset);
    if (text) segments.push({ type: 'text', text });
    const type = folderPrefix ? 'folder' : 'file';
    const path = cleanPath(rawPath);
    if (path) {
      const mention = { id: `${type}:${path}`, type, name: labelFromPath(path, type), path };
      mentions.push(mention);
      segments.push({ type: 'mention', mention });
    }
    cursor = offset + token.length;
    return token;
  });
  const tail = source.slice(cursor);
  if (tail) segments.push({ type: 'text', text: tail });
  const text = String(content || '').replace(/@\{(folder:)?([^}]+)\}/g, (token, folderPrefix, rawPath) => {
    const type = folderPrefix ? 'folder' : 'file';
    const path = cleanPath(rawPath);
    if (path) {
      mentions.push({
        id: `${type}:${path}`,
        type,
        name: labelFromPath(path, type),
        path,
      });
    }
    return '';
  });
  return {
    mentions: normalizeMessageMentions(mentions),
    content: text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    segments,
  };
}

export function normalizeMentionSegments(items = [], mentions = [], fallbackContent = '') {
  const known = normalizeMessageMentions(mentions);
  const byId = new Map(known.map((mention) => [String(mention.id), mention]));
  const segments = (Array.isArray(items) ? items : []).reduce((result, item) => {
    if (item?.type === 'text') {
      const text = String(item.text || '');
      if (text) result.push({ type: 'text', text });
      return result;
    }
    if (item?.type === 'mention') {
      const mention = normalizeMessageMentions([item.mention || byId.get(String(item.mentionId)) || item])[0];
      if (mention) result.push({ type: 'mention', mention });
    }
    return result;
  }, []);
  if (segments.length > 0) return segments;
  if (known.length > 0) return [{ type: 'text', text: String(fallbackContent || '') }, ...known.map((mention) => ({ type: 'mention', mention }))];
  return [{ type: 'text', text: String(fallbackContent || '') }];
}

export function segmentsToContent(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment.text || ''))
    .join('');
}

export function segmentsToMentions(segments = []) {
  return normalizeMessageMentions((Array.isArray(segments) ? segments : [])
    .filter((segment) => segment?.type === 'mention')
    .map((segment) => segment.mention));
}

export function segmentsToAgentInput(segments = []) {
  return (Array.isArray(segments) ? segments : []).map((segment) => (
    segment?.type === 'mention' ? mentionToAgentToken(segment.mention) : String(segment?.text || '')
  )).join('');
}

export function mentionToAgentToken(mention = {}) {
  const path = cleanPath(mention.path);
  if (!path) return '';
  return mention.type === 'folder' ? `@{folder:${path}}` : `@{${path}}`;
}
