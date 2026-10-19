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
  const normalized = String(providerValue || '').trim();
  if (!normalized) return '自定义兼容接口';
  return LLM_PROVIDERS.find((provider) => provider.value === normalized)?.label || normalized;
}

// 设置页 LLM 配置按 Provider 归组展示的分组规则：
// 同一 (provider, base_url, api_protocol) 的配置行视为一个 Provider 组，
// 组内共享同一 API Key；组按添加时间降序排列，组内模型按名称排序。
export function groupLlmConfigs(configs) {
  const groups = new Map();
  (Array.isArray(configs) ? configs : []).forEach((item) => {
    const key = [
      String(item?.provider || '').trim(),
      String(item?.base_url || '').trim().replace(/\/+$/, '').toLowerCase(),
      String(item?.api_protocol || 'openai').trim().toLowerCase(),
    ].join('\u0000');
    if (!groups.has(key)) {
      groups.set(key, { key, provider: item.provider, base_url: item.base_url, api_protocol: item.api_protocol, items: [] });
    }
    groups.get(key).items.push(item);
  });
  const list = Array.from(groups.values());
  list.forEach((group) => {
    group.items.sort((a, b) => String(a.model || '').localeCompare(String(b.model || '')));
    group.hasActive = group.items.some((item) => item.is_active);
    // Provider 添加时间 = 组内最早的配置创建时间
    group.addedAt = Math.min(...group.items.map((item) => Date.parse(item.created_at) || 0));
  });
  list.sort((a, b) => b.addedAt - a.addedAt);
  return list;
}
