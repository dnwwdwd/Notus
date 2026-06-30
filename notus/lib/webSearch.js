function normalizeDepth(provider, mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (['fast', 'normal', 'deep'].includes(value)) return value;
  if (provider === 'tavily') return value === 'advanced' ? 'deep' : 'normal';
  if (provider === 'exa') {
    if (value === 'neural' || value === 'deep') return 'deep';
    if (value === 'keyword' || value === 'fast') return 'fast';
    return 'normal';
  }
  if (provider === 'zhipu') return value === 'search-prime' || value === 'search_pro' ? 'deep' : 'normal';
  return 'normal';
}

function clampLimit(value, fallback = 5, max = 10) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.min(Math.max(Math.floor(next), 1), max);
}

function truncate(value, max = 12000) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[...内容已截断，原文共 ${text.length} 字符]`;
}

function compactResult(item = {}) {
  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const title = String(item.title || item.name || metadata.title || metadata.ogTitle || '').trim();
  const url = String(item.url || item.link || metadata.sourceURL || metadata.ogUrl || '').trim();
  const content = truncate(item.content || item.markdown || item.raw_content || item.rawContent || item.text || item.description || item.snippet || '', 12000);
  const snippet = String(item.snippet || item.description || item.content || item.text || '').trim().slice(0, 500);
  return {
    title: title || url || '未命名网页',
    url,
    content,
    snippet: snippet || undefined,
    publishedAt: item.publishedAt || item.publishedDate || item.published_date || item.publish_date || metadata.publishedTime || metadata.dcDate || undefined,
  };
}

async function searchWithFirecrawl(query, options = {}) {
  const FirecrawlModule = require('firecrawl');
  const FirecrawlApp = FirecrawlModule.default || FirecrawlModule.FirecrawlApp || FirecrawlModule;
  const depth = normalizeDepth('firecrawl', options.mode);
  const limit = clampLimit(options.maxResults, 5, options.apiKey ? 20 : 10);
  const scrapeOptions = depth === 'fast'
    ? undefined
    : { formats: ['markdown'], onlyMainContent: depth !== 'deep' };
  const app = new FirecrawlApp({
    apiKey: String(options.apiKey || '').trim() || null,
  });
  const payload = await app.search(query, {
    limit,
    ...(scrapeOptions ? { scrapeOptions } : {}),
  });
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.results) ? payload.results : [];
  return data.map(compactResult).filter((item) => item.url || item.content);
}

async function searchWithTavily(query, options = {}) {
  if (!options.apiKey) throw new Error('Tavily 需要 API Key');
  const { tavily } = require('@tavily/core');
  const depth = normalizeDepth('tavily', options.mode);
  const client = tavily({ apiKey: options.apiKey });
  const payload = await client.search(query, {
    maxResults: clampLimit(options.maxResults, 5, 20),
    searchDepth: depth === 'deep' ? 'advanced' : 'basic',
    includeAnswer: false,
    includeRawContent: depth === 'fast' ? false : 'markdown',
    topic: 'general',
  });
  return (Array.isArray(payload?.results) ? payload.results : [])
    .map(compactResult)
    .filter((item) => item.url || item.content);
}

async function searchWithExa(query, options = {}) {
  if (!options.apiKey) throw new Error('Exa 需要 API Key');
  const ExaModule = require('exa-js');
  const Exa = ExaModule.default || ExaModule.Exa || ExaModule;
  const depth = normalizeDepth('exa', options.mode);
  const contents = depth === 'fast'
    ? { highlights: { numSentences: 5, highlightsPerUrl: 1 } }
    : {
      text: { maxCharacters: depth === 'deep' ? 10000 : 3000 },
      highlights: { numSentences: 3, highlightsPerUrl: 1 },
    };
  const exa = new Exa(options.apiKey);
  const payload = await exa.search(query, {
    numResults: clampLimit(options.maxResults, 5, 20),
    type: depth === 'deep' ? 'neural' : 'auto',
    contents,
  });
  return (Array.isArray(payload?.results) ? payload.results : [])
    .map((item) => compactResult({
      ...item,
      content: item.text || (Array.isArray(item.highlights) ? item.highlights.join('\n') : ''),
      snippet: Array.isArray(item.highlights) ? item.highlights.join(' ') : item.snippet,
    }))
    .filter((item) => item.url || item.content);
}

function parseJsonFromText(text = '') {
  const source = String(text || '').trim();
  if (!source) return null;
  try { return JSON.parse(source); } catch {}
  const match = source.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch {}
  return null;
}

async function searchWithZhipu(query, options = {}) {
  if (!options.apiKey) throw new Error('智谱 Web Search 需要 API Key');
  const OpenAIModule = require('openai');
  const OpenAI = OpenAIModule.default || OpenAIModule.OpenAI || OpenAIModule;
  const depth = normalizeDepth('zhipu', options.mode);
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  });
  const payload = await client.chat.completions.create({
    model: 'glm-4-air',
    messages: [
      {
        role: 'user',
        content: `请联网搜索并只输出 JSON，格式为 {"results":[{"title":"","url":"","content":"","publishedAt":""}]}。查询：${query}`,
      },
    ],
    tools: [{
      type: 'web_search',
      web_search: {
        enable: 'True',
        search_engine: depth === 'deep' ? 'search_pro' : 'search_std',
        search_result: 'True',
        count: String(clampLimit(options.maxResults, 5, 10)),
        content_size: depth === 'fast' ? 'low' : depth === 'deep' ? 'high' : 'medium',
        search_recency_filter: 'noLimit',
      },
    }],
  });
  const message = payload?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const fromTool = toolCalls.map((call) => parseJsonFromText(call?.function?.arguments || '')).find(Boolean);
  const parsed = fromTool || parseJsonFromText(message.content || '');
  const items = Array.isArray(parsed?.results)
    ? parsed.results
    : Array.isArray(parsed?.search_result)
      ? parsed.search_result
      : Array.isArray(parsed)
        ? parsed
        : [];
  return items.map((item) => compactResult({
    title: item.title,
    url: item.url || item.link,
    content: item.content || item.summary,
    publishedAt: item.publishedAt || item.publish_date,
  })).filter((item) => item.url || item.content);
}

async function webSearch(query, config = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索关键词不能为空');
  const provider = String(config.provider || 'firecrawl').trim().toLowerCase();
  const startedAt = Date.now();
  let results;
  if (provider === 'firecrawl') {
    results = await searchWithFirecrawl(q, { ...config, maxResults: config.max_results || config.maxResults });
  } else if (provider === 'tavily') {
    results = await searchWithTavily(q, { ...config, maxResults: config.max_results || config.maxResults });
  } else if (provider === 'exa') {
    results = await searchWithExa(q, { ...config, maxResults: config.max_results || config.maxResults });
  } else if (provider === 'zhipu') {
    results = await searchWithZhipu(q, { ...config, maxResults: config.max_results || config.maxResults });
  } else {
    throw new Error(`未知搜索服务商：${provider}`);
  }
  return {
    query: q,
    provider,
    results,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  webSearch,
  normalizeDepth,
  searchWithFirecrawl,
  searchWithTavily,
  searchWithExa,
  searchWithZhipu,
};
