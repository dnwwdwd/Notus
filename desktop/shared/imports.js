const fs = require('fs');
const path = require('path');

function isMarkdownFile(filePath) {
  return /\.md$/i.test(filePath);
}

async function collectMarkdownFiles(targetPath, relativeBase = '') {
  const stats = await fs.promises.stat(targetPath);

  if (stats.isFile()) {
    if (!isMarkdownFile(targetPath)) return [];
    return [{
      absolutePath: targetPath,
      relativePath: relativeBase || path.basename(targetPath),
    }];
  }

  const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const absolutePath = path.join(targetPath, entry.name);
    const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const nested = await collectMarkdownFiles(absolutePath, relativePath);
      results.push(...nested);
      continue;
    }

    if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;
    results.push({ absolutePath, relativePath });
  }

  return results;
}

async function collectMarkdownEntries(selectedPaths = []) {
  const seen = new Set();
  const results = [];

  for (const selectedPath of selectedPaths) {
    const normalized = path.resolve(selectedPath);
    const rootName = path.basename(normalized);
    const items = await collectMarkdownFiles(normalized, rootName);
    for (const item of items) {
      const relativePath = item.relativePath.replace(/\\/g, '/');
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      results.push({
        name: path.basename(relativePath),
        relativePath,
        content: await fs.promises.readFile(item.absolutePath, 'utf8'),
      });
    }
  }

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-Hans-CN'));
}

module.exports = {
  collectMarkdownEntries,
};
