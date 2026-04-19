const path = require('path');

const FILE_RECORDS = [
  {
    id: 1,
    path: '技术文章/缓存系列/性能优化实践.md',
    title: '性能优化实践',
    indexed: 1,
    updated_at: '2026-04-12T10:00:00Z',
    content: `# 性能优化实践

## 为什么需要缓存

直觉上，数据库是系统的真相之源。但当 QPS 超过数千、甚至上万时，真相之源的访问代价会迅速变得无法接受。

## 缓存的基本策略

常见的缓存更新策略有三种：*Cache-Aside*、*Read/Write-Through* 和 *Write-Back*。

### Cache-Aside

读时先查缓存，命中直接返回；未命中则穿透到数据库，读完回填缓存。写操作直接写数据库，并**主动失效**缓存。

\`\`\`js
function get(key) {
  let value = cache.get(key);
  if (value) return value;
  value = db.query(key);
  cache.set(key, value, 60);
  return value;
}
\`\`\`

> Cache-Aside 把缓存视为“可有可无的加速层”，失败时应当回退到数据库，而不是把错误抛给调用方。

## 失效与击穿

缓存失效时的瞬间，如果大量请求同时穿透到数据库，就会出现“缓存击穿”。

## 实践建议

1. 读写比高于 10:1 的数据优先缓存
2. 缓存 key 加版本号或业务标识防碰撞
3. 设置合理的 TTL + 主动失效双保险
`,
  },
  {
    id: 2,
    path: '技术文章/缓存系列/Redis 深入.md',
    title: 'Redis 深入',
    indexed: 1,
    updated_at: '2026-04-10T14:00:00Z',
    content: `# Redis 深入

## 数据结构

Redis 提供了六种核心数据结构：String、List、Hash、Set、ZSet、Stream。

### String

最基础的类型，底层是 SDS（Simple Dynamic String）。支持原子递增，常用于计数器和分布式 ID。

### ZSet（有序集合）

ZSet 内部使用**跳表 + 哈希表**的双重结构。跳表保证 O(log N) 的有序操作，哈希表保证 O(1) 的随机访问。

## 一致性模型

强一致不是缓存该解决的问题，而是事务层应当负责的范畴。

## 持久化

- **RDB**：定时快照，体积小，恢复快，但可能丢失最后一段时间的数据。
- **AOF**：追加操作日志，数据更完整，但文件更大，重放慢。
- **混合模式**（推荐）：AOF 文件头存 RDB 快照，尾部追加增量日志。
`,
  },
  {
    id: 3,
    path: '技术文章/缓存系列/CDN 边缘计算.md',
    title: 'CDN 边缘计算',
    indexed: 0,
    updated_at: '2026-04-08T09:00:00Z',
    content: `# CDN 边缘计算

边缘节点离用户更近，但“更近”不等于“更简单”。

## 两个重点

- 缓存命中率决定大部分收益
- 回源链路决定最坏情况的体验
`,
  },
  {
    id: 4,
    path: '随笔/关于慢的意义.md',
    title: '关于慢的意义',
    indexed: 1,
    updated_at: '2026-04-06T18:00:00Z',
    content: `# 关于慢的意义

窗外下着雨，煮茶的水刚开始冒泡。这是我这周第四次无所事事地坐在厨房里。

## 慢的价值

起初是愧疚的。有太多事情该做了。但坐久了，愧疚像水汽一样淡下去，留下一种久违的、几乎被遗忘的平静。

慢从来不是效率的反义词。当我们允许自己在一件事上多停留几分钟，专注反而会悄悄重新回来。

## 反直觉的发现

有时候，限制速度是为了找回质量。
`,
  },
  {
    id: 5,
    path: '随笔/周末煮茶.md',
    title: '周末煮茶',
    indexed: 1,
    updated_at: '2026-04-05T11:00:00Z',
    content: `# 周末煮茶

铁壶里的水咕嘟作响。今天用的是去年秋天的武夷岩茶，放了一年，火气褪了，有一种沉的香。

## 工序

1. 温壶：沸水先过一遍，让壶壁均匀受热
2. 投茶：岩茶放量偏大，约 8g / 130ml
3. 第一泡：5 秒出汤，只为醒茶，不喝

## 一些念头

好的茶不需要着急地喝完。每泡之间可以等很久，坐在那里什么都不做也可以。
`,
  },
  {
    id: 6,
    path: '随笔/搬家第三周.md',
    title: '搬家第三周',
    indexed: 0,
    updated_at: '2026-04-01T15:00:00Z',
    content: `# 搬家第三周

箱子还没全部拆完，但房间已经开始有了人的气味。

## 一点变化

房子不必立刻住满，就像一段时间不必立刻填满。
`,
  },
  {
    id: 7,
    path: '读书笔记/《项目管理的艺术》.md',
    title: '《项目管理的艺术》',
    indexed: 1,
    updated_at: '2026-03-28T12:00:00Z',
    content: `# 《项目管理的艺术》

## 摘录

项目管理真正难的部分，不是列计划，而是协调人和不确定性。
`,
  },
  {
    id: 8,
    path: '读书笔记/《思考快与慢》摘录.md',
    title: '《思考快与慢》摘录',
    indexed: 1,
    updated_at: '2026-03-20T10:00:00Z',
    content: `# 《思考快与慢》摘录

## 系统一与系统二

系统一更快、更直觉；系统二更慢、更审慎，但也更费力。
`,
  },
  {
    id: 9,
    path: 'README.md',
    title: 'README',
    indexed: 1,
    updated_at: '2026-03-01T08:00:00Z',
    content: `# README

欢迎来到 Notus 的示例笔记目录。
`,
  },
  {
    id: 10,
    path: '技术文章/分布式系统/一致性模型.md',
    title: '一致性模型',
    indexed: 1,
    updated_at: '2026-03-18T08:00:00Z',
    content: `# 一致性模型

## 最终一致性

最终一致性不是妥协，而是一种在可用性和成本之间更现实的选择。
`,
  },
];

const INITIAL_FOLDERS = [
  '技术文章',
  '技术文章/缓存系列',
  '技术文章/分布式系统',
  '随笔',
  '读书笔记',
];

const state = {
  files: FILE_RECORDS.map((item) => ({ ...item })),
  folders: new Set(INITIAL_FOLDERS),
};

function normalizePath(inputPath) {
  return (inputPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function ensureMarkdownName(name) {
  return /\.md$/i.test(name) ? name : `${name}.md`;
}

function getParentPath(targetPath) {
  const normalized = normalizePath(targetPath);
  if (!normalized || !normalized.includes('/')) return '';
  return normalized.slice(0, normalized.lastIndexOf('/'));
}

function getBaseName(targetPath) {
  const normalized = normalizePath(targetPath);
  if (!normalized) return '';
  return normalized.split('/').pop();
}

function localeCompare(a, b) {
  return a.localeCompare(b, 'zh-Hans-CN');
}

function sortTree(nodes) {
  nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
    return localeCompare(left.name, right.name);
  });

  nodes.forEach((node) => {
    if (node.children) sortTree(node.children);
  });
}

function ensureFolderPath(folderPath) {
  const normalized = normalizePath(folderPath);
  if (!normalized) return;

  const segments = normalized.split('/');
  let current = '';
  segments.forEach((segment) => {
    current = current ? `${current}/${segment}` : segment;
    state.folders.add(current);
  });
}

function getAllFiles() {
  return state.files
    .map(({ content, ...file }) => ({ ...file }))
    .sort((left, right) => localeCompare(left.path, right.path));
}

function getFileById(id) {
  const numericId = Number(id);
  const file = state.files.find((item) => item.id === numericId);
  return file ? { ...file } : null;
}

function createFolder(folderPath) {
  const normalized = normalizePath(folderPath);
  if (!normalized) {
    throw new Error('folder path is required');
  }

  const existsAsFile = state.files.some((file) => file.path === normalized);
  if (existsAsFile) {
    throw new Error('folder path conflicts with an existing file');
  }

  ensureFolderPath(normalized);

  return {
    type: 'folder',
    path: normalized,
    name: getBaseName(normalized),
  };
}

function createFile(filePath, content = '') {
  const normalized = normalizePath(filePath);
  if (!normalized) {
    throw new Error('file path is required');
  }

  const finalPath = normalized.endsWith('.md') ? normalized : ensureMarkdownName(normalized);
  const exists = state.files.some((file) => file.path === finalPath);
  if (exists) {
    throw new Error('file already exists');
  }

  ensureFolderPath(getParentPath(finalPath));

  const id = state.files.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  const title = getBaseName(finalPath).replace(/\.md$/i, '');
  const file = {
    id,
    path: finalPath,
    title,
    indexed: 0,
    updated_at: new Date().toISOString(),
    content: content || `# ${title}\n\n`,
  };

  state.files.push(file);
  return { ...file };
}

function updateFile(id, content) {
  const numericId = Number(id);
  const file = state.files.find((item) => item.id === numericId);
  if (!file) {
    throw new Error('file not found');
  }

  file.content = content;
  file.updated_at = new Date().toISOString();
  file.title = extractTitle(file.path, content);
  file.indexed = 1;

  return { ...file };
}

function deleteFile(id) {
  const numericId = Number(id);
  const index = state.files.findIndex((item) => item.id === numericId);
  if (index === -1) return false;
  state.files.splice(index, 1);
  return true;
}

function extractTitle(filePath, content) {
  const firstHeading = (content || '').match(/^#\s+(.+)$/m);
  if (firstHeading) return firstHeading[1].trim();
  return getBaseName(filePath).replace(/\.md$/i, '');
}

function buildTree() {
  const roots = [];
  const folderNodes = new Map();

  const getFolderNode = (folderPath) => {
    const normalized = normalizePath(folderPath);
    if (!normalized) return null;
    if (folderNodes.has(normalized)) return folderNodes.get(normalized);

    const node = {
      type: 'folder',
      name: getBaseName(normalized),
      path: normalized,
      children: [],
    };

    folderNodes.set(normalized, node);

    const parentPath = getParentPath(normalized);
    const parentNode = getFolderNode(parentPath);
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);

    return node;
  };

  Array.from(state.folders)
    .sort((left, right) => left.split('/').length - right.split('/').length || localeCompare(left, right))
    .forEach((folderPath) => {
      getFolderNode(folderPath);
    });

  getAllFiles().forEach((file) => {
    const parentPath = getParentPath(file.path);
    const parentNode = getFolderNode(parentPath);
    const node = {
      type: 'file',
      id: file.id,
      name: getBaseName(file.path),
      path: file.path,
      indexed: file.indexed,
      status: file.indexed ? undefined : 'indexing',
      updated_at: file.updated_at,
    };

    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  });

  sortTree(roots);
  return roots;
}

module.exports = {
  buildTree,
  createFile,
  createFolder,
  deleteFile,
  getAllFiles,
  getFileById,
  normalizePath,
  updateFile,
};
