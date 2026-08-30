const { createAppError } = require('../../errors');
const { estimateTextTokens } = require('../../llmBudget');
const { buildInteractionsModule } = require('./interactions');
const { buildIntentModule } = require('./intent');
const { buildCompletionModule } = require('./completion');
const { buildOutputModule } = require('./output');
const { buildPolicyModule } = require('./policy');
const { buildResearchModule } = require('./research');
const { buildResourcesModule } = require('./resources');
const { buildWorkspaceModule } = require('./workspace');
const { buildWritingModule } = require('./writing');
const { PROMPT_VERSION } = require('./version');

function renderAgentLoopPrompt(session, options = {}) {
  const candidates = [
    buildIntentModule(session, options), buildCompletionModule(session, options),
    buildPolicyModule(session, options), buildInteractionsModule(session, options),
    buildWorkspaceModule(options), buildWritingModule(options), buildResearchModule(options),
    buildResourcesModule(options), buildOutputModule(session, options),
    ...(Array.isArray(options.extraModules) ? options.extraModules : []),
  ].filter((module) => module.applies !== false && String(module.content || '').trim());
  const ids = new Set();
  candidates.forEach((module) => {
    if (ids.has(module.id)) throw createAppError('PROMPT_RULE_DUPLICATE', `Prompt 规则重复：${module.id}`);
    ids.add(module.id);
    const tokens = estimateTextTokens(module.content);
    if (tokens > Number(module.maxTokens || Infinity)) {
      throw createAppError('PROMPT_MODULE_BUDGET_EXCEEDED', `Prompt 模块超出预算：${module.id}`, { module_id: module.id, tokens });
    }
  });
  candidates.forEach((module) => {
    const conflict = (module.conflicts || []).find((id) => ids.has(id));
    if (conflict) throw createAppError('PROMPT_RULE_CONFLICT', `Prompt 规则冲突：${module.id} / ${conflict}`);
  });
  const dynamicTokens = candidates.filter((module) => module.dynamic).reduce((sum, module) => sum + estimateTextTokens(module.content), 0);
  const contextWindow = Math.max(4_096, Number(options.contextWindowTokens) || 60_000);
  const dynamicBudget = Math.floor(contextWindow * 0.25);
  if (dynamicTokens > dynamicBudget) {
    throw createAppError('PROMPT_DYNAMIC_MATERIAL_EXCEEDED', '动态材料超出 Prompt 配额，请缩小材料范围。', { dynamic_tokens: dynamicTokens, dynamic_budget: dynamicBudget });
  }
  const modules = candidates.sort((a, b) => b.priority - a.priority);
  return {
    text: modules.map((module) => module.content).join('\n\n'),
    version: PROMPT_VERSION,
    moduleIds: modules.map((module) => module.id),
    envelopes: modules.flatMap((module) => module.envelopes || []),
    diagnostics: { dynamic_tokens: dynamicTokens, dynamic_budget: dynamicBudget },
  };
}

module.exports = { renderAgentLoopPrompt };
