const assert = require('assert');

const {
  compareFilesForDisplay,
  sortTreeForDisplay,
  sortFilesForDisplay,
} = require('../lib/sidebarSort');

function runTests() {
  const olderFile = {
    id: 1,
    type: 'file',
    title: '旧文件',
    path: 'notes/old.md',
    updated_at: '2026-05-16T10:00:00.000Z',
  };
  const newerFile = {
    id: 2,
    type: 'file',
    title: '新文件',
    path: 'notes/new.md',
    updated_at: '2026-05-17T10:00:00.000Z',
  };

  assert.ok(compareFilesForDisplay(newerFile, olderFile) < 0, '更新时间新的文件应排在前面');
  assert.ok(compareFilesForDisplay(olderFile, newerFile) > 0, '更新时间旧的文件应排在后面');

  const sameTimeFiles = [
    {
      id: 3,
      type: 'file',
      title: '乙文档',
      path: 'notes/b.md',
      updated_at: '2026-05-17T10:00:00.000Z',
    },
    {
      id: 4,
      type: 'file',
      title: '甲文档',
      path: 'notes/a.md',
      updated_at: '2026-05-17T10:00:00.000Z',
    },
  ];
  const sameTimeSorted = sortFilesForDisplay(sameTimeFiles);
  assert.deepStrictEqual(sameTimeSorted.map((item) => item.title), ['甲文档', '乙文档']);

  const orderedFiles = sortFilesForDisplay([olderFile, newerFile]);
  assert.deepStrictEqual(orderedFiles.map((item) => item.id), [2, 1], '仅打开文件不应改变排序规则');

  const tree = sortTreeForDisplay([
    {
      type: 'folder',
      name: 'z-folder',
      path: 'z-folder',
      children: [olderFile, newerFile],
    },
    {
      type: 'folder',
      name: 'a-folder',
      path: 'a-folder',
      children: [],
    },
    {
      ...sameTimeFiles[0],
      name: '乙文档',
    },
    {
      ...sameTimeFiles[1],
      name: '甲文档',
    },
  ]);

  assert.deepStrictEqual(
    tree.map((item) => item.type === 'folder' ? item.name : item.title),
    ['a-folder', 'z-folder', '甲文档', '乙文档']
  );
  assert.deepStrictEqual(tree[1].children.map((item) => item.id), [2, 1], '文件夹内文件应按统一规则排序');

  console.log('sidebar sort tests passed');
}

runTests();
