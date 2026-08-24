export function getAgentAuthorizedDirectory(filePath = '') {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}
