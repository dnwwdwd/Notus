import { LLM_PROVIDERS } from './modelCatalog';

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function inferLlmProvider({ baseUrl, model }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedModel = String(model || '').trim().toLowerCase();

  if (normalizedBaseUrl.includes('anthropic.com')) return 'anthropic';
  if (normalizedBaseUrl.includes('api.openai.com')) return 'openai';
  if (normalizedBaseUrl.includes('generativelanguage.googleapis.com')) return 'google';
  if (normalizedBaseUrl.includes('api.deepseek.com')) return 'deepseek';
  if (normalizedBaseUrl.includes('aliyuncs.com') || normalizedBaseUrl.includes('dashscope')) return 'qwen';

  if (normalizedModel.startsWith('claude-')) return 'anthropic';
  if (/^(gpt|o[134]|chatgpt)/.test(normalizedModel)) return 'openai';
  if (normalizedModel.startsWith('gemini-')) return 'google';
  if (normalizedModel.startsWith('deepseek-')) return 'deepseek';
  if (normalizedModel.startsWith('qwen-') || normalizedModel.startsWith('qwq-')) return 'qwen';

  return 'custom';
}

export function resolveLlmProviderLabel(providerValue) {
  return LLM_PROVIDERS.find((provider) => provider.value === providerValue)?.label || '自定义兼容接口';
}
