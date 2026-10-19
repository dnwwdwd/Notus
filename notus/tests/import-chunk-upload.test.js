const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-import-chunk-'));
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
const { importSingleFile, MAX_FILE_BYTES, MAX_CHUNKED_FILE_BYTES } = require('../lib/fileImport');
const {
  MAX_TOTAL_CHUNKS,
  assembleChunks,
  buildStagingPath,
  listChunkRecords,
  removeStagingItem,
  saveChunkRecord,
  writeChunkFile,
} = require('../lib/importChunks');
const { buildItemKey, getJobRecord } = require('../lib/importJobs');
const { getFileByPath, readMarkdownFile } = require('../lib/files');

getDb();
fs.mkdirSync(notesDir, { recursive: true });

// 与服务端分片端点等价的写入流程：落盘分片 + 记分片账本 + 齐片后拼接导入。
function submitChunk({ jobId, parentPath, name, chunkIndex, totalChunks, content }) {
  const itemKey = buildItemKey(parentPath, name);
  const written = writeChunkFile({ jobId, itemKey, chunkIndex, content });
  saveChunkRecord({ jobId, itemKey, chunkIndex, totalChunks, bytes: written.bytes, digest: written.digest });
  return { written, assembled: assembleChunks(jobId, itemKey) };
}

async function run() {
  const { planFileChunks } = await import('../utils/importQueue.js');

  const jobId = 'imp_chunk_test_job';
  const name = '大文件.md';
  const itemKey = buildItemKey('', name);
  const body = '中文内容 😀 emoji\n'.repeat(4000);

  // 1. 顺序分片：必须走客户端真实切分函数，未齐片时不得写入工作区。
  const planned = planFileChunks(body, { chunkBytes: 2000 });
  const chunks = planned.map((chunk) => chunk.content);
  assert.ok(chunks.length > 1, '测试内容必须被切成多片');
  // 切分必须无损：拼接后与原文逐字一致（代理对不能被切断）。
  assert.strictEqual(
    Buffer.concat(chunks.map((part) => Buffer.from(part, 'utf8'))).toString('utf8'),
    body,
    '客户端切分必须无损'
  );
  for (let index = 0; index < chunks.length - 1; index += 1) {
    const { assembled } = submitChunk({ jobId, parentPath: '', name, chunkIndex: index, totalChunks: chunks.length, content: chunks[index] });
    assert.strictEqual(assembled.complete, false, `第 ${index + 1} 片后不应齐片`);
  }
  assert.ok(!getFileByPath(name), '未齐片前不得写入工作区');

  // 2. 齐片拼接：内容与原文完全一致（含中文与代理对）。
  const last = submitChunk({
    jobId, parentPath: '', name, chunkIndex: chunks.length - 1, totalChunks: chunks.length, content: chunks[chunks.length - 1],
  });
  assert.strictEqual(last.assembled.complete, true, '齐片后应可拼接');
  assert.strictEqual(last.assembled.content, body, '拼接结果必须与原文逐字一致');

  // 3. 齐片后走统一导入链路并写入工作区。
  const imported = await importSingleFile({ parentPath: '', conflictPolicy: 'skip', displayName: name, content: last.assembled.content, jobId });
  assert.strictEqual(imported.status, 'imported');
  // 导入沿用既有口径：以文件名生成一级标题，正文原文必须完整保留。
  const stored = readMarkdownFile(name);
  assert.ok(stored.includes(body.trim()), '落盘正文必须完整包含分片拼接出的原文');
  assert.ok(!stored.includes('\uFFFD'), '落盘内容不得出现替换字符（代理对被切断的证据）');
  assert.strictEqual(getJobRecord(jobId, itemKey).status, 'imported', '分片文件同样写入作业账本');

  // 4. 幂等回放：同一 job 重放该文件时不重复写盘。
  const beforeReplay = readMarkdownFile(name);
  const replay = await importSingleFile({ parentPath: '', conflictPolicy: 'skip', displayName: name, content: '被篡改的内容', jobId });
  assert.strictEqual(replay.replay, true, '同一 job 的已完成文件必须回放');
  assert.strictEqual(replay.status, 'imported', '回放不得因 skip 策略改判');
  assert.strictEqual(readMarkdownFile(name), beforeReplay, '回放不得重复写盘');

  // 5. 重复片幂等：同一片重复提交按摘要复用，磁盘内容不变。
  const dupJob = 'imp_chunk_dup_job';
  const dupItem = buildItemKey('', '重复.md');
  const first = writeChunkFile({ jobId: dupJob, itemKey: dupItem, chunkIndex: 0, content: '第一版分片' });
  assert.strictEqual(first.reused, false, '首次写入不应标记复用');
  const again = writeChunkFile({ jobId: dupJob, itemKey: dupItem, chunkIndex: 0, content: '第一版分片' });
  assert.strictEqual(again.reused, true, '相同内容重复提交应复用既有分片');
  assert.strictEqual(again.digest, first.digest, '复用分片的摘要必须一致');
  const changed = writeChunkFile({ jobId: dupJob, itemKey: dupItem, chunkIndex: 0, content: '改过的分片' });
  assert.strictEqual(changed.reused, false, '内容变化时应以最后一次为准');
  assert.notStrictEqual(changed.digest, first.digest);

  // 6. 乱序到达：缺片时报告缺失索引，补齐后仍能正确拼接。
  const orderJob = 'imp_chunk_order_job';
  const orderName = '乱序.md';
  const orderItem = buildItemKey('', orderName);
  const parts = ['AAA', 'BBB', 'CCC'];
  writeChunkFile({ jobId: orderJob, itemKey: orderItem, chunkIndex: 2, content: parts[2] });
  saveChunkRecord({ jobId: orderJob, itemKey: orderItem, chunkIndex: 2, totalChunks: 3, bytes: 3, digest: 'x' });
  writeChunkFile({ jobId: orderJob, itemKey: orderItem, chunkIndex: 0, content: parts[0] });
  saveChunkRecord({ jobId: orderJob, itemKey: orderItem, chunkIndex: 0, totalChunks: 3, bytes: 3, digest: 'x' });
  const partial = assembleChunks(orderJob, orderItem);
  assert.strictEqual(partial.complete, false, '缺片时不得判定齐片');
  assert.deepStrictEqual(partial.missing, [1], '必须报告缺失的分片索引');
  writeChunkFile({ jobId: orderJob, itemKey: orderItem, chunkIndex: 1, content: parts[1] });
  saveChunkRecord({ jobId: orderJob, itemKey: orderItem, chunkIndex: 1, totalChunks: 3, bytes: 3, digest: 'x' });
  assert.strictEqual(assembleChunks(orderJob, orderItem).content, 'AAABBBCCC', '乱序补齐后必须按索引顺序拼接');

  // 7. 暂存清理：完成或显式清理后，磁盘目录与分片记录都不再残留。
  const stagingDir = buildStagingPath(orderJob, orderItem);
  assert.ok(fs.existsSync(stagingDir), '暂存目录应存在于 dataRoot 内');
  removeStagingItem(orderJob, orderItem);
  assert.ok(!fs.existsSync(stagingDir), '清理后暂存目录必须删除');
  assert.strictEqual(listChunkRecords(orderJob, orderItem).length, 0, '清理后分片记录必须删除');

  // 8. 暂存位置不得落在工作区或备份范围内。
  assert.ok(stagingDir.startsWith(root), '暂存目录必须位于 dataRoot 内');
  assert.ok(!stagingDir.startsWith(notesDir), '暂存目录不得写入工作区');
  assert.ok(!stagingDir.includes(`${path.sep}session${path.sep}`), '暂存目录不得落在会被备份打包的 session 目录');

  // 9. 分片失败隔离：单个分片文件的失败不影响其它文件。
  const isoJob = 'imp_chunk_iso_job';
  const ok = await importSingleFile({ parentPath: '', conflictPolicy: 'skip', displayName: '正常分片.md', content: '正常内容', jobId: isoJob });
  assert.strictEqual(ok.status, 'imported');
  await assert.rejects(
    () => importSingleFile({ parentPath: '', conflictPolicy: 'skip', displayName: '../越界.md', content: 'x', jobId: isoJob }),
    (error) => error.code === 'IMPORT_FILE_PATH_INVALID',
    '非法路径的分片文件必须单独失败'
  );
  const after = await importSingleFile({ parentPath: '', conflictPolicy: 'skip', displayName: '后续分片.md', content: '后续内容', jobId: isoJob });
  assert.strictEqual(after.status, 'imported', '失败文件不得中断后续文件');

  // 9.1 分片通道的单文件上限必须显著高于普通批上传，否则分片本身没有意义。
  assert.ok(MAX_CHUNKED_FILE_BYTES > MAX_FILE_BYTES, '分片通道上限必须高于普通批上传上限');
  const overBatch = 'x'.repeat(MAX_FILE_BYTES + 1);
  await assert.rejects(
    () => importSingleFile({ parentPath: '', conflictPolicy: 'skip', displayName: '超批上限.md', content: overBatch, jobId: 'imp_chunk_limit_job' }),
    (error) => error.code === 'IMPORT_FILE_TOO_LARGE',
    '普通批通道必须拒绝超过 8MB 的文件'
  );
  const viaChunks = await importSingleFile({
    parentPath: '',
    conflictPolicy: 'skip',
    displayName: '超批上限.md',
    content: overBatch,
    jobId: 'imp_chunk_limit_job',
    maxBytes: MAX_CHUNKED_FILE_BYTES,
  });
  assert.strictEqual(viaChunks.status, 'imported', '分片通道必须接受超过 8MB 的文件');
  assert.ok(readMarkdownFile('超批上限.md').includes('xxxx'), '放宽上限后内容必须正常落盘');
  await assert.rejects(
    () => importSingleFile({
      parentPath: '',
      conflictPolicy: 'skip',
      displayName: '超过分片上限.md',
      content: 'xy',
      jobId: 'imp_chunk_limit_job2',
      maxBytes: 1,
    }),
    (error) => error.code === 'IMPORT_FILE_TOO_LARGE',
    '分片通道仍有自己的上限'
  );

  // 10. 片数上限是受控常量，避免无限分片。
  assert.ok(Number.isInteger(MAX_TOTAL_CHUNKS) && MAX_TOTAL_CHUNKS > 0 && MAX_TOTAL_CHUNKS <= 4096);

  console.log('import chunked upload tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
