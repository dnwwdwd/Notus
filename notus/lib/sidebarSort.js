const { getVisibleDocumentLabel } = require('./documentLabels');

function toTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareFilesForDisplay(left, right) {
  const timeDiff = toTimestamp(right?.updated_at) - toTimestamp(left?.updated_at);
  if (timeDiff !== 0) return timeDiff;

  const leftLabel = getVisibleDocumentLabel(left, left?.path || '');
  const rightLabel = getVisibleDocumentLabel(right, right?.path || '');
  return leftLabel.localeCompare(rightLabel, 'zh-Hans-CN');
}

function sortTreeForDisplay(nodes) {
  const folders = [];
  const files = [];

  nodes.forEach((node) => {
    if (node.type === 'folder') {
      folders.push({
        ...node,
        children: sortTreeForDisplay(node.children || []),
      });
      return;
    }
    files.push(node);
  });

  folders.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  files.sort(compareFilesForDisplay);

  return [...folders, ...files];
}

function sortFilesForDisplay(files) {
  return [...files].sort(compareFilesForDisplay);
}

module.exports = {
  compareFilesForDisplay,
  sortTreeForDisplay,
  sortFilesForDisplay,
};
