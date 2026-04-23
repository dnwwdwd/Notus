const { createLogger } = require('./logger');
const { getIndexCoordinator } = require('./indexCoordinator');

const fallbackLogger = createLogger({ subsystem: 'file-indexing' });

async function queueFileIndexing(filePath, logger = fallbackLogger, context = {}) {
  const result = getIndexCoordinator().enqueuePath(filePath, {
    reason: context.action || 'api',
  });

  logger.info('file.index.queued', {
    ...context,
    file_path: result.path,
    active_generation_id: result.active_generation_id,
  });

  return {
    indexed: 0,
    warning: null,
    warning_code: null,
    result,
    index_state: 'queued',
    active_generation_id: result.active_generation_id,
  };
}

module.exports = {
  queueFileIndexing,
};
