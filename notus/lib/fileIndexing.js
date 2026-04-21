const { ensureError } = require('./errors');
const { indexFile, markFileIndexFailed } = require('./indexer');

async function indexFileWithFallback(filePath, logger, context = {}) {
  try {
    const result = await indexFile(filePath);
    if (result.embeddingFailed) {
      logger?.warn('file.index.warning', {
        ...context,
        file_path: filePath,
        error: {
          message: result.error || '索引降级',
          code: 'INDEX_EMBEDDING_FAILED',
        },
      });
      return {
        indexed: 0,
        warning: result.error || '索引失败',
        warning_code: 'INDEX_EMBEDDING_FAILED',
        result,
      };
    }

    logger?.info('file.index.success', {
      ...context,
      file_path: filePath,
      chunks_count: result.chunksCount || 0,
    });
    return {
      indexed: 1,
      warning: null,
      warning_code: null,
      result,
    };
  } catch (error) {
    const normalized = ensureError(error, 'INDEX_FAILED', '索引失败');
    markFileIndexFailed(filePath, normalized);
    logger?.error('file.index.failed', {
      ...context,
      file_path: filePath,
      error: normalized,
    });
    return {
      indexed: 0,
      warning: normalized.message,
      warning_code: normalized.code || 'INDEX_FAILED',
      result: null,
    };
  }
}

module.exports = {
  indexFileWithFallback,
};
