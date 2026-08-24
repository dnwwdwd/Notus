const { markStaleWaitingSessions } = require('./agentSession');
const { createLogger } = require('./logger');

let cleanerTimer = null;
const logger = createLogger({ subsystem: 'agent-session-cleaner' });

function startSessionCleaner({ intervalMs = 10 * 60 * 1000, maxAgeMs = 60 * 60 * 1000 } = {}) {
  if (cleanerTimer) return cleanerTimer;
  cleanerTimer = setInterval(() => {
    try {
      const cancelled = markStaleWaitingSessions(maxAgeMs);
      if (cancelled > 0) logger.info('agent.sessions.cleaned', { cancelled });
    } catch (error) {
      logger.error('agent.sessions.clean_failed', { error });
    }
  }, intervalMs);
  if (cleanerTimer.unref) cleanerTimer.unref();
  return cleanerTimer;
}

function stopSessionCleaner() {
  if (!cleanerTimer) return;
  clearInterval(cleanerTimer);
  cleanerTimer = null;
}

module.exports = {
  startSessionCleaner,
  stopSessionCleaner,
};
