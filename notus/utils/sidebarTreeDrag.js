function normalizeTreePath(value = '') {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function extractParentPath(filePath = '') {
  const normalized = normalizeTreePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function canMoveTreeItem(item, destination = '') {
  if (!item || !['file', 'folder'].includes(item.type)) return false;
  const source = normalizeTreePath(item.path);
  const target = normalizeTreePath(destination);
  if (!source || extractParentPath(source) === target) return false;
  return item.type !== 'folder' || (target !== source && !target.startsWith(`${source}/`));
}

module.exports = {
  canMoveTreeItem,
  normalizeTreePath,
};
