const path = require('path');

const TECHNICAL_LABEL_PATTERNS = [
  /^article_[a-z0-9_-]+$/i,
  /^notus_[a-z0-9_-]+$/i,
  /^file(?:id)?[:#\s_-]*\d+$/i,
];

function normalizeCandidate(value = '', options = {}) {
  const stripExtension = options.stripExtension !== false;
  const normalized = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';

  const baseName = normalized.includes('/')
    ? normalized.split('/').pop()
    : normalized;
  const withoutExtension = stripExtension ? baseName.replace(/\.md$/i, '') : baseName;
  return withoutExtension.trim();
}

function getPathBaseNameWithoutExtension(filePath = '') {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/').trim();
  if (!normalizedPath) return '';
  return path.posix.basename(normalizedPath).replace(/\.md$/i, '').trim();
}

function isTechnicalDocumentLabel(value = '') {
  const normalized = normalizeCandidate(value);
  if (!normalized) return true;
  return TECHNICAL_LABEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function getVisibleDocumentLabel(input, fallback = '未命名文档') {
  const normalizedFallback = normalizeCandidate(fallback, { stripExtension: false }) || '未命名文档';
  const candidates = typeof input === 'string'
    ? [input]
    : [
      input?.title,
      input?.label,
      input?.name,
      input?.file_title,
      input?.fileName,
      input?.path ? getPathBaseNameWithoutExtension(input.path) : '',
      input?.file_path ? getPathBaseNameWithoutExtension(input.file_path) : '',
      input?.sourcePath ? getPathBaseNameWithoutExtension(input.sourcePath) : '',
    ];

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) continue;
    if (isTechnicalDocumentLabel(normalized)) continue;
    return normalized;
  }

  return normalizedFallback;
}

module.exports = {
  getPathBaseNameWithoutExtension,
  getVisibleDocumentLabel,
  isTechnicalDocumentLabel,
  normalizeCandidate,
};
