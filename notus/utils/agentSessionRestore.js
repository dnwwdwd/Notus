function shouldClearAgentPresentation({ restoredSession = null, activeSession = null, activeSteps = [], streamText = '' } = {}) {
  if (restoredSession) return false;
  if (activeSession?.id) return false;
  if (Array.isArray(activeSteps) && activeSteps.length > 0) return false;
  if (String(streamText || '').trim()) return false;
  return true;
}

module.exports = { shouldClearAgentPresentation };
