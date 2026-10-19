// 分批导入的客户端规划层：把“读取全部文件 → 一次 POST”改成“按体积和数量切批 → 顺序提交”。
// 与 notus/lib/fileImport.js 的服务端预算保持同一量级，保证单个请求不会撞上 body 上限。
export const IMPORT_MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const IMPORT_MAX_BATCH_FILES = 200;
export const IMPORT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const IMPORT_MAX_REQUEST_ATTEMPTS = 3;
// 超过单次请求安全体积的文件改为分片上传：2MiB 一片，单片远低于服务端 12mb body 上限。
export const IMPORT_CHUNK_BYTES = 2 * 1024 * 1024;
export const IMPORT_CHUNK_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const IMPORT_CHUNK_MAX_TOTAL = 512;
// 与服务端 MAX_CHUNKED_FILE_BYTES 保持一致：分片通道的内容在服务端拼接，
// 不经过单次请求体，因此上限远高于普通批上传。
export const IMPORT_MAX_CHUNKED_FILE_BYTES = 256 * 1024 * 1024;

const JOB_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function createImportJobId() {
  const cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (cryptoObject?.randomUUID) return `imp_${cryptoObject.randomUUID().replace(/-/g, '')}`;
  let random = '';
  for (let index = 0; index < 24; index += 1) {
    random += JOB_ID_ALPHABET[Math.floor(Math.random() * JOB_ID_ALPHABET.length)];
  }
  return `imp_${Date.now().toString(36)}${random}`;
}

// 按 UTF-8 字节数估算体积：与 Buffer.byteLength(content, 'utf8') 的排序一致，
// 用于在读取文件前就决定它应该落在哪一批。
export function estimateUtf8Bytes(value) {
  const text = String(value == null ? '' : value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

// 单文件超上限时不丢弃：单独成批，由服务端给出该文件自己的失败原因。
export function planImportBatches(entries = [], options = {}) {
  const maxBatchBytes = Number(options.maxBatchBytes) > 0 ? Number(options.maxBatchBytes) : IMPORT_MAX_BATCH_BYTES;
  const maxBatchFiles = Number(options.maxBatchFiles) > 0 ? Number(options.maxBatchFiles) : IMPORT_MAX_BATCH_FILES;
  const batches = [];
  let current = { entries: [], bytes: 0 };

  const flush = () => {
    if (current.entries.length === 0) return;
    batches.push(current);
    current = { entries: [], bytes: 0 };
  };

  entries.forEach((entry) => {
    const size = Math.max(0, Number(entry?.size) || 0);
    if (current.entries.length > 0 && (current.bytes + size > maxBatchBytes || current.entries.length >= maxBatchFiles)) {
      flush();
    }
    current.entries.push(entry);
    current.bytes += size;
  });
  flush();
  return batches;
}

// 把单个超限文件切成有序分片。切点必须避开代理对：把 emoji 等高码位字符拆到两片，
// 单独的高代理码元经 Buffer 编码会变成 U+FFFD，拼接后无法还原原文。
export function planFileChunks(content, options = {}) {
  const text = String(content == null ? '' : content);
  const chunkBytes = Number(options.chunkBytes) > 0 ? Number(options.chunkBytes) : IMPORT_CHUNK_BYTES;
  const maxTotal = Number(options.maxTotal) > 0 ? Number(options.maxTotal) : IMPORT_CHUNK_MAX_TOTAL;

  if (text.length === 0) return [{ index: 0, total: 1, content: '' }];

  // 先按估算体积算出每片对应的字符数，再按该字符数切分，避免逐字符重复扫描。
  const totalBytes = estimateUtf8Bytes(text);
  const averageBytesPerChar = totalBytes / text.length;
  const charsPerChunk = Math.max(1, Math.floor(chunkBytes / Math.max(averageBytesPerChar, 1)));

  const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
  const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + charsPerChunk, text.length);
    // 切点落在代理对中间时向前挪一位，把整个字符留给下一片。
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      end -= 1;
    }
    // 极端情况下 charsPerChunk 为 1 且正好指向高代理：向后扩一位，保证单片至少含完整字符。
    if (end <= offset) end = Math.min(offset + 2, text.length);
    parts.push(text.slice(offset, end));
    offset = end;
  }

  if (parts.length > maxTotal) {
    throw Object.assign(
      new Error(`文件过大，需要 ${parts.length} 个分片，超过 ${maxTotal} 片上限，请先拆分文件后再导入`),
      { code: 'IMPORT_CHUNK_TOO_MANY' }
    );
  }

  const total = parts.length;
  return parts.map((content, index) => ({ index, total, content }));
}

// 判断单个文件应走普通批上传还是分片上传。
export function shouldUseChunkedUpload(size) {
  return Number(size) > IMPORT_CHUNK_THRESHOLD_BYTES;
}

// 单个文件的整体状态：跨批次、跨重试都归一到同一组结果，供结果弹窗与“重试失败项”使用。
export function mergeImportResults(previous = [], incoming = []) {
  const order = [];
  const byKey = new Map();
  const keyOf = (item) => String(item?.path || item?.name || '');
  const put = (item) => {
    const key = keyOf(item);
    if (!key) return;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, item);
  };

  previous.forEach(put);
  incoming.forEach((item) => {
    const key = keyOf(item);
    const prior = byKey.get(key);
    // 失败项在重试成功后被覆盖；否则保留首次失败原因，避免进度事件把它抹掉。
    if (prior && prior.status === 'failed' && item.status === 'failed') {
      byKey.set(key, { ...item, error: item.error || prior.error });
      return;
    }
    put(item);
  });

  return order.map((key) => byKey.get(key));
}

export function summarizeImportResults(results = []) {
  const summary = { imported: 0, overwritten: 0, skipped: 0, failed: 0, warnings: 0, total: results.length };
  results.forEach((item) => {
    const status = String(item?.status || '');
    if (status === 'imported') summary.imported += 1;
    else if (status === 'overwritten') summary.overwritten += 1;
    else if (status === 'skipped') summary.skipped += 1;
    else if (status === 'failed') summary.failed += 1;
    if (item?.warning) summary.warnings += 1;
  });
  return summary;
}

export function describeImportBatchError(error, batchIndex, batchCount) {
  const message = error?.message || '导入失败';
  const prefix = batchCount > 1 ? `第 ${batchIndex + 1}/${batchCount} 批导入失败：` : '导入失败：';
  const cause = error?.cause?.message ? `（${error.cause.message}）` : '';
  return `${prefix}${message}${cause}`;
}

// 413 / 连接中断 / 5xx 属于“这一批没被完整处理”，允许原样重发；
// 4xx 参数错误重试无意义，直接交给调用方提示。
export function isRetryableImportError(status) {
  if (status === 413 || status === 429) return true;
  if (!Number.isFinite(status) || status === 0) return true;
  return status >= 500;
}

export function shouldRetryImportBatch({ status, attempt }) {
  if (attempt >= IMPORT_MAX_REQUEST_ATTEMPTS) return false;
  return isRetryableImportError(status);
}

// 顺序提交所有批次：单批失败（含重试耗尽）只影响该批尚未成功的文件，
// 后续批次继续执行；暂停事件（服务端预算不足）在同一批内继续续传。
export async function runImportBatches({
  batches = [],
  submitBatch,
  onBatchRetry = null,
  maxAttempts = IMPORT_MAX_REQUEST_ATTEMPTS,
} = {}) {
  const batchErrors = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const queue = [batch.entries];
    while (queue.length > 0) {
      let pending = queue.shift();
      let attempt = 0;
      let settled = false;

      while (!settled && pending.length > 0) {
        attempt += 1;
        try {
          const outcome = await submitBatch({
            files: pending,
            batchIndex,
            batchCount: batches.length,
            attempt,
          });
          const advanced = Number(outcome?.processed) || 0;
          if (outcome?.paused && advanced > 0 && advanced < pending.length) {
            pending = pending.slice(advanced);
            attempt = 0;
            continue;
          }
          if (outcome?.paused && advanced <= 0) {
            // 服务端报告还有剩余但没有任何进展：继续重发只会空转，直接按失败收口。
            batchErrors.push(`${pending[0]?.name || '文件'}：服务端未能继续处理剩余文件，请稍后重试`);
            queue.length = 0;
            break;
          }
          settled = true;
        } catch (error) {
          const status = Number(error?.status) || 0;
          // 413 表示这一批体积超限：对半拆开后立即重试前半批，后半批排回队列。
          if (status === 413 && pending.length > 1) {
            const half = Math.ceil(pending.length / 2);
            queue.unshift(pending.slice(half));
            pending = pending.slice(0, half);
            attempt = 0;
            onBatchRetry?.({ batchIndex, attempt, error, split: true });
            continue;
          }
          // 单个文件就撞上请求体积上限时，拆批或重试都无法解决，直接给出可读结论。
          if (status === 413) {
            batchErrors.push(`${pending[0]?.name || '文件'}：单个文件超过单次上传上限，请先拆分该文件后再导入`);
            queue.length = 0;
            break;
          }
          if (shouldRetryImportBatch({ status, attempt })) {
            onBatchRetry?.({ batchIndex, attempt, error, split: false });
            continue;
          }
          const message = describeImportBatchError(error, batchIndex, batches.length);
          batchErrors.push(message);
          queue.length = 0;
          break;
        }
      }
    }
  }

  return { batchErrors };
}

// 分片上传单个超限文件：按片顺序提交，单片失败按同一重试策略重发。
// 服务端按 (job_id, item_key, chunk_index) 记账，因此重发同一片不会重复落盘；
// 齐片后才写入文件，仍复用同一作业账本，与分批导入的幂等语义一致。
export async function uploadChunkedFile({
  name,
  content,
  jobId,
  submitChunk,
  onProgress = null,
  maxAttempts = IMPORT_MAX_REQUEST_ATTEMPTS,
  chunkBytes = IMPORT_CHUNK_BYTES,
  maxBytes = IMPORT_MAX_CHUNKED_FILE_BYTES,
} = {}) {
  const totalBytes = estimateUtf8Bytes(content);
  // 提前按服务端同口径拒绝，避免传完全部分片才在齐片阶段失败。
  if (totalBytes > maxBytes) {
    throw Object.assign(
      new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，请先拆分后再导入`),
      { code: 'IMPORT_FILE_TOO_LARGE' }
    );
  }

  const chunks = planFileChunks(content, { chunkBytes });
  for (const chunk of chunks) {
    let attempt = 0;
    let settled = false;
    while (!settled) {
      attempt += 1;
      try {
        const outcome = await submitChunk({
          name,
          chunkIndex: chunk.index,
          totalChunks: chunk.total,
          content: chunk.content,
          attempt,
        });
        settled = true;
        onProgress?.({
          received: Number(outcome?.received) || chunk.index + 1,
          totalChunks: chunk.total,
          complete: Boolean(outcome?.complete),
        });
      } catch (error) {
        const status = Number(error?.status) || 0;
        if (shouldRetryImportBatch({ status, attempt })) {
          onProgress?.({ received: chunk.index, totalChunks: chunk.total, retrying: true });
          continue;
        }
        throw error;
      }
    }
  }
  return { chunks: chunks.length };
}
