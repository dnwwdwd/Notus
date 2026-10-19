const assert = require('assert');

async function run() {
  const {
    IMPORT_CHUNK_THRESHOLD_BYTES,
    IMPORT_MAX_BATCH_FILES,
    createImportJobId,
    estimateUtf8Bytes,
    mergeImportResults,
    planFileChunks,
    planImportBatches,
    runImportBatches,
    shouldUseChunkedUpload,
    summarizeImportResults,
    uploadChunkedFile,
  } = await import('../utils/importQueue.js');

  // 1. UTF-8 字节估算与 Buffer.byteLength 一致（决定分批边界，不能少算）。
  const samples = ['hello', '中文标题', 'emoji 😀 混排', '', 'a'.repeat(5000)];
  samples.forEach((sample) => {
    assert.strictEqual(estimateUtf8Bytes(sample), Buffer.byteLength(sample, 'utf8'), `字节估算应与 Buffer 一致：${sample.slice(0, 12)}`);
  });

  // 2. 按体积切批：4MiB 一批，不允许出现超限单批。
  const big = { name: 'big.md', size: 3 * 1024 * 1024 };
  const batches = planImportBatches(
    [big, big, { name: 'small.md', size: 1024 }, { name: 'tiny.md', size: 1024 }],
    { maxBatchBytes: 4 * 1024 * 1024, maxBatchFiles: IMPORT_MAX_BATCH_FILES }
  );
  assert.strictEqual(batches.length, 2, '两个大文件各自成批，两个小文件并入第二批');
  assert.ok(batches.every((batch) => batch.bytes <= 4 * 1024 * 1024), '单批体积不得超过预算');

  // 3. 按数量切批，且单文件超预算时单独成批交由服务端给出原因。
  const many = Array.from({ length: 5 }, (unused, index) => ({ name: `${index}.md`, size: 1 }));
  assert.strictEqual(planImportBatches(many, { maxBatchFiles: 2 }).length, 3);
  const oversized = planImportBatches([{ name: 'huge.md', size: 99 * 1024 * 1024 }], { maxBatchBytes: 4 * 1024 * 1024 });
  assert.strictEqual(oversized.length, 1, '超限单文件不得被静默丢弃');

  // 4. 结果合并：重试成功后覆盖失败态，未处理项保留首次失败原因。
  const merged = mergeImportResults(
    [
      { name: 'a.md', status: 'imported' },
      { name: 'b.md', status: 'failed', error: '第一次失败' },
      { name: 'c.md', status: 'skipped' },
    ],
    [
      { name: 'b.md', status: 'imported' },
      { name: 'd.md', status: 'failed', error: '新的失败' },
    ]
  );
  assert.deepStrictEqual(merged.map((item) => `${item.name}:${item.status}`), [
    'a.md:imported',
    'b.md:imported',
    'c.md:skipped',
    'd.md:failed',
  ]);
  const stillFailed = mergeImportResults([{ name: 'b.md', status: 'failed', error: '原始原因' }], [{ name: 'b.md', status: 'failed' }]);
  assert.strictEqual(stillFailed[0].error, '原始原因', '重复失败时保留首次可读原因');

  const summary = summarizeImportResults(merged);
  assert.deepStrictEqual(summary, { imported: 2, overwritten: 0, skipped: 1, failed: 1, warnings: 0, total: 4 });

  // 5. 批次执行：中间批次网络失败自动重试，已成功批次不重发。
  const attempts = [];
  let call = 0;
  const retried = await runImportBatches({
    batches: planImportBatches([{ name: 'a.md', size: 1 }, { name: 'b.md', size: 1 }], { maxBatchFiles: 1 }),
    submitBatch: async ({ batchIndex, attempt }) => {
      attempts.push(`${batchIndex}:${attempt}`);
      call += 1;
      if (call === 2) {
        const error = new Error('连接中断');
        error.status = 0;
        throw error;
      }
      return { paused: false, processed: 1 };
    },
  });
  assert.deepStrictEqual(retried.batchErrors, [], '可重试错误在重试成功后不应留下错误');
  assert.deepStrictEqual(attempts, ['0:1', '1:1', '1:2'], '只重试失败的那一批');

  // 6. 重试耗尽：单批失败记录错误，后续批次继续执行。
  const order = [];
  const exhausted = await runImportBatches({
    batches: planImportBatches([{ name: 'a.md', size: 1 }, { name: 'b.md', size: 1 }, { name: 'c.md', size: 1 }], { maxBatchFiles: 1 }),
    submitBatch: async ({ batchIndex }) => {
      order.push(batchIndex);
      if (batchIndex === 1) {
        const error = new Error('服务器错误');
        error.status = 500;
        throw error;
      }
      return { paused: false, processed: 1 };
    },
  });
  assert.strictEqual(exhausted.batchErrors.length, 1, '失败批次要给出可读错误');
  assert.ok(exhausted.batchErrors[0].includes('第 2/3 批'), '错误需标明失败批次');
  assert.deepStrictEqual(order, [0, 1, 1, 1, 2], '失败批次重试耗尽后，后续批次继续执行');

  // 7. 413：拆批后立即重试前半批，后半批随后处理。
  const sizes = [];
  const split = await runImportBatches({
    batches: [{ entries: [{ name: 'a.md' }, { name: 'b.md' }, { name: 'c.md' }, { name: 'd.md' }], bytes: 10 }],
    submitBatch: async ({ files }) => {
      sizes.push(files.map((entry) => entry.name).join(','));
      if (files.length > 2) {
        const error = new Error('请求体过大');
        error.status = 413;
        throw error;
      }
      return { paused: false, processed: files.length };
    },
  });
  assert.deepStrictEqual(split.batchErrors, [], '413 拆批后应全部成功');
  assert.deepStrictEqual(sizes, ['a.md,b.md,c.md,d.md', 'a.md,b.md', 'c.md,d.md'], '413 后按对半拆分继续');

  // 8. 服务端预算暂停：同一批内按 processed 续传，剩余文件不丢。
  const pausedCalls = [];
  const paused = await runImportBatches({
    batches: [{ entries: [{ name: 'a.md' }, { name: 'b.md' }, { name: 'c.md' }], bytes: 3 }],
    submitBatch: async ({ files }) => {
      pausedCalls.push(files.map((entry) => entry.name).join(','));
      if (files.length > 1) return { paused: true, processed: 1 };
      return { paused: false, processed: 1 };
    },
  });
  assert.deepStrictEqual(paused.batchErrors, []);
  assert.deepStrictEqual(pausedCalls, ['a.md,b.md,c.md', 'b.md,c.md', 'c.md'], '暂停后从剩余文件继续');

  // 9. 单个文件撞上 413：直接给出可读结论，不做无意义重试。
  const single = await runImportBatches({
    batches: [{ entries: [{ name: 'huge.md' }], bytes: 1 }],
    submitBatch: async () => {
      const error = new Error('请求体过大');
      error.status = 413;
      throw error;
    },
  });
  assert.strictEqual(single.batchErrors.length, 1);
  assert.ok(single.batchErrors[0].includes('huge.md'), '单文件超限要指出具体文件');

  // 10. job_id 可被服务端接受。
  const jobId = createImportJobId();
  assert.ok(/^[A-Za-z0-9_-]{8,80}$/.test(jobId), `job_id 必须符合服务端格式：${jobId}`);

  // 11. 分片切分必须无损：切点不得落在代理对中间，否则 emoji 会变成 U+FFFD。
  const chunkTexts = [
    ['emoji 密集', '😀'.repeat(50)],
    ['中英混排', '中文abc😀def中文\n'.repeat(30)],
    ['纯中文', '中文内容测试\n'.repeat(40)],
    ['纯 emoji 两字符', '😀😀'],
    ['单 emoji', '😀'],
    ['空内容', ''],
  ];
  chunkTexts.forEach(([label, text]) => {
    [4, 7, 16, 64, 1024].forEach((chunkBytes) => {
      const planned = planFileChunks(text, { chunkBytes });
      const rejoined = Buffer.concat(planned.map((chunk) => Buffer.from(chunk.content, 'utf8'))).toString('utf8');
      assert.strictEqual(rejoined, text, `${label} 在 ${chunkBytes} 字节分片下拼接必须无损`);
      planned.forEach((chunk, index) => {
        const lastCode = chunk.content.charCodeAt(chunk.content.length - 1);
        const firstCode = chunk.content.charCodeAt(0);
        assert.ok(
          !(lastCode >= 0xd800 && lastCode <= 0xdbff),
          `${label}/${chunkBytes} 第 ${index} 片不得以孤立高代理结尾`
        );
        assert.ok(
          !(firstCode >= 0xdc00 && firstCode <= 0xdfff),
          `${label}/${chunkBytes} 第 ${index} 片不得以孤立低代理开头`
        );
      });
    });
  });
  const singleEmpty = planFileChunks('', { chunkBytes: 1024 });
  assert.deepStrictEqual(singleEmpty, [{ index: 0, total: 1, content: '' }], '空内容也要产出一片占位');
  assert.throws(
    () => planFileChunks('x'.repeat(1000), { chunkBytes: 1, maxTotal: 5 }),
    (error) => error.code === 'IMPORT_CHUNK_TOO_MANY',
    '超出片数上限必须抛出受控错误'
  );

  // 12. 分片阈值判定。
  assert.strictEqual(shouldUseChunkedUpload(IMPORT_CHUNK_THRESHOLD_BYTES + 1), true, '超过阈值应走分片通道');
  assert.strictEqual(shouldUseChunkedUpload(IMPORT_CHUNK_THRESHOLD_BYTES), false, '等于阈值仍走普通批上传');
  assert.strictEqual(shouldUseChunkedUpload(1024), false);

  // 13. 分片上传器：逐片提交并汇报进度，单片失败按策略重发。
  const submitted = [];
  const uploaded = await uploadChunkedFile({
    name: '大文件.md',
    content: '😀'.repeat(300),
    jobId: 'imp_test_chunk_job',
    chunkBytes: 64,
    submitChunk: async ({ chunkIndex, totalChunks }) => {
      submitted.push(chunkIndex);
      return { received: chunkIndex + 1, totalChunks, complete: chunkIndex + 1 === totalChunks };
    },
  });
  assert.ok(uploaded.chunks > 1, '大内容应切成多片提交');
  assert.deepStrictEqual(submitted, [...submitted].sort((a, b) => a - b), '分片必须按索引顺序提交');

  // 13.1 超出分片通道上限时，必须在提交任何分片前就失败。
  let chunkSubmitted = false;
  await assert.rejects(
    () => uploadChunkedFile({
      name: '超大.md',
      content: 'x'.repeat(2048),
      jobId: 'imp_test_chunk_over',
      chunkBytes: 64,
      maxBytes: 100,
      submitChunk: async () => { chunkSubmitted = true; return { complete: true }; },
    }),
    (error) => error.code === 'IMPORT_FILE_TOO_LARGE',
    '超过分片上限必须在提交前拒绝'
  );
  assert.strictEqual(chunkSubmitted, false, '拒绝时不得提交任何分片');

  let retryCount = 0;
  await uploadChunkedFile({
    name: '重试.md',
    content: '😀'.repeat(120),
    jobId: 'imp_test_chunk_retry',
    chunkBytes: 64,
    submitChunk: async ({ chunkIndex, totalChunks }) => {
      if (chunkIndex === 0 && retryCount < 2) {
        retryCount += 1;
        const error = new Error('连接中断');
        error.status = 0;
        throw error;
      }
      return { received: chunkIndex + 1, totalChunks, complete: chunkIndex + 1 === totalChunks };
    },
  });
  assert.strictEqual(retryCount, 2, '可重试错误应按策略重发同一片');

  await assert.rejects(
    () => uploadChunkedFile({
      name: '不可重试.md',
      content: '内容',
      jobId: 'imp_test_chunk_fatal',
      submitChunk: async () => {
        const error = new Error('参数错误');
        error.status = 400;
        throw error;
      },
    }),
    /参数错误/,
    '4xx 参数错误不应重试，必须直接抛出'
  );

  console.log('import queue planning tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
