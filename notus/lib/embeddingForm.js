import { EMBEDDING_PROVIDERS } from './modelCatalog';

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function inferEmbeddingProvider({ provider, baseUrl, model }) {
  if (provider) return provider;

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedModel = String(model || '').trim().toLowerCase();

  if (normalizedBaseUrl.includes('aliyuncs.com') || normalizedBaseUrl.includes('dashscope')) return 'qwen';
  if (normalizedBaseUrl.includes('ark.cn-') || normalizedBaseUrl.includes('volces') || normalizedBaseUrl.includes('vikingdb')) return 'doubao';
  if (normalizedBaseUrl.includes('api.openai.com')) return 'openai';
  if (normalizedBaseUrl.includes('bigmodel.cn')) return 'zhipu';

  for (const currentProvider of EMBEDDING_PROVIDERS) {
    if ((currentProvider.models || []).some((item) => item.value.toLowerCase() === normalizedModel)) {
      return currentProvider.value;
    }
  }

  return 'custom';
}

export function findEmbeddingModelMeta({ provider, baseUrl, model }) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) return null;

  const resolvedProvider = inferEmbeddingProvider({ provider, baseUrl, model });
  const providerMeta = EMBEDDING_PROVIDERS.find((item) => item.value === resolvedProvider);
  const directMatch = providerMeta?.models?.find((item) => item.value.toLowerCase() === normalizedModel);
  if (directMatch) return directMatch;

  for (const currentProvider of EMBEDDING_PROVIDERS) {
    const match = (currentProvider.models || []).find((item) => item.value.toLowerCase() === normalizedModel);
    if (match) return match;
  }

  return null;
}
