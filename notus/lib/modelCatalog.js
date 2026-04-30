export const EMBEDDING_PROVIDERS = [
  {
    value: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { value: 'text-embedding-3-large', label: 'text-embedding-3-large (3072d)', dimension: '3072', multimodal: false },
      { value: 'text-embedding-3-small', label: 'text-embedding-3-small (1536d)', dimension: '1536', multimodal: false },
      { value: 'text-embedding-ada-002', label: 'text-embedding-ada-002 (1536d)', dimension: '1536', multimodal: false },
    ],
  },
  {
    value: 'qwen',
    label: '阿里（通义）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { value: 'text-embedding-v3', label: 'text-embedding-v3 (1024d)', dimension: '1024', multimodal: false },
      { value: 'text-embedding-v2', label: 'text-embedding-v2 (1536d)', dimension: '1536', multimodal: false },
      { value: 'qwen3-vl-embedding', label: 'qwen3-vl-embedding（多模态，1024d）', dimension: '1024', multimodal: true },
      { value: 'qwen2.5-vl-embedding', label: 'qwen2.5-vl-embedding（多模态，1024d）', dimension: '1024', multimodal: true },
      { value: 'tongyi-embedding-vision-plus', label: 'tongyi-embedding-vision-plus（多模态，1152d）', dimension: '1152', multimodal: true },
    ],
  },
  {
    value: 'doubao',
    label: '豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      { value: 'doubao-embedding-large', label: 'doubao-embedding-large (2048d)', dimension: '2048', multimodal: false },
      { value: 'doubao-embedding', label: 'doubao-embedding (1024d)', dimension: '1024', multimodal: false },
      { value: 'doubao-embedding-vision', label: 'doubao-embedding-vision（多模态，2048d）', dimension: '2048', multimodal: true },
    ],
  },
  {
    value: 'zhipu',
    label: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { value: 'embedding-3', label: 'embedding-3 (2048d)', dimension: '2048', multimodal: false },
      { value: 'embedding-2', label: 'embedding-2 (1024d)', dimension: '1024', multimodal: false },
    ],
  },
  {
    value: 'custom',
    label: '自定义',
    baseUrl: '',
    models: [],
  },
];

export const LLM_PROVIDERS = [
  {
    value: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      { value: 'claude-opus-4-1', label: 'claude-opus-4-1' },
      { value: 'claude-sonnet-4', label: 'claude-sonnet-4' },
      { value: 'claude-3-5-haiku-latest', label: 'claude-3-5-haiku-latest' },
    ],
  },
  {
    value: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { value: 'gpt-4o', label: 'gpt-4o' },
      { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
      { value: 'o3', label: 'o3' },
    ],
  },
  {
    value: 'google',
    label: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
      { value: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
    ],
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { value: 'deepseek-chat', label: 'deepseek-chat' },
      { value: 'deepseek-reasoner', label: 'deepseek-reasoner' },
    ],
  },
  {
    value: 'qwen',
    label: '阿里（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { value: 'qwen3-max', label: 'qwen3-max' },
      { value: 'qwen-max', label: 'qwen-max' },
      { value: 'qwen-plus', label: 'qwen-plus' },
      { value: 'qwq-32b', label: 'qwq-32b' },
    ],
  },
  {
    value: 'custom',
    label: '自定义',
    baseUrl: '',
    models: [],
  },
];

export function findProvider(catalog, value) {
  return catalog.find((provider) => provider.value === value) || catalog[0];
}

export function getEmbeddingModelMeta(providerValue, modelValue) {
  const provider = findProvider(EMBEDDING_PROVIDERS, providerValue);
  return provider.models.find((model) => model.value === modelValue) || null;
}

export function isEmbeddingModelMultimodal(providerValue, modelValue) {
  const meta = getEmbeddingModelMeta(providerValue, modelValue);
  if (meta) return Boolean(meta.multimodal);
  return /(?:vision|vl|multimodal|omni)/i.test(String(modelValue || ''));
}

export function getProviderOptions(catalog) {
  return catalog.map((provider) => ({
    value: provider.value,
    label: provider.label,
  }));
}
