# Notus 联网搜索工具 — 技术实现规范

**版本**: v1.1  
**适用模块**: Notus Agentic Loop 工具链  
**执行方**: Codex

---

## 一、产品背景与设计约束

### 1.1 功能入口

输入框有「联网搜索」开关（toggle）。

- **开关打开**：`web_search` 工具注入 Agent 的 tool use 列表，Agent 可按需调用，可重复调用。
- **开关关闭**：`web_search` 工具**不注入**，Agent 无法感知该工具的存在，不会尝试调用。

### 1.2 多 Provider 策略

Notus 支持四个搜索 Provider，用户在设置里选择其中一个作为当前 Provider。运行时只调用用户选定的一个，`web_search` 工具对外暴露统一接口；Provider 调用交给官方 SDK，Notus 只做参数映射、配置校验和统一结果归一化。

| Provider | 定位 | 免费额度 | 是否需 API Key |
|---|---|---|---|
| **Firecrawl** | 搜索 + 全文抓取一体，LLM-ready Markdown 输出 | 1,000 credits/月，无需注册 | 可选（无 Key 即可调用，有 Key 解锁更高限额） |
| **Tavily** | AI 优化搜索结果，天然适配 RAG | 1,000 次/月，需注册免费账号 | 必须（`tvly-` 开头） |
| **Exa** | 语义向量搜索，擅长语义模糊查询 | 1,000 次/月 + $10 起始额度，需注册 | 必须（`exa_` 开头） |
| **智谱 Web Search** | 国内首选，中文搜索质量高，结果来源国内 | 按 Token 计费（API Key 注册后有免费额度） | 必须（`sk-` 开头） |

---

## 二、依赖安装

本仓库固定使用 `npm` 和纯 JavaScript。联网搜索 Provider 调用必须使用官方 npm SDK，不手写维护各 Provider 的 HTTP 请求细节。

```bash
npm --prefix notus install firecrawl@1.20.0 @tavily/core exa-js openai ws
```

- `firecrawl` 固定为 `1.20.0`：项目 Node 版本约束为 `20.19.x`，Firecrawl 新版已要求 Node 22。
- `ws` 是 Firecrawl SDK 运行时依赖链在 CommonJS 环境下需要的 WebSocket 包。
- Notus 只在 `lib/webSearch.js` 做统一参数映射与结果归一化，Provider API 调用交给 SDK。

---

## 三、统一输出类型

```typescript
// src/types/web-search.ts

export interface WebSearchResult {
  /** 结果标题 */
  title: string;
  /** 来源 URL */
  url: string;
  /** 正文内容（Markdown 或纯文本），用于注入 Agent 上下文 */
  content: string;
  /** 摘要（较短，部分 Provider 提供） */
  snippet?: string;
  /** 发布时间（ISO 8601，部分 Provider 提供） */
  publishedAt?: string;
}

export interface WebSearchResponse {
  /** 搜索查询词（原样记录，便于 Agent 日志） */
  query: string;
  /** 当前使用的 Provider */
  provider: WebSearchProvider;
  /** 搜索结果列表 */
  results: WebSearchResult[];
  /** 搜索耗时（ms） */
  durationMs: number;
}

export type WebSearchProvider = 'firecrawl' | 'tavily' | 'exa' | 'zhipu';

/**
 * 搜索深度模式（统一抽象，各 Provider 内部映射到各自的参数）
 *
 * - fast    : 只返回摘要/snippet，不抓取全文，速度快、消耗低
 *             Firecrawl → 不传 scrapeOptions
 *             Tavily    → searchDepth: 'basic'
 *             Exa       → 只返回 highlights，不返回全文
 *             智谱      → content_size: 'low'
 *
 * - normal  : 返回一定量正文，平衡速度和质量（默认）
 *             Firecrawl → scrapeOptions.formats: ['markdown'], onlyMainContent: true
 *             Tavily    → searchDepth: 'basic' + content
 *             Exa       → text.maxCharacters: 3000
 *             智谱      → content_size: 'medium'
 *
 * - deep    : 返回完整正文，质量最高，速度慢、消耗高
 *             Firecrawl → scrapeOptions.formats: ['markdown'], onlyMainContent: false
 *             Tavily    → searchDepth: 'advanced'（消耗 2 credits）
 *             Exa       → text.maxCharacters: 10000
 *             智谱      → content_size: 'high', search_engine: 'search_pro'
 */
export type SearchDepth = 'fast' | 'normal' | 'deep';

/**
 * 时间范围过滤（统一抽象）
 * 各 Provider 内部映射：
 *   Firecrawl → tbs: 'qdr:h' / 'qdr:d' / 'qdr:w' / 'qdr:m'
 *   Tavily    → topic: 'news', days: 1 / 7 / 30（仅 news topic 有效）
 *   Exa       → startPublishedDate（ISO）
 *   智谱      → search_recency_filter: 'oneDay' / 'oneWeek' / 'oneMonth' / 'noLimit'
 */
export type SearchRecency = 'hour' | 'day' | 'week' | 'month' | 'any';
```

---

## 四、各 Provider 适配器实现

### 4.1 Firecrawl

**无需 API Key**：每月 1,000 免费 credits，无需注册账号，无需配置 Authorization header 即可直接调用。Keyless 模式下 `/search`、`/scrape`、`/interact` 均可使用，但 `/crawl`、`/map`、`/agent` 等端点仍需 Key。

```typescript
// src/search/providers/firecrawl.ts

import FirecrawlApp from 'firecrawl';
import type { WebSearchResult } from '../../types/web-search';
import type { SearchDepth, SearchRecency } from '../../types/web-search';

/** SearchRecency → Firecrawl tbs 参数映射 */
const RECENCY_MAP: Record<SearchRecency, string | undefined> = {
  hour:  'qdr:h',
  day:   'qdr:d',
  week:  'qdr:w',
  month: 'qdr:m',
  any:   undefined,
};

/**
 * Firecrawl SDK 调用
 *
 * depth 对应：
 *   fast   → 不传 scrapeOptions，只返回 title + description（纯摘要，2 credits/10条）
 *   normal → scrapeOptions.formats: ['markdown'], onlyMainContent: true（全文，2 credits/10条）
 *   deep   → scrapeOptions.formats: ['markdown'], onlyMainContent: false（含侧边栏等，同上）
 *
 * 注意：Keyless 模式下 limit 最大 10，有 Key 可更高。
 */
export async function searchWithFirecrawl(
  query: string,
  options: {
    limit?: number;
    depth?: SearchDepth;
    recency?: SearchRecency;
    apiKey?: string;
  } = {},
): Promise<WebSearchResult[]> {
  const { limit = 5, depth = 'normal', recency = 'any', apiKey } = options;
  const app = new FirecrawlApp({ apiKey: apiKey ?? '' });

  const scrapeOptions =
    depth === 'fast'
      ? undefined
      : {
          formats: ['markdown' as const],
          onlyMainContent: depth !== 'deep',
        };

  const tbs = RECENCY_MAP[recency];

  const response = await app.search(query, {
    limit,
    ...(scrapeOptions ? { scrapeOptions } : {}),
    ...(tbs ? { tbs } : {}),
  });

  if (!response.success || !response.data) return [];

  return response.data.map((item) => ({
    title:   item.title ?? '',
    url:     item.url ?? '',
    content: item.markdown ?? item.description ?? '',
    snippet: item.description ?? undefined,
  }));
}
```

**费用说明**：
- Search（含 scrape）：每 10 条结果消耗 2 credits
- Keyless 免费额度：1,000 credits/月（约 500 次 × 10 条结果）
- `fast` 模式同样消耗 2 credits（Firecrawl 按请求计费，不按是否抓取全文区分）

---

### 4.2 Tavily

Tavily 免费额度 1,000 次/月，无需信用卡，注册后即可获得 `tvly-` 开头的 API Key。

```typescript
// src/search/providers/tavily.ts

import { tavily } from '@tavily/core';
import type { WebSearchResult } from '../../types/web-search';
import type { SearchDepth, SearchRecency } from '../../types/web-search';

/**
 * Tavily SDK 调用
 *
 * depth 对应：
 *   fast / normal → searchDepth: 'basic'（1 credit/次）
 *   deep          → searchDepth: 'advanced'（2 credits/次，质量更高）
 *
 * recency 对应：
 *   topic 切换为 'news' 并设置 days 参数（hour→1, day→1, week→7, month→30）
 *   any → topic: 'general'，不限时间
 *
 * 注意：days 参数仅在 topic: 'news' 时有效。
 */

const RECENCY_TO_DAYS: Partial<Record<SearchRecency, number>> = {
  hour:  1,
  day:   1,
  week:  7,
  month: 30,
};

export async function searchWithTavily(
  query: string,
  options: {
    limit?: number;
    depth?: SearchDepth;
    recency?: SearchRecency;
    apiKey: string;
  },
): Promise<WebSearchResult[]> {
  const { limit = 5, depth = 'normal', recency = 'any', apiKey } = options;
  const client = tavily({ apiKey });

  const isNews = recency !== 'any';
  const days   = isNews ? (RECENCY_TO_DAYS[recency] ?? 7) : undefined;

  const response = await client.search(query, {
    maxResults:   limit,
    searchDepth:  depth === 'deep' ? 'advanced' : 'basic',
    topic:        isNews ? 'news' : 'general',
    ...(days !== undefined ? { days } : {}),
    includeAnswer:      false,
    includeRawContent:  false,
  });

  return (response.results ?? []).map((item) => ({
    title:       item.title ?? '',
    url:         item.url ?? '',
    content:     item.content ?? '',
    snippet:     item.content?.slice(0, 200) ?? undefined,
    publishedAt: item.publishedDate ?? undefined,
  }));
}
```

**费用说明**：
- `basic`（fast / normal）：1 credit/次
- `advanced`（deep）：2 credits/次
- 免费：1,000 credits/月（需注册）；付费：$30/月起

---

### 4.3 Exa

Exa 免费额度 1,000 次/月 + $10 起始 credits，无需信用卡。2026 年 3 月起，前 10 条结果的内容提取（Contents）已打包进搜索请求，不再单独收费。

```typescript
// src/search/providers/exa.ts

import Exa from 'exa-js';
import type { WebSearchResult } from '../../types/web-search';
import type { SearchDepth, SearchRecency } from '../../types/web-search';

/**
 * Exa SDK 调用
 *
 * depth 对应（影响返回内容量和 token 消耗）：
 *   fast   → 只返回 highlights（3句），不返回全文；type: 'auto'
 *   normal → text.maxCharacters: 3000 + highlights；type: 'auto'
 *   deep   → text.maxCharacters: 10000 + highlights；type: 'neural'（语义搜索）
 *
 * recency 对应 startPublishedDate（ISO 8601）：
 *   hour  → 1小时前
 *   day   → 24小时前
 *   week  → 7天前
 *   month → 30天前
 *   any   → 不限
 *
 * 2026年3月起，前10条结果的 contents 已打包进 search 费用，无额外收费。
 */

function getStartDate(recency: SearchRecency): string | undefined {
  const now = Date.now();
  const MAP: Partial<Record<SearchRecency, number>> = {
    hour:  60 * 60 * 1000,
    day:   24 * 60 * 60 * 1000,
    week:  7  * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };
  const offset = MAP[recency];
  return offset ? new Date(now - offset).toISOString() : undefined;
}

export async function searchWithExa(
  query: string,
  options: {
    limit?: number;
    depth?: SearchDepth;
    recency?: SearchRecency;
    apiKey: string;
  },
): Promise<WebSearchResult[]> {
  const { limit = 5, depth = 'normal', recency = 'any', apiKey } = options;
  const exa = new Exa(apiKey);

  const startPublishedDate = getStartDate(recency);

  const textOptions =
    depth === 'fast'
      ? undefined
      : { maxCharacters: depth === 'deep' ? 10_000 : 3_000 };

  const response = await exa.search(query, {
    numResults: limit,
    type: depth === 'deep' ? 'neural' : 'auto',
    ...(startPublishedDate ? { startPublishedDate } : {}),
    contents: {
      ...(textOptions ? { text: textOptions } : {}),
      highlights: {
        numSentences:     depth === 'fast' ? 5 : 3,
        highlightsPerUrl: 1,
      },
    },
  });

  return (response.results ?? []).map((item) => ({
    title:       item.title ?? '',
    url:         item.url ?? '',
    content:     item.text ?? '',
    snippet:     item.highlights?.join(' ') ?? undefined,
    publishedAt: item.publishedDate ?? undefined,
  }));
}
```

**费用说明**：
- 免费：1,000 次/月（需注册）
- 付费：$7/1,000 次（standard）；`deep` 模式 $12/1,000 次（neural / deep search）
- 2026年3月起前10条 contents 打包进搜索费用，无额外费用

---

### 4.4 智谱 Web Search

智谱的联网搜索通过 `tools` 参数注入，`type: "web_search"`，支持指定搜索引擎（`search_pro`）、控制结果数量、域名过滤、时间范围等。

智谱联网搜索的设计与其他 Provider 不同：**它是让 GLM 模型自己决定是否搜索、搜什么，并在回答里融合搜索结果**，而不是返回原始搜索条目。对 Notus 场景，我们需要的是原始搜索结果（供 Notus 的主模型使用），因此调用方式做特殊处理：强制要求模型只输出搜索结果的 JSON，不进行自由生成。

```typescript
// src/search/providers/zhipu.ts

import OpenAI from 'openai';
import type { WebSearchResult } from '../../types/web-search';
import type { SearchDepth, SearchRecency } from '../../types/web-search';

/**
 * 智谱 Web Search SDK 调用
 *
 * depth 对应：
 *   fast   → search_engine: 'search_std', content_size: 'low'
 *   normal → search_engine: 'search_std', content_size: 'medium'
 *   deep   → search_engine: 'search_pro', content_size: 'high'
 *
 * recency 对应 search_recency_filter：
 *   hour / day → 'oneDay'
 *   week       → 'oneWeek'
 *   month      → 'oneMonth'
 *   any        → 'noLimit'
 */

const RECENCY_MAP: Record<SearchRecency, string> = {
  hour:  'oneDay',
  day:   'oneDay',
  week:  'oneWeek',
  month: 'oneMonth',
  any:   'noLimit',
};

export async function searchWithZhipu(
  query: string,
  options: {
    limit?: number;
    depth?: SearchDepth;
    recency?: SearchRecency;
    apiKey: string;
  },
): Promise<WebSearchResult[]> {
  const { limit = 5, depth = 'normal', recency = 'any', apiKey } = options;

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  });

  const contentSize   = depth === 'fast' ? 'low' : depth === 'deep' ? 'high' : 'medium';
  const searchEngine  = depth === 'deep' ? 'search_pro' : 'search_std';
  const recencyFilter = RECENCY_MAP[recency];

  const response = await client.chat.completions.create({
    model: 'glm-4-air',
    messages: [{ role: 'user', content: query }],
    tools: [
      {
        type: 'web_search',
        // @ts-expect-error 智谱扩展字段，非 OpenAI 标准
        web_search: {
          enable:                'True',
          search_engine:         searchEngine,
          search_result:         'True',
          count:                 String(limit),
          content_size:          contentSize,
          search_recency_filter: recencyFilter,
        },
      },
    ],
  } as Parameters<typeof client.chat.completions.create>[0]);

  const toolCalls = response.choices?.[0]?.message?.tool_calls;
  if (!toolCalls?.length) return [];

  try {
    const searchData = JSON.parse(toolCalls[0].function?.arguments ?? '{}');
    const items: Array<{
      title?:        string;
      link?:         string;
      content?:      string;
      publish_date?: string;
    }> = searchData.search_result ?? [];

    return items.map((item) => ({
      title:       item.title ?? '',
      url:         item.link ?? '',
      content:     item.content ?? '',
      snippet:     item.content?.slice(0, 200) ?? undefined,
      publishedAt: item.publish_date ?? undefined,
    }));
  } catch {
    return [];
  }
}
```

**费用说明**：
- 按 Token 计费（prompt + completion tokens）
- `search_pro` 引擎质量更高，消耗略高
- 注册后有免费 Token 额度；**推荐场景**：国内中文内容搜索

---

## 五、统一搜索入口

```typescript
// src/search/index.ts

import { searchWithFirecrawl } from './providers/firecrawl';
import { searchWithTavily }    from './providers/tavily';
import { searchWithExa }       from './providers/exa';
import { searchWithZhipu }     from './providers/zhipu';
import type {
  WebSearchProvider,
  WebSearchResponse,
  SearchDepth,
  SearchRecency,
} from '../types/web-search';

export interface WebSearchConfig {
  provider:    WebSearchProvider;
  apiKey?:     string;         // Firecrawl 可选；其他 Provider 必须
  maxResults?: number;         // 默认 5，建议范围 3–10
  depth?:      SearchDepth;    // 默认 'normal'
  recency?:    SearchRecency;  // 默认 'any'
}

export async function webSearch(
  query: string,
  config: WebSearchConfig,
): Promise<WebSearchResponse> {
  const {
    provider,
    apiKey,
    maxResults = 5,
    depth      = 'normal',
    recency    = 'any',
  } = config;

  const startTime = Date.now();
  const opts = { limit: maxResults, depth, recency, apiKey: apiKey! };

  let results: WebSearchResponse['results'];

  switch (provider) {
    case 'firecrawl':
      results = await searchWithFirecrawl(query, { ...opts, apiKey });
      break;
    case 'tavily':
      if (!apiKey) throw new Error('Tavily 需要 API Key');
      results = await searchWithTavily(query, opts);
      break;
    case 'exa':
      if (!apiKey) throw new Error('Exa 需要 API Key');
      results = await searchWithExa(query, opts);
      break;
    case 'zhipu':
      if (!apiKey) throw new Error('智谱 Web Search 需要 API Key');
      results = await searchWithZhipu(query, opts);
      break;
    default:
      throw new Error(`未知 Provider: ${provider}`);
  }

  return { query, provider, results, durationMs: Date.now() - startTime };
}
```

---

## 六、Agent 工具定义

```typescript
// src/tools/web-search.ts

import { webSearch } from '../search';
import type { WebSearchConfig } from '../search';

/**
 * web_search 工具
 *
 * 【注入时机】
 * 仅当用户在输入框打开「联网搜索」开关时，将此工具注入 Agent tool use 列表。
 * 开关关闭时，工具定义不传给 LLM，Agent 无法感知和调用。
 *
 * 【调用策略】
 * 可重复调用：Agent 可在同一任务中多次调用，分别搜索不同关键词。
 * 每次调用结果作为 tool_result 注入当前对话轮次的 messages，
 * 随 Agent Loop 的 messages 数组传给下一轮 LLM 请求。
 * 搜索结果不写入数据库（与文档解析不同），仅在当前 Agent Loop 生命周期内有效。
 */
export function buildWebSearchTool(config: WebSearchConfig) {
  return {
    name: 'web_search',

    description: `
在互联网上搜索实时信息，获取最新的网页内容作为参考。

【调用时机 - 满足以下任一条件时调用】
- 用户问题涉及实时信息：新闻、价格、天气、最新版本、近期事件等。
- 用户明确要求联网查询，如"帮我搜索"、"查一下"、"最新的XX是什么"。
- 知识库中没有相关内容，且问题需要当前时间节点的数据支撑。
- 需要验证或补充某个具体事实。

【不应调用的场景】
- 问题可以完全依赖 Notus 本地知识库（search_knowledge）回答。
- 纯粹的写作、代码、分析任务，不需要实时网络数据。
- 已经搜索过相同或高度相似的关键词（避免重复搜索浪费额度）。

【可重复调用】
同一任务中可以多次调用，使用不同关键词搜索不同子问题。
    `.trim(),

    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '搜索关键词。应简洁具体，3-8 个词为宜。避免使用自然语言句子，使用关键词组合效果更好。',
        },
      },
      required: ['query'],
    },

    async execute({ query }: { query: string }) {
      const response = await webSearch(query, config);

      if (response.results.length === 0) {
        return {
          success: false,
          message: `搜索"${query}"未返回结果，请尝试换用其他关键词。`,
          results: [],
        };
      }

      return {
        success: true,
        query,
        provider: response.provider,
        durationMs: response.durationMs,
        results: response.results.map((r) => ({
          title: r.title,
          url: r.url,
          // 内容截断，避免单次 tool_result 过大撑爆 context window
          content: r.content.slice(0, 4_000),
          snippet: r.snippet,
          publishedAt: r.publishedAt,
        })),
      };
    },
  };
}
```

---

## 七、工具注入逻辑

在构建 Agent 的 LLM 请求时，根据联网开关状态决定是否注入 `web_search`：

```typescript
// 伪代码，具体位置取决于现有 Agent Loop 的 tool 构建逻辑

import { NOTUS_TOOLS } from './tools/index';
import { buildWebSearchTool } from './tools/web-search';
import type { WebSearchConfig } from './search';

function buildAgentTools(options: {
  webSearchEnabled: boolean;
  webSearchConfig?: WebSearchConfig;
}) {
  // 基础工具集（search_knowledge、read_file 等，始终注入）
  const tools = [...NOTUS_TOOLS];

  // 联网搜索工具：仅开关打开时注入
  if (options.webSearchEnabled && options.webSearchConfig) {
    tools.push(buildWebSearchTool(options.webSearchConfig));
  }

  return tools;
}
```

`webSearchEnabled` 的值来源于前端输入框的开关状态，随每次对话请求从客户端传到服务端。

---

## 八、Provider 配置存储

用户选择的 Provider 和 API Key 存储在现有设置体系中（参考项目现有 settings 存储方式）：

```typescript
// 设置项结构（按现有 settings 表或配置文件的格式适配）
interface WebSearchSettings {
  provider:         'firecrawl' | 'tavily' | 'exa' | 'zhipu';
  firecrawlApiKey?: string;    // 可选；为空则走 Keyless
  tavilyApiKey?:    string;
  exaApiKey?:       string;
  zhipuApiKey?:     string;
  maxResults:       number;    // 默认 5，用户可调整（建议范围 3–10）
  depth:            SearchDepth;   // 默认 'normal'
  recency:          SearchRecency; // 默认 'any'
}
```

构建 `WebSearchConfig` 时，从设置中读取当前 Provider 对应的 Key：

```typescript
function getWebSearchConfig(settings: WebSearchSettings): WebSearchConfig {
  const keyMap: Record<WebSearchSettings['provider'], string | undefined> = {
    firecrawl: settings.firecrawlApiKey,
    tavily:    settings.tavilyApiKey,
    exa:       settings.exaApiKey,
    zhipu:     settings.zhipuApiKey,
  };

  return {
    provider:   settings.provider,
    apiKey:     keyMap[settings.provider],
    maxResults: settings.maxResults ?? 5,
    depth:      settings.depth      ?? 'normal',
    recency:    settings.recency    ?? 'any',
  };
}
```

---

## 九、搜索结果的上下文生命周期

与文档解析（`parsed_attachment`，写入 `messages` 表持久化）类似，**搜索结果按同一 conversation 持久化为 `web_search_context`**。

原因：Notus 的 Agent Loop 需要在同一会话中管理和复用联网搜索上下文，避免用户连续追问时重复搜索相同材料。搜索结果不进入知识库索引，也不跨 conversation 共享；只有用户本轮打开联网搜索开关时，后端才会按预算把历史 `web_search_context` 拼入 system prompt。

生命周期：

```
用户发送消息（联网开关打开）
    │
    ├─ Agent 决定调用 web_search
    │
    ├─ 搜索结果作为 tool_result 注入当前 messages 数组
    │
    ├─ 成功结果写入 messages(type='web_search_context')
    │
    ├─ 后续 LLM 轮次携带 tool_result 继续推理
    │
    └─ 同一 conversation 后续任务在联网开关打开时可按预算复用
```

若 Agent 在回答中引用了搜索来源，AI 最终回复会写入 `messages` 表（正常的对话持久化）。原始搜索结果以截断正文、标题、URL、provider、query、耗时等元数据保存为 `web_search_context`，用于同会话上下文管理。

---

## 十、Provider 选择建议

| 场景 | 推荐 Provider |
|---|---|
| 用户在国内，主要搜中文内容 | **智谱** |
| 用户在国内，搜英文 / 全球内容，不想注册 | **Firecrawl**（Keyless） |
| 需要语义搜索，搜索词和内容术语差异大 | **Exa** |
| 需要最优 RAG 结果质量，不在意价格 | **Tavily** |
| 默认（开箱即用，无需任何配置） | **Firecrawl**（Keyless） |

---

## 十一、注意事项

1. **Firecrawl Keyless 的限制**：Keyless 模式只支持 `/search`、`/scrape`、`/interact`，不支持 `/crawl`、`/map`、`/extract`、`/agent`。Notus 只需 `/search`，完全够用。

2. **智谱的调用方式差异**：智谱 Web Search 不是独立的搜索 API，而是 GLM 模型的 `web_search` tool。响应中包含模型生成的内容和工具调用结果，Notus 的 SDK 调用层需要从 `tool_calls` 字段中提取 `search_result`，而不是直接解析 response body。

3. **`maxResults` 的 token 影响**：每条搜索结果最多 4,000 字符，5 条结果最多约 20,000 字符。若 context window 紧张，可将 `content` 截断为 2,000 字符或降低 `maxResults`。

4. **重复搜索防护**：工具描述中已注明"避免重复搜索相同关键词"，但不在代码层面强制去重——Agent 自己判断，去重逻辑交给 LLM，不在工具层硬编码。

5. **错误处理**：任何 Provider 抛出异常，工具层应 catch 后返回 `{ success: false, message: '搜索服务暂时不可用，请稍后重试。' }`，不应让异常传播到 Agent Loop 导致整个任务中断。

6. **API Key 安全**：Key 存储在服务端设置，不暴露给前端。前端只传 `webSearchEnabled: boolean`，Key 由服务端读取。

---

## 十二、各 Provider 参数对照速查

| 统一参数 | Firecrawl | Tavily | Exa | 智谱 |
|---|---|---|---|---|
| `maxResults` | `limit`（Keyless 上限 10） | `maxResults`（上限 20） | `numResults`（无硬限） | `count`（上限 10，字符串） |
| `depth: 'fast'` | 不传 `scrapeOptions` | `searchDepth: 'basic'` | 只返回 highlights | `content_size: 'low'` + `search_std` |
| `depth: 'normal'` | `scrapeOptions` + `onlyMainContent: true` | `searchDepth: 'basic'` | `text.maxCharacters: 3000` | `content_size: 'medium'` + `search_std` |
| `depth: 'deep'` | `scrapeOptions` + `onlyMainContent: false` | `searchDepth: 'advanced'`（2 credits） | `text.maxCharacters: 10000` + `type: 'neural'` | `content_size: 'high'` + `search_pro` |
| `recency: 'hour'` | `tbs: 'qdr:h'` | `topic: 'news', days: 1` | `startPublishedDate: -1h` | `search_recency_filter: 'oneDay'` |
| `recency: 'day'` | `tbs: 'qdr:d'` | `topic: 'news', days: 1` | `startPublishedDate: -24h` | `search_recency_filter: 'oneDay'` |
| `recency: 'week'` | `tbs: 'qdr:w'` | `topic: 'news', days: 7` | `startPublishedDate: -7d` | `search_recency_filter: 'oneWeek'` |
| `recency: 'month'` | `tbs: 'qdr:m'` | `topic: 'news', days: 30` | `startPublishedDate: -30d` | `search_recency_filter: 'oneMonth'` |
| `recency: 'any'` | 不传 `tbs` | `topic: 'general'` | 不传 `startPublishedDate` | `search_recency_filter: 'noLimit'` |
