const { createLogger } = require('./logger');

const MODES = ['legacy', 'shadow', 'search', 'context', 'profile', 'facts', 'enforced'];
const MODE_RANK = Object.fromEntries(MODES.map((mode, index) => [mode, index]));
const DEFAULT_MODE = 'legacy';
let warnedInvalidMode = '';

function normalizeAgentRuntimeMode(value, fallback = DEFAULT_MODE) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MODE_RANK, normalized) ? normalized : fallback;
}

function getAgentRuntimeMode(env = process.env) {
  const raw = String(env.NOTUS_AGENT_RUNTIME_MODE || '').trim();
  if (!raw) return DEFAULT_MODE;
  const normalized = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MODE_RANK, normalized)) return normalized;
  if (warnedInvalidMode !== raw) {
    warnedInvalidMode = raw;
    createLogger({ subsystem: 'agent-runtime-mode' }).warn('agent.runtime_mode.invalid', {
      configured_mode: raw,
      fallback_mode: 'legacy',
    });
  }
  return 'legacy';
}

function agentRuntimeAtLeast(requiredMode, mode = getAgentRuntimeMode()) {
  const requiredRank = MODE_RANK[normalizeAgentRuntimeMode(requiredMode, 'legacy')];
  const currentRank = MODE_RANK[normalizeAgentRuntimeMode(mode, 'legacy')];
  return currentRank >= requiredRank;
}

module.exports = {
  DEFAULT_MODE,
  MODES,
  MODE_RANK,
  agentRuntimeAtLeast,
  getAgentRuntimeMode,
  normalizeAgentRuntimeMode,
};
