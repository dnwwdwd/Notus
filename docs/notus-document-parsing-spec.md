# Notus 文档解析与网页抓取 — 技术实现规范

**版本**: v1.0  
**适用模块**: Notus 知识库导入层 + Agentic Loop 工具链  
**执行方**: Codex

---

## 一、总体架构

### 1.1 定位

文档解析和网页抓取统一作为 **Agent 可调用工具（Tool）**，向上层 Agentic Loop 暴露标准接口。解析结果注入当前会话上下文（Session Context），在本次对话生命周期内持久存在，Agent 在后续轮次可直接引用，无需重复解析。

### 1.2 模块划分

```
src/
├── tools/
│   ├── parse-document.ts      # 工具入口：PDF / DOCX / MD / TXT（不含 PPTX）
│   ├── parse-url.ts           # 工具入口：网页/链接抓取
│   └── index.ts               # 工具注册表
├── parsers/
│   ├── pdf.ts                 # LiteParse PDF 解析器
│   ├── docx.ts                # mammoth DOCX 解析器
│   ├── plaintext.ts           # MD / TXT 原生读取
│   └── web.ts                 # fetch + Readability + cheerio
├── context/
│   └── session-context.ts     # 会话上下文管理
└── types/
    └── parsed-content.ts      # 统一输出类型
```

---

## 二、依赖安装

```bash
# 核心解析库
pnpm add @llamaindex/liteparse          # PDF (PDFium 引擎, Rust 二进制)
pnpm add mammoth                         # DOCX (纯 JS, 零原生依赖)

# 网页抓取
pnpm add @mozilla/readability           # 正文提取 (Firefox Reader View 同源)
pnpm add jsdom                          # DOM 环境 (Readability 依赖)
pnpm add cheerio                        # HTML 结构化提取 (补充 fallback)
```

> **注意**：LiteParse 通过 `optionalDependencies` 自动选择平台对应的预编译二进制。Lazy Cat NAS（Linux ARM64）对应 `@llamaindex/liteparse-linux-arm64-gnu`，npm install 时自动下载。Next standalone、Web 分发目录和 `.lpk` 产物必须显式包含 LiteParse 对应平台 optional package、`.node` 文件和 `libpdfium.so`，不能只打入 `@llamaindex/liteparse` 的 JS 文件。LiteParse **不需要** LibreOffice；DOCX 由 mammoth 独立处理，两者互不依赖。

---

## 三、统一输出类型

```typescript
// src/types/parsed-content.ts

export type ParsedContentType =
  | 'pdf'
  | 'docx'
  | 'markdown'
  | 'plaintext'
  | 'webpage';

export type ParseStatus = 'success' | 'partial' | 'error';

export interface ParsedContent {
  /** 内容来源标识，文件名或 URL */
  source: string;
  /** 内容类型 */
  type: ParsedContentType;
  /** 解析状态 */
  status: ParseStatus;
  /** 提取到的纯文本，供 RAG 索引和 Agent 读取 */
  text: string;
  /** 页数（PDF）或 undefined */
  pageCount?: number;
  /** 文档元数据（标题、作者等，按需提取） */
  metadata?: Record<string, string>;
  /** 面向用户的警告信息（如：图片 PDF、部分乱码等） */
  warning?: string;
  /** 解析失败时的错误码，Agent 据此决定如何告知用户 */
  errorCode?:
    | 'IMAGE_PDF'          // 图片/扫描件 PDF，无文字层
    | 'GARBLED_TEXT'       // 字体编码异常，文字可能乱码
    | 'FETCH_FAILED'       // 网络请求失败
    | 'CSR_PAGE'           // 页面为纯 CSR 渲染，无法静态抓取
    | 'PARSE_FAILED'       // 通用解析失败
    | 'UNSUPPORTED_FORMAT' // 不支持的文件格式
    | 'EMPTY_CONTENT';     // 解析成功但内容为空
  /** 解析时间戳（ISO 8601） */
  parsedAt: string;
}
```

---

## 四、各格式解析器实现

### 4.1 PDF 解析器

```typescript
// src/parsers/pdf.ts

import { LiteParse } from '@llamaindex/liteparse';
import type { ParsedContent } from '../types/parsed-content';

const parser = new LiteParse({ ocrEnabled: false });

/**
 * 检测文本是否存在大量乱码（CJK 字体编码问题启发式判断）
 * 替换字符 \uFFFD 比例 > 20% 视为乱码
 */
function detectGarbled(text: string): boolean {
  if (text.length === 0) return false;
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
  return replacementChars / text.length > 0.2;
}

export async function parsePdf(
  filePath: string,
  fileName: string,
): Promise<ParsedContent> {
  const base: Omit<ParsedContent, 'status' | 'text'> = {
    source: fileName,
    type: 'pdf',
    parsedAt: new Date().toISOString(),
  };

  let result: Awaited<ReturnType<typeof parser.parse>>;
  try {
    result = await parser.parse(filePath);
  } catch (err) {
    return {
      ...base,
      status: 'error',
      text: '',
      errorCode: 'PARSE_FAILED',
      warning: `PDF 解析失败：${(err as Error).message}`,
    };
  }

  const fullText = result.text ?? '';
  const pageCount = result.pages?.length ?? 0;

  // 图片 PDF 检测：所有页面文本均为空
  const allPagesEmpty = result.pages?.every(
    (p) => (p.textItems?.length ?? 0) === 0,
  );
  if (allPagesEmpty || fullText.trim().length === 0) {
    return {
      ...base,
      status: 'error',
      text: '',
      pageCount,
      errorCode: 'IMAGE_PDF',
      warning:
        '此 PDF 为扫描件或图片 PDF，无可提取的文字层。Notus 目前不支持 OCR，无法读取其中的内容。如需导入，请先用其他工具将其转换为可搜索 PDF 后重新上传。',
    };
  }

  // 乱码检测
  if (detectGarbled(fullText)) {
    return {
      ...base,
      status: 'partial',
      text: fullText,
      pageCount,
      errorCode: 'GARBLED_TEXT',
      warning:
        '部分文字可能显示异常，原因是该 PDF 使用了非标准字体编码。内容已尽量提取，但准确性可能受影响。',
    };
  }

  return {
    ...base,
    status: 'success',
    text: fullText,
    pageCount,
  };
}
```

### 4.2 DOCX 解析器

```typescript
// src/parsers/docx.ts

import mammoth from 'mammoth';
import type { ParsedContent } from '../types/parsed-content';

export async function parseDocx(
  filePath: string,
  fileName: string,
): Promise<ParsedContent> {
  const base: Omit<ParsedContent, 'status' | 'text'> = {
    source: fileName,
    type: 'docx',
    parsedAt: new Date().toISOString(),
  };

  let result: Awaited<ReturnType<typeof mammoth.extractRawText>>;
  try {
    result = await mammoth.extractRawText({ path: filePath });
  } catch (err) {
    return {
      ...base,
      status: 'error',
      text: '',
      errorCode: 'PARSE_FAILED',
      warning: `Word 文档解析失败：${(err as Error).message}`,
    };
  }

  const text = result.value.trim();

  if (text.length === 0) {
    return {
      ...base,
      status: 'error',
      text: '',
      errorCode: 'EMPTY_CONTENT',
      warning: '文档内容为空，或内容仅为图片/图表，无法提取文字。',
    };
  }

  // mammoth 的 messages 包含无法转换的元素警告
  const hasWarnings = result.messages.some((m) => m.type === 'warning');

  return {
    ...base,
    status: hasWarnings ? 'partial' : 'success',
    text,
    warning: hasWarnings
      ? '文档中部分元素（如复杂表格、嵌入对象）未能完整提取。'
      : undefined,
  };
}
```

### 4.3 纯文本解析器（MD / TXT）

```typescript
// src/parsers/plaintext.ts

import { readFile } from 'node:fs/promises';
import type { ParsedContent, ParsedContentType } from '../types/parsed-content';

export async function parsePlaintext(
  filePath: string,
  fileName: string,
  type: Extract<ParsedContentType, 'markdown' | 'plaintext'>,
): Promise<ParsedContent> {
  const base: Omit<ParsedContent, 'status' | 'text'> = {
    source: fileName,
    type,
    parsedAt: new Date().toISOString(),
  };

  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (err) {
    return {
      ...base,
      status: 'error',
      text: '',
      errorCode: 'PARSE_FAILED',
      warning: `文件读取失败：${(err as Error).message}`,
    };
  }

  if (text.trim().length === 0) {
    return {
      ...base,
      status: 'error',
      text: '',
      errorCode: 'EMPTY_CONTENT',
      warning: '文件内容为空。',
    };
  }

  return {
    ...base,
    status: 'success',
    text,
  };
}
```

### 4.4 网页抓取解析器

```typescript
// src/parsers/web.ts

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import * as cheerio from 'cheerio';
import type { ParsedContent } from '../types/parsed-content';

/** Readability 正文提取最低字符数阈值 */
const MIN_CONTENT_LENGTH = 200;

/** 请求超时（ms） */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * 用 Readability 提取正文。
 * 返回 null 表示页面不适合 Readability（如纯导航页、SPA 空壳等）。
 */
function extractWithReadability(
  html: string,
  url: string,
): { title: string; text: string } | null {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || (article.textContent?.trim().length ?? 0) < MIN_CONTENT_LENGTH) {
    return null;
  }

  return {
    title: article.title ?? '',
    text: article.textContent?.trim() ?? '',
  };
}

/**
 * Readability 失败时的 cheerio fallback：
 * 提取 <main>、<article>、[role=main] 的文本；
 * 再不行就提取 <body> 去掉 nav/header/footer/script/style。
 */
function extractWithCheerio(html: string): string {
  const $ = cheerio.load(html);

  // 移除干扰元素
  $('script, style, nav, header, footer, aside, [role=navigation]').remove();

  // 优先提取语义化容器
  const containers = ['main', 'article', '[role=main]', '#content', '.content'];
  for (const sel of containers) {
    const text = $(sel).text().trim();
    if (text.length >= MIN_CONTENT_LENGTH) return text;
  }

  // 最终 fallback：body 全文
  return $('body').text().replace(/\s{3,}/g, '\n\n').trim();
}

export async function parseUrl(url: string): Promise<ParsedContent> {
  const base: Omit<ParsedContent, 'status' | 'text'> = {
    source: url,
    type: 'webpage',
    parsedAt: new Date().toISOString(),
  };

  let html: string;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Notus/1.0; +https://notus.app)',
      },
    });

    if (!res.ok) {
      return {
        ...base,
        status: 'error',
        text: '',
        errorCode: 'FETCH_FAILED',
        warning: `请求失败，HTTP ${res.status}：${url}`,
      };
    }

    html = await res.text();
  } catch (err) {
    return {
      ...base,
      status: 'error',
      text: '',
      errorCode: 'FETCH_FAILED',
      warning: `无法访问该链接：${(err as Error).message}`,
    };
  }

  // 尝试 Readability（适合文章、博客、文档页面）
  const readabilityResult = extractWithReadability(html, url);

  if (readabilityResult) {
    return {
      ...base,
      status: 'success',
      text: readabilityResult.text,
      metadata: { title: readabilityResult.title },
    };
  }

  // CSR 判断：HTML body 中可见文字极少（< 100 字符）
  const $ = cheerio.load(html);
  $('script, style').remove();
  const bodyText = $('body').text().trim();

  if (bodyText.length < 100) {
    return {
      ...base,
      status: 'error',
      text: '',
      errorCode: 'CSR_PAGE',
      warning:
        '此页面由 JavaScript 动态渲染（SPA），无法直接抓取正文内容。请将需要导入的内容手动复制粘贴到 Notus 中。',
    };
  }

  // Cheerio fallback
  const fallbackText = extractWithCheerio(html);

  if (fallbackText.length < MIN_CONTENT_LENGTH) {
    return {
      ...base,
      status: 'error',
      text: '',
      errorCode: 'EMPTY_CONTENT',
      warning: '页面内容过少，无法有效提取正文。',
    };
  }

  return {
    ...base,
    status: 'partial',
    text: fallbackText,
    warning: '页面结构不标准，已尽量提取正文，内容可能包含少量导航或无关文字。',
  };
}
```

---

## 五、Agent 工具定义

### 5.1 parse_document 工具

```typescript
// src/tools/parse-document.ts

import path from 'node:path';
import { parsePdf } from '../parsers/pdf';
import { parseDocx } from '../parsers/docx';
import { parsePlaintext } from '../parsers/plaintext';
import { saveAttachment, hasAttachment } from '../context/attachment-store';
import type { ParsedContent } from '../types/parsed-content';

/** 支持的文件扩展名 → 解析器映射 */
const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.md', '.txt',
  // 注意：.pptx 不在支持列表，应在前端上传时拦截
]);

export const parseDocumentTool = {
  name: 'parse_document',

  description: `
解析用户上传的本地文件，提取文字内容并注入当前会话上下文。
支持格式：PDF (.pdf)、Word (.docx)、Markdown (.md)、纯文本 (.txt)。
不支持格式：PPT/PPTX（演示文稿），上传时应在前端拦截并提示用户。

【调用时机 - 必须满足以下所有条件才可调用】
1. 用户已明确上传了文件（session 中存在待处理的文件路径）。
2. 该文件尚未被解析（session context 中没有该文件来源的已解析内容）。
3. 用户意图是"读取/分析/导入这个文件的内容"，而非其他操作。

【严禁调用场景】
- 用户未上传任何文件时。
- 文件已解析过（避免重复解析同一文件）。
- 文件格式不在支持列表中（应告知用户支持的格式）。
  `.trim(),

  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: '已上传文件在服务器上的临时路径（由文件上传模块提供）',
      },
      fileName: {
        type: 'string',
        description: '原始文件名，含扩展名，用于类型识别和用户显示',
      },
    },
    required: ['filePath', 'fileName'],
  },

  async execute({
    filePath,
    fileName,
    conversationId,
    db,
  }: {
    filePath: string;
    fileName: string;
    conversationId: string;
    db: Database;
  }): Promise<ParsedContent> {
    const ext = path.extname(fileName).toLowerCase();

    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      const result: ParsedContent = {
        source: fileName,
        type: 'plaintext',
        status: 'error',
        text: '',
        errorCode: 'UNSUPPORTED_FORMAT',
        warning: `不支持的文件格式：${ext}。当前支持 PDF、DOCX、MD、TXT。PPTX 等演示文稿格式暂不支持，请将内容导出为 PDF 后重新上传。`,
        parsedAt: new Date().toISOString(),
      };
      return result;
    }

    // 防重复：同一文件在同一对话中已解析过则直接返回
    const alreadyParsed = await hasAttachment(db, conversationId, fileName);
    if (alreadyParsed) {
      return {
        source: fileName,
        type: 'plaintext',
        status: 'success',
        text: '',
        warning: '该文件已在本次对话中导入，无需重复解析。',
        parsedAt: new Date().toISOString(),
      };
    }

    let result: ParsedContent;
    if (ext === '.pdf') {
      result = await parsePdf(filePath, fileName);
    } else if (ext === '.docx') {
      result = await parseDocx(filePath, fileName);
    } else if (ext === '.md') {
      result = await parsePlaintext(filePath, fileName, 'markdown');
    } else {
      result = await parsePlaintext(filePath, fileName, 'plaintext');
    }

    // 解析成功或部分成功时持久化到数据库
    if (result.status !== 'error') {
      await saveAttachment(db, conversationId, result);
    }

    return result;
  },
};
```

### 5.2 parse_url 工具

```typescript
// src/tools/parse-url.ts

import { parseUrl } from '../parsers/web';
import { saveAttachment, hasAttachment } from '../context/attachment-store';
import type { ParsedContent } from '../types/parsed-content';

export const parseUrlTool = {
  name: 'parse_url',

  description: `
抓取并解析指定 URL 的网页正文内容，注入当前会话上下文。
适用于文章、博客、文档、技术帖等以正文内容为主的静态渲染页面。

【调用时机 - 必须满足以下所有条件才可调用】
1. 用户本轮输入明确提供了一个 URL，并表达了"读取/分析/总结/导入这个链接内容"的意图；不得从 Agent `goal`、当前文档内容、块快照、文章路径或历史任务中提取 URL。
2. 该 URL 尚未在本次会话中被解析过（避免重复抓取）。
3. URL 指向的是网页内容（非文件下载链接，文件下载应用 parse_document）。

【严禁调用场景】
- 用户本轮输入未提供 URL 时。
- URL 已在本次会话中解析过。
- URL 明显指向文件下载（.pdf/.docx 等，应引导用户下载后上传）。
- 用户只是在对话中提及某网址作为参考，没有明确要求导入其内容。
  `.trim(),

  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '需要抓取的完整 URL，须包含协议头（https://）',
      },
    },
    required: ['url'],
  },

  async execute({
    url,
    conversationId,
    db,
  }: {
    url: string;
    conversationId: string;
    db: Database;
  }): Promise<ParsedContent> {
    // 防重复：同一 URL 在同一对话中已抓取过则直接返回
    const alreadyParsed = await hasAttachment(db, conversationId, url);
    if (alreadyParsed) {
      return {
        source: url,
        type: 'webpage',
        status: 'success',
        text: '',
        warning: '该链接已在本次对话中导入，无需重复抓取。',
        parsedAt: new Date().toISOString(),
      };
    }

    const result = await parseUrl(url);

    if (result.status !== 'error') {
      await saveAttachment(db, conversationId, result);
    }

    return result;
  },
};
```

---

## 六、会话上下文管理

### 6.1 设计原则

对话是持久化的，解析内容的生命周期必须与对话绑定，不能依赖进程内存。

**存储方案：复用现有 `messages` 表，新增 `parsed_attachment` 消息类型。**

不引入新表，解析内容以 `role = 'system'`、`type = 'parsed_attachment'` 的消息记录写入 `messages` 表，与普通对话消息共存。每次构建 LLM 上下文时，先从数据库加载该对话下所有附件记录，拼入 system prompt，再追加本轮消息。对话删除时，附件记录随之级联删除，无需额外维护。

### 6.2 数据库写入（保存解析内容）

```typescript
// src/context/attachment-store.ts

import type { ParsedContent } from '../types/parsed-content';

/**
 * 将解析成功的内容持久化到 messages 表。
 *
 * 写入字段：
 *   - conversation_id : 当前对话 ID
 *   - role            : 'system'
 *   - type            : 'parsed_attachment'
 *   - content         : 解析出的纯文本正文
 *   - meta            : JSON 字符串，保存来源标识、类型、页数、状态、警告、时间戳
 *
 * 注意：content 存纯文本，不存原始文件二进制。
 * 原始文件（PDF/DOCX）由上传模块负责存储，此处不处理。
 */
export async function saveAttachment(
  db: Database,                // 现有 db 实例，类型参照项目实际定义
  conversationId: string,
  content: ParsedContent,
): Promise<void> {
  // 幂等：同一 source 在同一对话中只写一次
  const existing = await db.get(
    `SELECT id FROM messages
     WHERE conversation_id = ? AND type = 'parsed_attachment'
       AND json_extract(meta, '$.source') = ?`,
    [conversationId, content.source],
  );
  if (existing) return;

  await db.run(
    `INSERT INTO messages (conversation_id, role, type, content, meta, created_at)
     VALUES (?, 'system', 'parsed_attachment', ?, ?, ?)`,
    [
      conversationId,
      content.text,
      JSON.stringify({
        source:      content.source,
        contentType: content.type,
        pageCount:   content.pageCount ?? null,
        status:      content.status,
        warning:     content.warning ?? null,
        parsedAt:    content.parsedAt,
      }),
      new Date().toISOString(),
    ],
  );
}
```

### 6.3 数据库读取（加载已有附件）

```typescript
// src/context/attachment-store.ts（续）

export interface AttachmentRecord {
  source:      string;
  contentType: ParsedContent['type'];
  pageCount:   number | null;
  status:      string;
  warning:     string | null;
  parsedAt:    string;
  text:        string;   // 来自 messages.content
}

/**
 * 加载某对话下所有已持久化的解析附件，按写入时间升序排列。
 * 在每次构建 LLM 上下文前调用。
 */
export async function loadAttachments(
  db: Database,
  conversationId: string,
): Promise<AttachmentRecord[]> {
  const rows = await db.all(
    `SELECT content, meta FROM messages
     WHERE conversation_id = ? AND type = 'parsed_attachment'
     ORDER BY created_at ASC`,
    [conversationId],
  );

  return rows.map((row) => {
    const meta = JSON.parse(row.meta);
    return {
      source:      meta.source,
      contentType: meta.contentType,
      pageCount:   meta.pageCount,
      status:      meta.status,
      warning:     meta.warning,
      parsedAt:    meta.parsedAt,
      text:        row.content,
    };
  });
}

/**
 * 检查某 source 是否已在该对话中解析过，用于工具层防重复调用判断。
 */
export async function hasAttachment(
  db: Database,
  conversationId: string,
  source: string,
): Promise<boolean> {
  const row = await db.get(
    `SELECT id FROM messages
     WHERE conversation_id = ? AND type = 'parsed_attachment'
       AND json_extract(meta, '$.source') = ?`,
    [conversationId, source],
  );
  return !!row;
}
```

### 6.4 格式化为 LLM system prompt 块

```typescript
// src/context/attachment-store.ts（续）

const TYPE_LABEL: Record<ParsedContent['type'], string> = {
  pdf:       'PDF 文档',
  docx:      'Word 文档',
  markdown:  'Markdown 文件',
  plaintext: '文本文件',
  webpage:   '网页',
};

/**
 * 将附件列表格式化为可注入 system prompt 的字符串块。
 * 超长内容按 maxCharsPerSource 截断，避免超出 context window。
 * 多个来源累加超出总预算时，保留最新导入的（列表末尾优先）。
 */
export function formatAttachmentsForPrompt(
  attachments: AttachmentRecord[],
  maxCharsPerSource = 12_000,
): string {
  if (attachments.length === 0) return '';

  const blocks = attachments.map((item) => {
    const label = TYPE_LABEL[item.contentType] ?? '文件';
    const truncated =
      item.text.length > maxCharsPerSource
        ? item.text.slice(0, maxCharsPerSource) +
          `\n\n[...内容已截断，原文共 ${item.text.length} 字符]`
        : item.text;
    const warningNote = item.warning ? `\n> ⚠️ ${item.warning}` : '';

    return [
      `## 已导入${label}：${item.source}`,
      warningNote,
      '',
      truncated,
    ].join('\n');
  });

  return [
    '---',
    '# 本次对话已导入的文档/网页内容',
    '（以下内容由用户主动导入，在本次对话中持续有效，可直接引用）',
    '',
    ...blocks,
    '---',
  ].join('\n');
}

---

## 七、工具注册

```typescript
// src/tools/index.ts

import { parseDocumentTool } from './parse-document';
import { parseUrlTool } from './parse-url';

export const NOTUS_TOOLS = [parseDocumentTool, parseUrlTool] as const;

export type NotusToolName = (typeof NOTUS_TOOLS)[number]['name'];
```

---

## 八、Agent 调用时机与决策树

### 8.1 parse_document 调用决策树

```
用户发送消息
    │
    ├─ 消息中包含文件附件？
    │       │
    │       ├─ 否 ──→ 不调用 parse_document
    │       │
    │       └─ 是
    │               │
    │               ├─ 该文件已在 session context 中？
    │               │       │
    │               │       └─ 是 ──→ 不重复解析，直接使用已有上下文
    │               │
    │               ├─ 文件格式在支持列表中？
    │               │       │
    │               │       └─ 否 ──→ 告知用户支持格式，不调用工具
    │               │
    │               └─ 用户意图是读取/分析文件内容？
    │                       │
    │                       ├─ 是 ──→ 调用 parse_document
    │                       │
    │                       └─ 否（如：用户只是上传作为备份）
    │                               └─ 询问用户是否需要读取内容
```

### 8.2 parse_url 调用决策树

```
用户发送消息（仅检查本轮 user_query/input_text/display_query，不检查 Agent goal 或当前文档快照）
    │
    ├─ 消息中包含 URL？
    │       │
    │       └─ 否 ──→ 不调用 parse_url
    │
    ├─ 该 URL 已在 session context 中？
    │       │
    │       └─ 是 ──→ 不重复抓取，告知用户"已导入该页面内容"
    │
    ├─ URL 指向可下载文件（.pdf/.docx 等）？
    │       │
    │       └─ 是 ──→ 提示用户下载后上传，不调用 parse_url
    │
    └─ 用户意图是"读取/分析/导入该链接内容"？
            │
            ├─ 是 ──→ 调用 parse_url
            │
            └─ 否（URL 只是随口提及、作为参考）
                    └─ 不调用，按普通对话处理
```

### 8.3 Agent 响应模板

**解析成功**：
```
已成功读取 [文件名/URL]（[类型]，[页数/字数]）。内容已加入本次对话上下文，
你可以直接问我关于这份文档/网页的任何问题。
```

**图片 PDF**：
```
这份 PDF 是扫描件或图片 PDF，没有可提取的文字层，Notus 目前不支持 OCR。
如果需要导入，可以先用 Adobe Acrobat 或在线工具将其转为"可搜索 PDF"后重新上传。
```

**CSR 页面**：
```
这个页面由 JavaScript 动态渲染，无法直接抓取内容。
如果需要导入其中的文字，可以在浏览器中选中内容后复制，然后粘贴到对话框中。
```

**部分成功（字体问题）**：
```
已读取 [文件名]，但文档使用了非标准字体编码，部分文字可能显示异常。
内容已加入上下文，如发现文字乱码，可能需要重新导出该 PDF。
```

---

## 九、上下文注入到 LLM 的方式

每轮对话构建 system prompt 时，先从数据库加载该对话下所有附件，格式化后追加到 system prompt 尾部：

```typescript
// 伪代码，具体位置取决于现有对话管理器实现
// 对应项目中构建 LLM messages 的位置（参考现有 buildSystemPrompt 或同等逻辑）

import { loadAttachments, formatAttachmentsForPrompt } from '../context/attachment-store';

async function buildSystemPrompt(
  basePrompt: string,
  conversationId: string,
  db: Database,
): Promise<string> {
  const attachments = await loadAttachments(db, conversationId);
  const contextBlock = formatAttachmentsForPrompt(attachments);
  if (!contextBlock) return basePrompt;
  return `${basePrompt}\n\n${contextBlock}`;
}
```

**关键约束**：
- `maxCharsPerSource` 默认 12,000 字符，可根据实际 context window 大小调整。
- 多个来源累加后若超出总 token 预算，`formatAttachmentsForPrompt` 已按导入时间升序排列，裁剪时从头部（最早导入的）截断，保留最新导入的内容。
- 附件记录随对话级联删除，无需额外清理逻辑。
- `loadAttachments` 每轮都会查一次数据库，若性能敏感可在请求生命周期内缓存结果（同一请求只查一次）。

---

## 十、错误处理总则

| errorCode | Agent 行为 |
|---|---|
| `IMAGE_PDF` | 告知用户为图片 PDF，说明解决方案，不进入上下文 |
| `GARBLED_TEXT` | 警告用户可能有乱码，内容仍进入上下文（status: partial） |
| `FETCH_FAILED` | 告知网络错误，建议检查链接是否可访问 |
| `CSR_PAGE` | 告知动态渲染限制，建议手动复制粘贴 |
| `PARSE_FAILED` | 告知解析失败，建议重新上传或换用其他格式 |
| `UNSUPPORTED_FORMAT` | 告知支持的格式列表 |
| `EMPTY_CONTENT` | 告知文件/页面内容为空 |

所有 `status: 'error'` 的内容均不写入数据库，避免空内容污染上下文。

---

## 十一、注意事项

1. **DOCX 不依赖 LibreOffice**：mammoth 是纯 JS 实现，直接解析 OOXML，无需任何系统依赖。
2. **LiteParse OCR 关闭**：Notus 明确不支持图片 PDF 的 OCR，`ocrEnabled: false` 是有意为之，检测到图片 PDF 后直接告知用户，不做降级处理。
3. **PPTX 明确不支持**：演示文稿上传应在前端文件选择器层面拦截（限制 accept 属性），不允许上传 `.pptx`、`.ppt` 文件，后端 `parse_document` 工具遇到时返回 `UNSUPPORTED_FORMAT`。
4. **cheerio 的角色**：仅作为 Readability 失败后的 fallback，以及 CSR 检测的辅助工具，不是主要解析器。
5. **附件存储不依赖内存单例**：解析内容通过 `saveAttachment` 写入 `messages` 表，进程重启或页面刷新后对话重新打开，`loadAttachments` 从数据库还原，不会丢失。原有的 `session-context.ts` 文件可以删除。
6. **文件安全**：`filePath` 来源必须是服务器端文件上传模块提供的受控路径，禁止直接接受用户输入的任意路径，防止路径遍历攻击。

---

## 十二、数据库 Schema 适配

`messages` 表需要支持 `type` 字段和 `meta` 字段。如果现有表结构中这两个字段已存在（参考 `agent_run_logs` 的 `tool_result` 和 `agent_sessions` 的 `messages_checkpoint` 的存储方式），则无需迁移，直接复用。

**确认步骤（Codex 执行前先检查）**：

```sql
-- 查看现有 messages 表结构
PRAGMA table_info(messages);
```

**若 `type` 或 `meta` 字段不存在，执行以下迁移**：

```sql
-- Migration: add type and meta fields to messages table
ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN meta TEXT;

-- 为附件查询加索引，避免全表扫描
CREATE INDEX IF NOT EXISTS idx_messages_attachment
  ON messages (conversation_id, type)
  WHERE type = 'parsed_attachment';
```

**级联删除确认**：

```sql
-- 确认 messages 表的外键级联删除已启用
-- 若 conversation 删除时 messages 不自动删除，需补充：
-- FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
-- 并确保连接时启用：PRAGMA foreign_keys = ON;
```

迁移文件放置位置与现有其他迁移文件保持一致（参考项目中 `db.js` 或同等初始化文件的 migration 执行方式）。
