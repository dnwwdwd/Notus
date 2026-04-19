const fs = require('fs');
const { getEffectiveConfig } = require('./config');

const QWEN_MULTIMODAL_MODELS = [
  'qwen3-vl-embedding',
  'qwen2.5-vl-embedding',
  'tongyi-embedding-vision',
];

const DOUBAO_MULTIMODAL_MODELS = [
  'doubao-embedding-vision',
];

function normalizeConfig(override = null) {
  return { ...getEffectiveConfig(), ...(override || {}) };
}

function isKnownQwenMultimodalModel(model) {
  const normalized = String(model || '').toLowerCase();
  return QWEN_MULTIMODAL_MODELS.some((item) => normalized.startsWith(item));
}

function isKnownDoubaoMultimodalModel(model) {
  const normalized = String(model || '').toLowerCase();
  return DOUBAO_MULTIMODAL_MODELS.some((item) => normalized.startsWith(item));
}

function looksLikeMultimodalModel(model) {
  const normalized = String(model || '').toLowerCase();
  return /(?:vision|vl|multimodal|omni)/.test(normalized);
}

function isMultimodalModel(provider, model) {
  if (provider === 'qwen' || provider === 'aliyun') return isKnownQwenMultimodalModel(model);
  if (provider === 'doubao') return isKnownDoubaoMultimodalModel(model);
  if (provider === 'custom') return looksLikeMultimodalModel(model);
  return looksLikeMultimodalModel(model);
}

function supportsImageEmbedding(config) {
  return Boolean(config?.embeddingMultimodalEnabled) &&
    isMultimodalModel(config?.embeddingProvider, config?.embeddingModel);
}

function assertEmbeddingConfig(config) {
  if (!config.embeddingApiKey) throw new Error('Embedding API Key 未配置');
  if (!config.embeddingModel) throw new Error('Embedding 模型未配置');
}

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function resolveQwenBaseUrl(baseUrl) {
  const normalized = cleanBaseUrl(baseUrl);
  if (!normalized || normalized.includes('/compatible-mode/')) {
    return 'https://dashscope.aliyuncs.com';
  }
  return normalized;
}

function resolveDoubaoBaseUrl(baseUrl) {
  const normalized = cleanBaseUrl(baseUrl);
  if (!normalized || normalized.includes('ark.cn-')) {
    return 'https://api-vikingdb.volces.com';
  }
  return normalized;
}

function resolveDoubaoEmbeddingUrl(baseUrl) {
  const normalized = resolveDoubaoBaseUrl(baseUrl);
  if (normalized.endsWith('/api/vikingdb/embedding') || normalized.endsWith('/api/data/embedding')) {
    return normalized;
  }
  return `${normalized}/api/vikingdb/embedding`;
}

async function readError(response) {
  const body = await response.text();
  return `Embedding API ${response.status}: ${body}`;
}

function toEmbeddingsArray(payload) {
  const candidates = [
    payload?.data,
    payload?.output?.embeddings,
    payload?.output?.data,
    payload?.embeddings,
    payload?.result?.data,
  ].filter(Array.isArray);

  if (candidates.length === 0) return [];

  const items = candidates[0]
    .slice()
    .sort((left, right) => (left.index || 0) - (right.index || 0));

  return items.map((item) =>
    item.embedding ||
    item.vector ||
    item.dense_embedding ||
    item.float_embedding ||
    item.output
  );
}

function assertEmbeddings(embeddings, config) {
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    throw new Error('Embedding API 响应格式不正确');
  }

  embeddings.forEach((embedding) => {
    if (!Array.isArray(embedding)) throw new Error('Embedding 结果不是数组');
    if (config.embeddingDim && embedding.length !== Number(config.embeddingDim)) {
      throw new Error(`Embedding 维度不匹配：期望 ${config.embeddingDim}，实际 ${embedding.length}`);
    }
  });
}

async function openAiCompatibleEmbeddings(texts, config) {
  const baseUrl = cleanBaseUrl(config.embeddingBaseUrl);
  if (!baseUrl) throw new Error('Embedding Base URL 未配置');

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: texts,
      encoding_format: 'float',
    }),
  });

  if (!response.ok) throw new Error(await readError(response));

  const payload = await response.json();
  const embeddings = toEmbeddingsArray(payload);
  assertEmbeddings(embeddings, config);
  return embeddings;
}

async function qwenMultimodalEmbeddings(texts, config) {
  const url = `${resolveQwenBaseUrl(config.embeddingBaseUrl)}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`;
  const requestBody = {
    model: config.embeddingModel,
    input: texts.map((text) => ({
      contents: [{ text }],
    })),
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) throw new Error(await readError(response));

  const payload = await response.json();
  const embeddings = toEmbeddingsArray(payload);
  assertEmbeddings(embeddings, config);
  return embeddings;
}

async function doubaoMultimodalTextEmbeddings(texts, config) {
  const response = await fetch(resolveDoubaoEmbeddingUrl(config.embeddingBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      dense_model: {
        name: config.embeddingModel,
        dim: Number(config.embeddingDim),
      },
      data: texts.map((text) => ({ text })),
    }),
  });

  if (!response.ok) throw new Error(await readError(response));

  const payload = await response.json();
  const embeddings = toEmbeddingsArray(payload);
  assertEmbeddings(embeddings, config);
  return embeddings;
}

function readImageAsDataUrl(absolutePath, mimeType) {
  const buffer = fs.readFileSync(absolutePath);
  const base64 = buffer.toString('base64');
  return `data:${mimeType || 'image/png'};base64,${base64}`;
}

async function qwenImageEmbedding(image, config) {
  const url = `${resolveQwenBaseUrl(config.embeddingBaseUrl)}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`;
  const requestBody = {
    model: config.embeddingModel,
    input: {
      contents: [
        {
          image: readImageAsDataUrl(image.absolutePath, image.mimeType),
        },
      ],
    },
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) throw new Error(await readError(response));

  const payload = await response.json();
  const embeddings = toEmbeddingsArray(payload);
  assertEmbeddings(embeddings, config);
  return embeddings[0];
}

async function doubaoImageEmbedding(image, config) {
  const response = await fetch(resolveDoubaoEmbeddingUrl(config.embeddingBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      dense_model: {
        name: config.embeddingModel,
        dim: Number(config.embeddingDim),
      },
      data: [{
        image: readImageAsDataUrl(image.absolutePath, image.mimeType),
      }],
    }),
  });

  if (!response.ok) throw new Error(await readError(response));

  const payload = await response.json();
  const embeddings = toEmbeddingsArray(payload);
  assertEmbeddings(embeddings, config);
  return embeddings[0];
}

async function customImageEmbedding(image, config) {
  const baseUrl = cleanBaseUrl(config.embeddingBaseUrl);
  if (!baseUrl) throw new Error('Embedding Base URL 未配置');

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: [{
        image: readImageAsDataUrl(image.absolutePath, image.mimeType),
      }],
      encoding_format: 'float',
    }),
  });

  if (!response.ok) throw new Error(await readError(response));

  const payload = await response.json();
  const embeddings = toEmbeddingsArray(payload);
  assertEmbeddings(embeddings, config);
  return embeddings[0];
}

async function getEmbedding(text, override = null) {
  const embeddings = await getEmbeddings([text], override);
  return embeddings[0];
}

async function getEmbeddings(texts, override = null) {
  const config = normalizeConfig(override);
  assertEmbeddingConfig(config);

  if (isKnownQwenMultimodalModel(config.embeddingModel)) {
    return qwenMultimodalEmbeddings(texts, config);
  }

  if (isKnownDoubaoMultimodalModel(config.embeddingModel)) {
    return doubaoMultimodalTextEmbeddings(texts, config);
  }

  return openAiCompatibleEmbeddings(texts, config);
}

async function getImageEmbedding(image, override = null) {
  const config = normalizeConfig(override);
  assertEmbeddingConfig(config);

  if (!config.embeddingMultimodalEnabled) {
    throw new Error('当前未启用多模态向量模型');
  }

  if (isKnownQwenMultimodalModel(config.embeddingModel)) {
    return qwenImageEmbedding(image, config);
  }

  if (isKnownDoubaoMultimodalModel(config.embeddingModel)) {
    return doubaoImageEmbedding(image, config);
  }

  if (config.embeddingProvider === 'custom' || looksLikeMultimodalModel(config.embeddingModel)) {
    return customImageEmbedding(image, config);
  }

  throw new Error('当前 Embedding 模型不支持图片向量化');
}

module.exports = {
  getEmbedding,
  getEmbeddings,
  getImageEmbedding,
  isMultimodalModel,
  supportsImageEmbedding,
};
