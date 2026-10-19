const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-import-chunked-'));
const notesDir = path.join(root, 'notes');
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web',
  NOTUS_DATA_ROOT: root,
  NOTES_DIR: notesDir,
  DB_PATH: path.join(root, 'db.sqlite'),
  ASSETS_DIR: path.join(root, 'assets'),
  SESSION_DIR: path.join(root, 'session'),
  LOG_DIR: path.join(root, 'logs'),
});

const { getDb } = require('../lib/db');
const { importFileBatch, MAX_FILE_BYTES, buildTargetPath } = require('../lib/fileImport');
const { getJobRecord, buildItemKey } = require('../lib/importJobs');
const { getFileByPath, listMarkdownFiles, readMarkdownFile } = require('../lib/files');
const { buildTree } = require('../lib/files');

getDb();
fs.mkdirSync(notesDir, { recursive: true });

async function run() {
  const events = [];
  const onEvent = (event) => events.push(event);

  // 1. 基本导入 + 逐文件结果 + 作业记录。
  const jobA = 'imp_test_job_a';
  const first = await importFileBatch({
    parentPath: 'docs',
    conflictPolicy: 'skip',
    jobId: jobA,
    files: [
      { name: '一.md', content: '# 一\n\n内容一\n' },
      { name: '二.md', content: '# 二\n\n内容二\n' },
    ],
    onEvent,
  });
  assert.strictEqual(first.summary.imported, 2, '两个文件都应导入成功');
  assert.strictEqual(first.summary.failed, 0);
  assert.strictEqual(first.hasMore, false);
  assert.strictEqual(first.remaining, 0);
  assert.ok(fs.existsSync(path.join(notesDir, 'docs', '一.md')), '文件应写入父目录');
  assert.ok(getFileByPath('docs/一.md'), '导入后应能按路径取到文件');
  assert.ok(
    getJobRecord(jobA, buildItemKey('docs', '一.md')),
    '每个文件都要留下作业记录，作为幂等与重试依据'
  );

  // 2. 幂等回放：同一 job 重发同一批，不再重复写盘，也不会被 skip 策略改判。
  const replayEvents = [];
  const replay = await importFileBatch({
    parentPath: 'docs',
    conflictPolicy: 'skip',
    jobId: jobA,
    files: [
      { name: '一.md', content: '# 一\n\n内容一\n' },
      { name: '二.md', content: '# 二\n\n内容二\n' },
    ],
    onEvent: (event) => replayEvents.push(event),
  });
  assert.strictEqual(replay.summary.imported, 2, '重放应返回导入成功而不是跳过');
  assert.strictEqual(replay.summary.skipped, 0, '同一 job 的已成功文件不得改判为跳过');
  const replayFileEvents = replayEvents.filter((event) => event.type === 'file');
  assert.strictEqual(replayFileEvents.length, 2);
  assert.ok(replayFileEvents.every((event) => event.replay === true), '重放结果需要显式标记');

  // 3. 单文件失败隔离：非法文件名失败，其它文件照常完成。
  const jobB = 'imp_test_job_b';
  const isolated = await importFileBatch({
    parentPath: '',
    conflictPolicy: 'skip',
    jobId: jobB,
    files: [
      { name: '正常.md', content: '# 正常\n' },
      { name: '../越界.md', content: '# 越界\n' },
      { name: '另一个.md', content: '# 另一个\n' },
    ],
    onEvent: () => {},
  });
  assert.strictEqual(isolated.summary.imported, 2, '失败文件不得影响其它文件');
  assert.strictEqual(isolated.summary.failed, 1);
  assert.strictEqual(isolated.summary.errors[0].name, '../越界.md');
  assert.strictEqual(isolated.summary.errors[0].code, 'IMPORT_FILE_PATH_INVALID');
  assert.ok(getFileByPath('正常.md') && getFileByPath('另一个.md'), '失败后后续文件仍需落盘');
  const failedRecord = getJobRecord(jobB, buildItemKey('', '../越界.md'));
  assert.strictEqual(failedRecord.status, 'failed', '失败项要记录可重试状态');

  // 4. 失败项重试：修正后同一 job 重试，只补失败的那一个。
  const retried = await importFileBatch({
    parentPath: '',
    conflictPolicy: 'skip',
    jobId: jobB,
    files: [{ name: '越界.md', content: '# 越界\n' }],
    onEvent: () => {},
  });
  assert.strictEqual(retried.summary.imported, 1, '重试应只补失败文件');
  assert.ok(getFileByPath('越界.md'));

  // 5. 单文件超上限：给出可读原因，不算作批次崩溃。
  const jobC = 'imp_test_job_c';
  const oversize = await importFileBatch({
    parentPath: '',
    conflictPolicy: 'skip',
    jobId: jobC,
    maxBytes: 16 * 1024 * 1024,
    files: [{ name: '超大.md', content: 'x'.repeat(MAX_FILE_BYTES + 1) }, { name: '小.md', content: '# 小\n' }],
    onEvent: () => {},
  });
  assert.strictEqual(oversize.summary.failed, 1);
  assert.strictEqual(oversize.summary.imported, 1, '超限文件不应中断同批其它文件');
  assert.strictEqual(oversize.summary.errors[0].code, 'IMPORT_FILE_TOO_LARGE');
  assert.ok(!fs.existsSync(path.join(notesDir, '超大.md')), '超限文件不得落盘');

  // 6. 预算暂停：达到 max_files 后返回 remaining，让客户端续传而不是丢文件。
  const jobD = 'imp_test_job_d';
  const pausing = await importFileBatch({
    parentPath: 'batch',
    conflictPolicy: 'skip',
    jobId: jobD,
    maxFiles: 2,
    files: [
      { name: 'a.md', content: '# a\n' },
      { name: 'b.md', content: '# b\n' },
      { name: 'c.md', content: '# c\n' },
      { name: 'd.md', content: '# d\n' },
    ],
    onEvent: () => {},
  });
  assert.strictEqual(pausing.processed, 2, '单次请求只处理预算内的文件');
  assert.strictEqual(pausing.remaining, 2);
  assert.strictEqual(pausing.hasMore, true);
  assert.ok(!fs.existsSync(path.join(notesDir, 'batch', 'c.md')), '剩余文件应在续传批次中处理');

  const resumed = await importFileBatch({
    parentPath: 'batch',
    conflictPolicy: 'skip',
    jobId: jobD,
    maxFiles: 2,
    files: [
      { name: 'a.md', content: '# a\n' },
      { name: 'b.md', content: '# b\n' },
      { name: 'c.md', content: '# c\n' },
      { name: 'd.md', content: '# d\n' },
    ],
    onEvent: () => {},
  });
  assert.strictEqual(resumed.summary.imported, 4, '续传批次回放已完成项并补齐剩余文件');
  assert.strictEqual(resumed.hasMore, false, '续传批次应把剩余文件处理完');
  assert.ok(fs.existsSync(path.join(notesDir, 'batch', 'c.md')) && fs.existsSync(path.join(notesDir, 'batch', 'd.md')));

  // 7. 覆盖策略：覆盖结果同样按作业记录回放，且回放不再写盘。
  const jobE = 'imp_test_job_e';
  await importFileBatch({
    parentPath: '',
    conflictPolicy: 'overwrite',
    jobId: 'imp_test_job_e_seed',
    files: [{ name: '覆盖.md', content: '# 第一版\n' }],
    onEvent: () => {},
  });
  await importFileBatch({
    parentPath: '',
    conflictPolicy: 'overwrite',
    jobId: jobE,
    files: [{ name: '覆盖.md', content: '# 第二版\n' }],
    onEvent: () => {},
  });
  const contentBeforeReplay = readMarkdownFile('覆盖.md');
  const overwrite = await importFileBatch({
    parentPath: '',
    conflictPolicy: 'overwrite',
    jobId: jobE,
    files: [{ name: '覆盖.md', content: '# 第三版\n' }],
    onEvent: () => {},
  });
  assert.strictEqual(overwrite.summary.overwritten, 1, '同一 job 的覆盖结果回放为覆盖');
  assert.strictEqual(readMarkdownFile('覆盖.md'), contentBeforeReplay, '回放不得再次写盘');

  // 8. 路径构造与文件树一致性。
  assert.strictEqual(buildTargetPath('a/b', 'c.md'), 'a/b/c.md');
  assert.strictEqual(buildTargetPath('', 'c'), 'c.md');
  assert.throws(() => buildTargetPath('', '   '), /文件名不能为空/);
  assert.throws(() => buildTargetPath('', 'a\0b.md'), /非法字符/);
  const tree = buildTree();
  const docsFolder = tree.find((node) => node.type === 'folder' && node.path === 'docs');
  assert.ok(docsFolder && docsFolder.children.some((node) => node.path === 'docs/一.md'), '导入结果应出现在文件树中');
  assert.ok(listMarkdownFiles().includes('docs/一.md'));

  console.log('import chunked upload tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
