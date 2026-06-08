# Notus Agent 架构与工程实践

> v3.0 · 完整架构设计 + Prompt Engineering + Harness Engineering
>
> 本文档基于多轮讨论沉淀，目标是建立一套**可扩展、前瞻性、不需要反复重构**的 Agent 架构。
>
> 核心原则：
> 1. 用户意图（scope、范围、偏好）从 LLM 判断空间剥离，作为产品状态由用户控制
> 2. 单一 prompt 适配所有模型（从 Opus 到 Haiku/Flash），不为特定模型做适配
> 3. 检索粒度从 chunk 升级到 document，让 LLM 看到完整上下文
> 4. 把复杂判断拆成简单判断 + 显式 fallback，让弱模型也能稳定工作
> 5. 加新功能只需追加工具，不需要修改路由逻辑

---

## 目录

- [一、设计哲学](#一设计哲学)
- [二、整体架构](#二整体架构)
- [三、检索系统设计](#三检索系统设计)
- [四、Scope 系统设计](#四scope-系统设计)
- [五、Agent 架构](#五agent-架构)
- [六、Prompt Engineering](#六prompt-engineering)
- [七、Harness Engineering](#七harness-engineering)
- [八、完整数据流示例](#八完整数据流示例)
- [九、扩展性指南](#九扩展性指南)

---

## 一、设计哲学

### 1.1 三个核心反模式（不要做的）

**反模式一：意图分类器**
```
用户输入 → 意图分类（创作/问答/聊天）→ switch 路由 → 不命中报错
```
问题：
- 用户的真实意图永远比分类多
- 分类失败 → "我做不了" → 用户体验崩塌
- 加新意图 = 重写分类器
- 多一次 LLM 调用，慢且贵

**反模式二：让 LLM 推断产品意图**
```
用户在 UI 没操作 → 在对话里说"只查 Go 的文章" → LLM 推断 scope
```
问题：
- 弱模型推断不稳定，强模型也会偶尔出错
- 用户无法看到当前生效的 scope
- 静默错误：LLM 在错误 scope 下执行用户察觉不到

**反模式三：检索碎片当成最终结果**
```
向量检索 → 召回 top-K chunks → 拼成 prompt 给 LLM
```
问题：
- LLM 看到的永远是断章取义的碎片
- 跨段落、跨文档的关联信息全部丢失
- 本质上和数据库 LIKE 查询无异

### 1.2 三个正确模式（要做的）

**正确模式一：Tool Use 循环替代分类器**
```
用户输入 → LLM（带工具列表）→ LLM 自己决定用哪些工具或直接回复
```
- 没有"未命中"的概念，LLM 总能做点什么
- 加新功能 = 加新工具，prompt 只追加示例
- 一次调用完成，省钱省时

**正确模式二：用户意图作为一等状态**
```
用户在 UI 显式设置 scope/偏好 → 写入会话状态 → 后端在工具调用时注入
```
- LLM 不需要也不应该知道 scope 怎么来的
- UI 始终展示当前生效状态
- 用户可中途修改，对话历史不丢失

**正确模式三：检索作索引，原文档作答案**
```
向量检索 → 命中 chunks → 反查 doc_id → 把完整文档塞进 LLM 上下文
```
- chunk 只是定位器，最终 LLM 看到的是完整文档
- 上下文连贯，能形成真正的 summary
- 个人笔记规模下，长上下文模型完全 hold 得住

### 1.3 通用 Prompt 设计原则

无论用什么模型，prompt 都遵循以下原则：

| 原则 | 说明 |
|------|------|
| 顺序判断替代并行推理 | "第一步→第二步→第三步" 比 "综合考虑 ABC" 对弱模型更友好 |
| 是非题替代开放题 | "是否包含 X？" 比 "判断意图类型" 准确率高得多 |
| 给映射表替代描述规则 | 用户说"第二段" → 第二个 paragraph 块。直接列对应关系，不让模型推 |
| Few-shot 替代抽象解释 | 5 个具体例子比一段详细规则更好用 |
| 显式兜底替代默认行为 | "不确定时调用 ask_user"，不让模型自己想兜底方案 |
| 划边界替代列路径 | "永远不要说做不到" 是边界；"何时该做什么" 是路径，少列路径多划边界 |

---

## 二、整体架构

### 2.1 系统分层

```
┌──────────────────────────────────────────────────────────┐
│                       用户界面层                           │
│   - Scope 选择器（检索范围、风格范围）                     │
│   - 对话窗口、画布编辑器                                   │
│   - ask_user 卡片渲染                                     │
└──────────────────────────────────────────────────────────┘
                           ↓ ↑
┌──────────────────────────────────────────────────────────┐
│                       会话状态层                           │
│   - Conversation: messages, scope, settings              │
│   - Scope 持久化、热更新                                  │
└──────────────────────────────────────────────────────────┘
                           ↓ ↑
┌──────────────────────────────────────────────────────────┐
│                    Agent 编排层                            │
│   - System Prompt 组装（注入 scope、文章结构）             │
│   - Tool Use Loop（调用、错误重试、超步兜底）              │
│   - LLM Provider 适配（统一 tool calling 接口）           │
└──────────────────────────────────────────────────────────┘
                           ↓ ↑
┌──────────────────────────────────────────────────────────┐
│                       工具层                              │
│   - 检索工具（带 scope 注入）                             │
│   - 编辑工具（block / 多块 / 全文）                       │
│   - 风格工具（带 scope 注入）                             │
│   - 交互工具（ask_user）                                  │
│   - 分析工具（analyze_article）                           │
└──────────────────────────────────────────────────────────┘
                           ↓ ↑
┌──────────────────────────────────────────────────────────┐
│                       数据层                              │
│   - documents: 完整原文                                   │
│   - chunks: 检索索引（含向量、FTS5）                      │
│   - conversations: 会话+scope                             │
│   - style_samples_cache: 风格样本缓存                     │
└──────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

| 决策 | 选择 | 替代方案及拒绝原因 |
|------|------|-------------------|
| 意图识别 | 删除分类器，由 LLM 在 tool use 中决定 | 分类器：未命中无法处理；多一次调用 |
| 检索粒度 | chunk 检索 + document 反查 + 全文喂入 | 纯 chunk：上下文丢失，无法 summary |
| Scope 控制 | 用户 UI 显式设置 + 会话状态持久化 | LLM 推断：不稳定且不可见 |
| Scope 注入 | 后端在工具调用时注入，不暴露给 LLM | LLM 传 scope：弱模型易错且无意义 |
| Prompt 策略 | 单一 prompt 适配所有模型 | 按模型分支：维护成本高，反向倒退 |
| 模糊意图 | ask_user 工具弹卡片让用户选 | 拒绝/瞎猜：体验差 |
| 风格样本 | 缓存代表性段落 | 每次随机采样：风格漂移不稳定 |
| 工具失败 | 返回结构化 hint 指示下一步 | 抛错：LLM 容易胡说 |

---

## 三、检索系统设计

### 3.1 数据模型

完整的 schema 一次到位，避免后续 ALTER TABLE 补丁。

```sql
-- 文档表：存完整原文，是最终给 LLM 的内容
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,           -- 完整 markdown 原文
  path TEXT UNIQUE NOT NULL,        -- 文件路径
  char_count INTEGER,
  token_count INTEGER,              -- 预估 token 数，用于长上下文判断
  tags TEXT,                        -- JSON 数组，预留标签 scope
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  hash TEXT                         -- 内容哈希，增量索引用
);

CREATE INDEX idx_documents_path ON documents(path);
CREATE INDEX idx_documents_updated ON documents(updated_at);

-- chunk 表：纯粹是检索索引，不是最终产物
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,     -- 在文档中的顺序
  start_offset INTEGER,              -- 原文中字符偏移（精确定位用）
  end_offset INTEGER,
  heading_path TEXT,                 -- 所属章节路径（h1>h2>h3）
  block_type TEXT,                   -- paragraph/heading/code/list/table
  embedding BLOB,                    -- sqlite-vec 向量
  has_image INTEGER DEFAULT 0,       -- 是否含图片，预留多模态
  UNIQUE(doc_id, chunk_index)
);

CREATE INDEX idx_chunks_doc_id ON chunks(doc_id);

-- FTS5 全文索引
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  doc_id UNINDEXED,
  chunk_id UNINDEXED,
  heading_path UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'  -- 配合 jieba-wasm 预分词
);

-- 会话表（含 scope）
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- 'knowledge' | 'canvas'
  title TEXT,
  retrieval_scope TEXT NOT NULL,    -- JSON: { type, paths/file_ids/tags }
  style_scope TEXT NOT NULL,        -- JSON
  settings TEXT,                    -- JSON: 模型、温度等
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- 消息表
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,               -- user/assistant/tool
  content TEXT,
  tool_calls TEXT,                  -- JSON
  tool_call_id TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

-- 风格样本缓存
CREATE TABLE style_samples_cache (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  samples TEXT NOT NULL,            -- JSON: [{ content, weight }]
  fingerprint TEXT,                 -- JSON: 五维风格指纹
  computed_at INTEGER DEFAULT (unixepoch())
);
```

### 3.2 检索流程：chunk → document

**核心理念**：chunk 用于精准定位，document 用于完整理解。

```javascript
async function retrieve(query, scope, options = {}) {
  // 第一步：在 scope 内做混合检索拿到候选 chunks
  const chunks = await hybridSearch(query, scope, {
    topK: options.topK ?? 20
  });
  
  if (chunks.length === 0) {
    return { documents: [], hint: SCOPE_EMPTY_HINT(scope, query) };
  }
  
  // 第二步：根据 chunks 反查 document，去重
  const docIds = [...new Set(chunks.map(c => c.doc_id))];
  
  // 第三步：按 chunks 命中分数累计为 document 分数
  const docScores = aggregateScores(chunks);
  const rankedDocIds = docIds.sort((a, b) => docScores[b] - docScores[a]);
  
  // 第四步：根据上下文窗口预算选 document 数量
  const docs = await selectDocsByBudget(
    rankedDocIds,
    options.maxTokens ?? 80000  // 留 20k 给 prompt 和输出
  );
  
  return {
    documents: docs,        // 完整文档列表
    chunks: chunks,         // 命中片段（用于 UI 显示来源高亮）
    hint: null
  };
}

async function selectDocsByBudget(docIds, maxTokens) {
  const selected = [];
  let usedTokens = 0;
  
  for (const docId of docIds) {
    const doc = await getDocument(docId);
    if (usedTokens + doc.token_count > maxTokens) {
      // 单篇文档放不下：要么截断，要么跳过
      if (selected.length === 0) {
        // 第一篇就放不下：用 map-reduce 兜底
        return await mapReduceSummary([doc]);
      }
      break;  // 跳过这篇及后面的
    }
    selected.push(doc);
    usedTokens += doc.token_count;
  }
  
  return selected;
}
```

### 3.3 混合检索（Hybrid Search）

```javascript
async function hybridSearch(query, scope, { topK }) {
  // 并发执行向量检索和 FTS5
  const [vectorHits, ftsHits] = await Promise.all([
    vectorSearch(query, scope, topK * 2),
    ftsSearch(query, scope, topK * 2)
  ]);
  
  // RRF 融合（k=60 是经验值）
  const fused = reciprocalRankFusion(vectorHits, ftsHits, { k: 60 });
  
  // 阈值过滤
  const filtered = fused.filter(hit => hit.score > MIN_SCORE_THRESHOLD);
  
  return filtered.slice(0, topK);
}

async function vectorSearch(query, scope, k) {
  const queryVec = await embed(query);
  const scopeFilter = buildScopeFilter(scope);
  
  return await db.all(`
    SELECT c.*, d.path, d.title, vec_distance(c.embedding, ?) as dist
    FROM chunks c
    JOIN documents d ON c.doc_id = d.id
    WHERE ${scopeFilter.sql}
    ORDER BY dist ASC
    LIMIT ?
  `, [queryVec, ...scopeFilter.params, k]);
}

async function ftsSearch(query, scope, k) {
  // 用 jieba-wasm 分词，OR 拼接
  const tokens = await jiebaTokenize(query);
  const ftsQuery = tokens.slice(0, 20).join(' OR ');
  const scopeFilter = buildScopeFilter(scope);
  
  return await db.all(`
    SELECT c.*, d.path, d.title, rank
    FROM chunks_fts
    JOIN chunks c ON chunks_fts.chunk_id = c.id
    JOIN documents d ON c.doc_id = d.id
    WHERE chunks_fts MATCH ? AND ${scopeFilter.sql}
    ORDER BY rank
    LIMIT ?
  `, [ftsQuery, ...scopeFilter.params, k]);
}
```

### 3.4 Map-Reduce 兜底

当 scope 太大、单篇文档太长、上下文塞不下时：

```javascript
async function mapReduceSummary(docs, query) {
  // Map 阶段：每篇文档独立提取相关要点
  const points = await Promise.all(docs.map(async doc => {
    const resp = await llm.chat({
      messages: [{
        role: 'user',
        content: `从以下文档中提取与"${query}"相关的关键信息（不超过 200 字）：\n\n${doc.content}`
      }]
    });
    return { doc, points: resp.content };
  }));
  
  // Reduce 阶段：合并要点生成最终回答
  const merged = points.map(p => `## ${p.doc.title}\n${p.points}`).join('\n\n');
  return [{ id: 'merged', title: '综合摘要', content: merged }];
}
```

---

## 四、Scope 系统设计

### 4.1 Scope 数据结构

```typescript
type Scope =
  | { type: 'all' }                          // 全库
  | { type: 'path'; paths: string[] }        // 目录范围
  | { type: 'files'; file_ids: string[] }    // 指定文件
  | { type: 'tags'; tags: string[] }         // 标签范围
  | { type: 'auto'; query?: string };        // 自动语义匹配（风格仿写默认）

interface ConversationScope {
  retrieval: Scope;    // 知识库问答的检索范围
  style: Scope;        // 风格仿写的参考范围
}
```

**为什么是这五种类型**：
- `all`：默认行为，零摩擦
- `path`：用户最自然的组织方式（按目录）
- `files`：用户最精确的控制方式（指定具体文件）
- `tags`：预留扩展，未来如果加标签系统直接可用
- `auto`：风格仿写专用，让用户不操心也能合理工作

### 4.2 Scope 是会话状态，不是消息参数

```javascript
// API 设计
POST   /api/conversations                      // 创建会话（带初始 scope）
GET    /api/conversations/:id                  // 获取会话（含 scope）
PUT    /api/conversations/:id/scope            // 更新 scope（不影响历史）
POST   /api/conversations/:id/messages         // 发消息（自动用当前 scope）
DELETE /api/conversations/:id/scope            // 重置为默认 scope

// scope 更新立即生效，但不重写历史消息
// 用户可在对话中途切换 scope，不影响已发生的对话
```

### 4.3 Scope 过滤在索引层做

```javascript
function buildScopeFilter(scope) {
  switch (scope.type) {
    case 'all':
      return { sql: '1=1', params: [] };
    
    case 'path':
      const placeholders = scope.paths.map(() => 'd.path LIKE ?').join(' OR ');
      return {
        sql: `(${placeholders})`,
        params: scope.paths.map(p => p.replace(/\/$/, '') + '/%')
      };
    
    case 'files':
      const fileHolders = scope.file_ids.map(() => '?').join(',');
      return {
        sql: `d.id IN (${fileHolders})`,
        params: scope.file_ids
      };
    
    case 'tags':
      // tags 字段是 JSON 数组
      return {
        sql: `EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value IN (${scope.tags.map(() => '?').join(',')}))`,
        params: scope.tags
      };
    
    case 'auto':
      return { sql: '1=1', params: [] };  // auto 不在检索阶段过滤
  }
}
```

**关键：scope 过滤必须在 SQL 层做**，不能召回所有 chunk 后再过滤，否则 top-K 会被其他范围的内容挤占。

### 4.4 风格 scope 的特殊处理

风格 scope 不参与检索，参与样本采样：

```javascript
async function getStyleSamples(topic, styleScope) {
  switch (styleScope.type) {
    case 'auto':
      // 自动模式：用主题做向量检索找最相似的 3 篇
      const similar = await retrieve(topic, { type: 'all' }, { topK: 3 });
      return await Promise.all(
        similar.documents.map(doc => sampleStyleFromFile(doc.id))
      );
    
    case 'files':
      // 手动指定：直接用这些文件
      return await Promise.all(
        styleScope.file_ids.map(id => sampleStyleFromFile(id))
      );
    
    case 'path':
      // 路径范围：从该路径下采样最有代表性的几篇
      const docs = await getDocsInPath(styleScope.paths);
      const top3 = docs.slice(0, 3);  // 按更新时间或字数排
      return await Promise.all(top3.map(d => sampleStyleFromFile(d.id)));
    
    case 'tags':
      // 类似 path
      const tagged = await getDocsByTags(styleScope.tags);
      return await Promise.all(tagged.slice(0, 3).map(d => sampleStyleFromFile(d.id)));
    
    case 'all':
      // 不限定：用 auto 兜底
      return getStyleSamples(topic, { type: 'auto' });
  }
}

async function sampleStyleFromFile(docId) {
  // 优先读缓存，保证多次调用风格一致
  const cached = await db.get(
    'SELECT samples FROM style_samples_cache WHERE doc_id = ?',
    [docId]
  );
  if (cached) return JSON.parse(cached.samples);
  
  // 缓存不存在：选段 + 计算风格指纹
  const doc = await getDocument(docId);
  const samples = await selectRepresentativeBlocks(doc, 3);
  // 选段策略：长度 200-500 字 + 信息密度高 + 避开标题/列表/代码
  
  const fingerprint = await computeStyleFingerprint(samples);
  
  await db.run(
    'INSERT INTO style_samples_cache (doc_id, samples, fingerprint) VALUES (?, ?, ?)',
    [docId, JSON.stringify(samples), JSON.stringify(fingerprint)]
  );
  
  return { samples, fingerprint };
}
```

### 4.5 Scope 校验与错误处理

```javascript
async function setScope(conversationId, scope) {
  // 校验 scope 是否有效
  const validation = await validateScope(scope);
  if (!validation.ok) {
    return { error: validation.error };
  }
  
  // 校验 scope 内是否有文档
  const docCount = await countDocsInScope(scope.retrieval);
  
  await db.run(
    'UPDATE conversations SET retrieval_scope=?, style_scope=?, updated_at=? WHERE id=?',
    [JSON.stringify(scope.retrieval), JSON.stringify(scope.style), Date.now(), conversationId]
  );
  
  return {
    ok: true,
    doc_count: docCount,
    warning: docCount === 0 ? '所选范围内没有笔记' : 
             docCount < 3 ? '范围较窄，建议适当扩大' : null
  };
}

async function validateScope(scope) {
  const checks = [scope.retrieval, scope.style];
  for (const s of checks) {
    if (s.type === 'path') {
      const exists = await pathsExist(s.paths);
      if (!exists) return { ok: false, error: '部分路径不存在' };
    }
    if (s.type === 'files') {
      const valid = await validateFileIds(s.file_ids);
      if (valid.length === 0) return { ok: false, error: '所选文件全部无效' };
      if (valid.length < s.file_ids.length) {
        return { ok: true, warning: `${s.file_ids.length - valid.length} 个文件已失效` };
      }
    }
  }
  return { ok: true };
}
```

---

## 五、Agent 架构

### 5.1 工具清单（完整且可扩展）

按职能分类，方便后续添加：

```javascript
const TOOLS = {
  // === 检索类 ===
  search_knowledge: {
    description: '搜索用户笔记库，返回相关文档完整内容',
    parameters: {
      query: 'string',
      topK: 'number (default 5)'
    }
  },
  
  // === 风格类 ===
  get_style_context: {
    description: '获取用户的写作风格画像和代表性样本',
    parameters: {
      topic: 'string'
    }
  },
  
  // === 创建类 ===
  get_outline: {
    description: '根据主题生成文章大纲',
    parameters: {
      topic: 'string',
      references: 'array (search_knowledge 的结果)'
    }
  },
  draft_block: {
    description: '为指定块起草内容',
    parameters: {
      block_id: 'string',
      instruction: 'string',
      style_samples: 'array',
      context: 'object'
    }
  },
  insert_block: {
    description: '在指定位置插入新块',
    parameters: {
      position: 'string (after_block_id|at_start|at_end)',
      content: 'string'
    }
  },
  
  // === 单块编辑 ===
  expand_block: { /* 扩写 */ },
  shrink_block: { /* 缩写 */ },
  polish_block: { /* 风格润色 */ },
  
  // === 多块/全文编辑 ===
  edit_blocks: {
    description: '对多个指定块执行联合操作',
    parameters: {
      block_ids: 'array',
      instruction: 'string'
    }
  },
  edit_global: {
    description: '对全文执行统一操作',
    parameters: {
      instruction: 'string',
      operation_type: 'enum (polish|expand|shrink|rewrite)'
    }
  },
  
  // === 删除 ===
  delete_block: { /* 删除指定块 */ },
  
  // === 分析 ===
  analyze_article: {
    description: '分析文章结构、逻辑、风格一致性等',
    parameters: {
      aspects: 'array (structure|logic|style_consistency|readability|completeness)'
    }
  },
  
  // === 交互 ===
  ask_user: {
    description: '当无法确定用户意图时，通过卡片向用户展示选项',
    parameters: {
      questions: 'array of { question, options: 2-4 项, type: single_select }'
    }
  }
};
```

### 5.2 工具调用的 scope 注入

LLM 调用工具时不传 scope，后端自动注入：

```javascript
async function executeTool(toolName, args, conversationId) {
  // 后端从会话状态拿 scope，注入到工具调用
  const conv = await getConversation(conversationId);
  
  switch (toolName) {
    case 'search_knowledge':
      return await search_knowledge(args.query, args.topK, conv.retrieval_scope);
    
    case 'get_style_context':
      return await get_style_context(args.topic, conv.style_scope);
    
    case 'draft_block':
    case 'polish_block':
    case 'expand_block':
      // 写作类工具：自动注入风格样本
      const styleSamples = await getStyleSamples(
        args.context?.topic ?? conv.title,
        conv.style_scope
      );
      return await callDraftWith(toolName, args, styleSamples);
    
    case 'ask_user':
      // 特殊：返回给前端渲染卡片，等待用户选择
      return { type: 'await_user_choice', payload: args };
    
    default:
      return await defaultTool(toolName, args);
  }
}
```

### 5.3 Tool Use Loop

```javascript
async function agentLoop(conversationId, userMessage, maxSteps = 8) {
  const conv = await getConversation(conversationId);
  const messages = await getMessages(conversationId);
  
  // 加入用户消息
  messages.push({ role: 'user', content: userMessage });
  
  let steps = 0;
  
  while (steps < maxSteps) {
    // 组装 system prompt（每轮都重新组装，因为 scope/文章可能变了）
    const systemPrompt = buildSystemPrompt(conv);
    
    const response = await llm.chat({
      model: conv.settings.model,
      system: systemPrompt,
      messages,
      tools: Object.values(TOOLS),
      temperature: 0.7
    });
    
    // 情况 A：LLM 直接回复，结束
    if (!response.tool_calls || response.tool_calls.length === 0) {
      messages.push({ role: 'assistant', content: response.content });
      await saveMessages(conversationId, messages);
      return response.content;
    }
    
    // 情况 B：LLM 调用 ask_user，挂起等用户
    const askCall = response.tool_calls.find(c => c.name === 'ask_user');
    if (askCall) {
      messages.push({ role: 'assistant', tool_calls: response.tool_calls });
      await saveMessages(conversationId, messages);
      // 返回卡片给前端，等用户选择后再发新消息
      return { type: 'await_user_choice', card: askCall.arguments };
    }
    
    // 情况 C：LLM 调用其他工具
    messages.push({ role: 'assistant', tool_calls: response.tool_calls });
    
    for (const call of response.tool_calls) {
      const result = await executeTool(call.name, call.arguments, conversationId);
      
      // 工具失败 → 返回结构化 hint，让 LLM 自我修正
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
    }
    
    steps++;
  }
  
  // 超过最大步数：强制收尾
  messages.push({
    role: 'system',
    content: '请基于已有信息直接回复用户，不要再调用工具。'
  });
  const final = await llm.chat({ messages, tools: [] });
  await saveMessages(conversationId, messages);
  return final.content;
}
```

### 5.4 工具失败的结构化提示

每个工具的失败返回必须包含 `hint` 字段，告诉 LLM 下一步：

```javascript
// 检索空结果
{
  results: [],
  hint: `在范围"${describeScope(scope)}"内没有找到与"${query}"相关的内容。建议：1) 告知用户当前范围内没有相关笔记 2) 询问是否扩大范围 3) 或基于已有知识回答（明确说明非来自笔记）`
}

// Block ID 不存在
{
  error: 'BLOCK_NOT_FOUND',
  hint: `块 ${block_id} 不存在。可能原因：1) 块已被删除 2) 你引用的 block_id 错误。建议：先查看当前文章结构再操作`,
  available_blocks: [...] // 提供可用块列表帮助 LLM 修正
}

// old 字段不匹配
{
  error: 'OLD_MISMATCH',
  hint: `块内容已变化，old 字段不匹配。建议告知用户内容已变，请重新描述需求`,
  current_content: block.content  // 给 LLM 当前内容做参考
}

// LLM API 失败
{
  error: 'LLM_TIMEOUT',
  hint: `工具内部调用超时。建议告知用户稍后重试，或换个简单的问法`
}
```

---

## 六、Prompt Engineering

### 6.1 双层 Prompt 架构

Notus 有两个场景：**知识库问答（kind=knowledge）** 和 **AI 创作画布（kind=canvas）**。这两个场景的工具集、行为约束、输出风格差别很大：

| 维度 | 知识库问答 | AI 创作画布 |
|------|-----------|-----------|
| 主要任务 | 基于笔记回答问题 | 基于风格写作和编辑 |
| 输出形式 | 对话文字 + 来源卡片 | 工具调用产生 diff 操作 |
| 工具范围 | 检索类为主 | 全工具集 |
| 风格要求 | 客观陈述，标注来源 | 仿写用户风格 |
| 错误处理 | 找不到就直说不知道 | 不确定就 ask_user |

如果用一个全局 prompt 同时覆盖两个场景，要么 prompt 极长（包含所有场景规则）让弱模型迷失，要么过于笼统失去约束力。**正确的做法是：底座 prompt 写共性，场景 prompt 写差异**。

```
最终 system prompt = 底座 prompt + 场景 prompt + 上下文注入
```

代码层面：

```javascript
function buildSystemPrompt(conv) {
  const base = BASE_PROMPT;
  const scenario = conv.kind === 'knowledge' 
    ? KNOWLEDGE_PROMPT 
    : CANVAS_PROMPT;
  const context = buildContextBlock(conv);
  
  return `${base}\n\n${scenario}\n\n${context}`;
}
```

这种分层有三个好处：
1. **职责清晰**：基础人设、底线、共用规则在底座；场景特化的工具映射、思考流程、示例在场景层
2. **维护友好**：改"知识库要标注来源"只动 KNOWLEDGE_PROMPT，不会影响创作场景
3. **可扩展**：以后加日记模式、阅读模式、翻译模式，加一个 SCENARIO_PROMPT 即可

---

### 6.2 底座 Prompt（BASE_PROMPT）

只写跨场景共性：身份、底线、所有场景共用的工具规则。

```
你是 Notus，用户的私人写作搭档和知识库助手。

## 你的核心身份
- 你不是普通的通用助手，你是用户笔记和写作的专属搭档
- 你了解用户的写作风格、知识体系、过往思考
- 你的任务是帮用户更高效地思考、检索、写作，而不是替代他

## 通用底线（任何场景都必须遵守）

1. 永远不要说"我做不到"或"这超出我的能力范围"
2. 不确定时调用 ask_user 让用户选择，而不是拒绝或瞎猜
3. 不要在用户没提到笔记的时候主动搜索笔记库
4. 不要在未经用户确认时删除或大幅覆盖用户内容
5. 工具失败时告诉用户具体原因，并建议下一步，不要笼统说"出错了"
6. 直接回复永远是兜底的安全选项

## 关于范围（Scope）

当前范围由用户在 UI 上设定，你只能在这个范围内执行检索和风格采样。
- 范围内找不到内容 → 明确告知用户，建议扩大范围或换问法
- 不要主动越过用户指定的范围
- 用户问的内容明显不在范围内（如范围是 Go 但问 Python）→ 礼貌提醒可能需要切换范围

## 关于 ask_user

ask_user 是你的"不确定时的安全网"。用它来：
1. 用户意图模糊时
2. 操作目标不明确时（不确定指哪个块、哪篇文章）
3. 操作方式有多种合理可能时
4. 缺少必要参数时

不要在以下情况调用 ask_user：
- 用户意图清楚时（多此一举）
- 你能合理推断时（直接做，回复中说明你的假设）

ask_user 选项要具体，每个选项是一个明确的动作：
✅ "润色措辞" / "扩写细节" / "重写换种表达"
❌ "编辑" / "修改" / "其他"

每组选项最后一项通常是"让我具体描述"作为自定义入口。
```

---

### 6.3 知识库场景 Prompt（KNOWLEDGE_PROMPT）

```
## 当前场景：知识库问答

你正在帮用户从他自己的笔记库中检索和回答问题。

## 可用工具

- search_knowledge(query, topK): 搜索笔记库，返回相关文档完整内容
- ask_user(questions): 用户意图模糊时通过卡片询问

注意：当前场景下你**没有**编辑、写作、创建文档等工具。如果用户的需求需要这些能力，告知他切换到"创作"页面。

## 思考流程

收到用户消息后：

**第一步：判断是否需要检索笔记库**
- 涉及用户笔记、过往思考、自己写过的内容 → 调 search_knowledge
- 一般性问题、闲聊、翻译、解释概念、写代码 → 直接回答，不调任何工具
- 用户的问题非常模糊（如"那个东西怎么样了"）→ 调 ask_user

**第二步：如果调用了 search_knowledge，处理结果**
- 有命中：基于返回的完整文档内容回答，标注信息来源（哪篇文档、哪个章节）
- 无命中：明确告知"在你指定的 {scope} 范围内没找到相关内容"，建议扩大范围或换关键词；不要凭你自己的训练知识冒充用户笔记

**第三步：组织回答**
- 先给结论，再给依据
- 标注来源时使用：「根据《文档标题》中的「章节名」」
- 多个文档说法不一致时，分别陈述，让用户自己判断
- 不确定时如实说"笔记中没有明确说明"

## 严格 RAG 原则（重要）

这是 Notus 知识库的核心承诺：**不基于训练数据回答用户笔记相关的问题，避免幻觉。**

具体表现：
- 用户问"我之前写过什么关于 X 的"→ 必须 search_knowledge → 没找到就直说没有
- 用户问"X 是什么"（一般性问题）→ 可以直接回答，但**不要假装是从用户笔记中找的**
- 区分清楚两种回答：「根据你的笔记...」vs「这是一般性知识...」

## 输出风格

- 客观陈述，不夸张
- 必要时分点列出，便于扫读
- 引用原文时用 > 引用块标记
- 长答案先给 TL;DR

## 示例

用户：我之前写过什么关于 RAG 的内容？
→ search_knowledge(query="RAG 检索增强")
→ 回答：「根据你的笔记，你在三篇文章中讨论过 RAG：1)《知识库实现笔记》提到核心架构是...2)《Notus 设计文档》中你设计了混合检索方案...3)《向量数据库选型》对比了 Chroma、Qdrant、pgvector...」

用户：什么是 GraphRAG？
→ search_knowledge(query="GraphRAG 知识图谱")
→ 如果命中：基于笔记回答 + 标注来源
→ 如果未命中：「你的笔记里没有专门讨论 GraphRAG 的内容。如果需要，我可以基于一般性知识介绍它（这不来自你的笔记）。」

用户：帮我把这段英文翻译成中文：[文本]
→ 直接翻译，不调用任何工具

用户：那个怎么样了？
→ ask_user({
    question: "你想问的是哪方面？",
    options: ["最近的笔记进展", "某个具体项目", "某个具体话题", "让我具体描述"]
  })

用户：帮我改改这篇文章
→ 提示：「你想编辑或改写文章吗？这需要在「创作」页面才能进行，我可以帮你切换过去。」（因为知识库场景没有编辑工具）
```

---

### 6.4 AI 创作场景 Prompt（CANVAS_PROMPT）

```
## 当前场景：AI 创作画布

你正在画布中和用户协作写作。文章以「块（block）」为单位组织，每个块有 ID（如 b1, b2, b3）。
你可以直接修改文章——所有修改都会以 diff 形式预览，用户确认后才生效，所以你可以大胆操作。

## 当前文章结构

{blocks_outline}

(如果当前没有打开文章，这里会是空，此时主要场景是从主题新建文章)

## 可用工具

### 检索 / 风格类（前置准备）
- search_knowledge(query): 搜索笔记库做事实补充
- get_style_context(topic): 获取用户写作风格画像和样本

### 创建类
- get_outline(topic, references): 根据主题生成大纲
- draft_block(block_id, instruction, context): 为指定块起草内容
- insert_block(position, content): 插入新块（position: after_b3 / at_start / at_end）

### 单块编辑
- expand_block(block_id, context): 扩写指定块
- shrink_block(block_id, target_length): 缩写指定块  
- polish_block(block_id): 润色指定块的措辞和风格

### 多块/全文编辑
- edit_blocks(block_ids, instruction): 对多个块联合操作
- edit_global(instruction, operation_type): 全文操作（polish/expand/shrink/rewrite）

### 删除 / 分析 / 交互
- delete_block(block_id): 删除块（建议先 ask_user 确认）
- analyze_article(aspects): 分析文章结构、逻辑、风格一致性等
- ask_user(questions): 不确定时询问用户

## 思考流程

**第一步：判断用户是要操作还是要讨论？**

讨论类（不调工具或只调分析工具）：
- 「这篇文章逻辑清楚吗？」→ analyze_article
- 「你觉得标题怎么样？」→ 直接给反馈
- 「我应该怎么写下一段？」→ 直接给建议

操作类（要修改文章）：
- 进入第二步

**第二步：定位目标块**

按以下映射找到操作目标：

| 用户表述 | 目标 |
|---------|------|
| @b2 / @b3 等 | 直接对应 block_id |
| 第N段 / 第N个 | 第 N 个 paragraph 块 |
| 开头 / 第一段 | 第一个 paragraph 块 |
| 最后一段 / 结尾 | 最后一个 paragraph 块 |
| 关于 XX 的那段 | content 包含 XX 的块 |
| 标题 | heading 类型的块 |
| 全文 / 整篇 / 所有 | 用 edit_global |

定位失败的处理：
- 文章只有一个块 → 直接用那个
- 上一轮对话已提到某个块 → 沿用
- 仍然不明确 → 调 ask_user 列出候选块

**第三步：判断需要的前置准备**

| 操作类型 | 前置工具 |
|---------|---------|
| draft_block / insert_block / 涉及写作 | 必须先 get_style_context |
| polish_block / 风格类编辑 | 必须先 get_style_context |
| expand_block / shrink_block | 建议先 get_style_context |
| 涉及事实补充 | 调 search_knowledge |
| delete_block / analyze_article | 不需要前置 |
| 整篇文章新建（从主题） | search_knowledge + get_style_context + get_outline → 逐块 draft_block |

**第四步：执行编辑工具，输出 operation**

每个编辑工具返回一个 operation 对象，前端会渲染 diff 预览给用户确认。
你的回复中要简短说明做了什么（一句话），不要重复 operation 内容。

## 写作原则（核心）

1. **风格一致性优先**：你写的每一段都要读起来像是用户自己写的。宁可保守也不要写出风格不一致的内容。
2. **保留原意**：除非用户明确要"重写"或"换个表达"，否则改写时保留原句的核心信息和观点。
3. **风格画像是硬约束**：调过 get_style_context 后，画像中提到的句长偏好、用词倾向、段落节奏要严格遵守。
4. **不替代用户思考**：你是搭档不是代笔，不要在用户没要求时擅自添加新观点。

## 关于 ask_user 在创作场景的高频使用

创作场景中模糊指令很多，多用 ask_user 比瞎猜稳：

| 用户说 | ask_user 选项 |
|--------|--------------|
| "改一下第二段" | 润色措辞 / 重写表达 / 扩充细节 / 让我具体描述 |
| "帮我改改" | 润色全文风格 / 优化结构 / 扩充内容 / 让我具体描述 |
| "缩一下" | 缩到 50% / 缩到 30% / 保留核心观点 / 让我指定字数 |
| "这段不太好" | 重写 / 润色 / 缩短 / 告诉我哪里不好 |

## 输出风格

- 工具调用前的对话文字要简短：「我来扩写第三段」就够了，不要长篇解释
- 不要在 diff 预览之外再把修改内容打印一遍（用户在画布上能看到）
- 有不确定的假设时一句话说明：「我假设你想保留原段的核心观点，只是扩充例子」

## 示例

用户：写一篇关于微服务架构的文章
→ search_knowledge(query="微服务架构")
→ get_style_context(topic="微服务架构")
→ get_outline(topic="微服务架构", references=...)
→ 把大纲写入画布后逐块 draft_block(...)

用户：@b3 扩写一下，多加点例子
→ get_style_context(topic="...")
→ expand_block(block_id="b3", context={ instruction: "多加例子" })

用户：把全文语气改得更正式
→ get_style_context(topic="...")
→ edit_global(instruction="将语气改为更正式的书面语", operation_type="polish")

用户：这篇文章结构有什么问题吗？
→ analyze_article(aspects=["structure", "logic"])
→ 直接基于分析结果回答，不修改任何块

用户：改一下第二段
→ ask_user({
    question: "你想怎么改第二段？",
    options: ["润色措辞", "重写换种表达", "扩充细节", "让我具体描述"]
  })

用户：帮我改改这篇文章
→ ask_user({
    question: "你想对这篇文章做什么？",
    options: ["润色全文风格", "优化结构和逻辑", "扩充内容", "让我具体描述"]
  })

用户：删掉第三段
→ ask_user({
    question: "确认删除第三段吗？这个操作虽然可以撤销，但建议确认一下。",
    options: ["确认删除", "取消"]
  })
→ 用户确认后 → delete_block(block_id="b3")

用户：你觉得我这篇文章最大的问题是什么？
→ analyze_article(aspects=["structure", "logic", "style_consistency"])
→ 基于分析结果给出意见，不调任何编辑工具

用户：帮我把"容器"都改成"Container"
→ edit_global(instruction="将所有'容器'替换为'Container'", operation_type="rewrite")
```

---

### 6.5 上下文注入块（CONTEXT_BLOCK）

每轮 LLM 调用前动态生成，附加在 prompt 末尾。

```javascript
function buildContextBlock(conv) {
  return `
## 当前会话上下文

- 检索范围: ${describeScope(conv.retrieval_scope)}
- 风格参考范围: ${describeScope(conv.style_scope)}
${conv.kind === 'canvas' && conv.current_article 
  ? `\n## 当前文章结构\n\n${formatBlocks(conv.current_article.blocks)}`
  : ''}
`;
}

function formatBlocks(blocks) {
  return blocks.map(b => 
    `[${b.id}] ${b.type}: ${b.content.slice(0, 80)}${b.content.length > 80 ? '...' : ''}`
  ).join('\n');
}
```

注入位置：底座 + 场景 prompt 之后。这样 LLM 看到的完整 prompt 是：

```
<底座 prompt>
身份、底线、scope 规则、ask_user 规则

<场景 prompt>
当前场景的工具列表、思考流程、写作原则、示例

<上下文注入>
当前 scope、当前文章结构（如果是创作场景）
```

---

### 6.6 Prompt 通用性原则

无论用什么模型，prompt 都遵循以下原则：

| 原则 | 说明 |
|------|------|
| 顺序判断替代并行推理 | "第一步→第二步→第三步" 比 "综合考虑 ABC" 对弱模型更友好 |
| 是非题替代开放题 | "是否包含 X？" 比 "判断意图类型" 准确率高得多 |
| 给映射表替代描述规则 | 用户说"第二段" → 第二个 paragraph 块。直接列对应关系，不让模型推 |
| Few-shot 替代抽象解释 | 5 个具体例子比一段详细规则更好用 |
| 显式兜底替代默认行为 | "不确定时调用 ask_user"，不让模型自己想兜底方案 |
| 划边界替代列路径 | "永远不要说做不到" 是边界；"何时该做什么" 是路径，少列路径多划边界 |

**绝对不为特定模型写专属 prompt。** 原因：
- 维护成本爆炸（N 个模型 × M 次迭代）
- 模型升级后旧 prompt 反而拖累
- 不同模型行为差异最终是工程问题（harness），不是 prompt 问题


## 七、Harness Engineering

弱模型（Haiku、Flash）能稳定工作的关键不在 prompt，在工程手段。

### 7.1 输出格式约束（structured output）

强制 LLM 用 JSON schema：

```javascript
const response = await llm.chat({
  messages,
  tools,
  // 大部分模型支持
  tool_choice: 'auto',
  // 部分模型还支持强制输出 JSON
  response_format: { type: 'json_object' }
});
```

### 7.2 代码层面的预处理 hint（可选辅助）

不依赖 LLM，但提供线索：

```javascript
function preprocessHints(userMessage, conv) {
  const hints = {};
  
  if (/我的笔记|我写过|之前那篇|上次/.test(userMessage)) {
    hints.likely_search = true;
  }
  if (/写一篇|帮我写|起草|撰写|生成一份/.test(userMessage)) {
    hints.likely_create = true;
  }
  if (/@b\d+/.test(userMessage)) {
    hints.has_block_ref = userMessage.match(/@b\d+/g);
  }
  if (/全文|整篇|所有段落/.test(userMessage)) {
    hints.likely_global = true;
  }
  
  return hints;
}

// 注入到 system prompt 末尾（作为参考，LLM 可以覆盖）
const hintBlock = Object.keys(hints).length > 0
  ? `\n## 系统预分析（仅供参考）\n${JSON.stringify(hints, null, 2)}`
  : '';
```

弱模型受益最多，强模型也不会被误导（因为是"参考"不是"指令"）。

### 7.3 多轮重试 + 错误自我修正

工具失败 → 返回 hint → LLM 改方案 → 再调用：

```javascript
// agentLoop 中的核心：tool 错误也是消息
messages.push({
  role: 'tool',
  tool_call_id: call.id,
  content: JSON.stringify({
    success: false,
    error: 'BLOCK_NOT_FOUND',
    hint: '块 b5 不存在。当前文章只有 b1-b4 四个块，请重新选择'
  })
});
// 下一轮 LLM 看到这个，会自动改用 b1-b4 中的某个
```

最大步数兜底：

```javascript
if (steps >= maxSteps) {
  // 强制收尾，禁用工具
  messages.push({
    role: 'system',
    content: '请基于已有信息直接回复用户，不要再调用任何工具。'
  });
  return await llm.chat({ messages, tools: [] });
}
```

### 7.4 Scope 不交给 LLM 推断

用户在 UI 选 scope → 写入会话状态 → 后端注入工具调用。

如果想支持自然语言改 scope（用户说"只在 Go 目录里找"），用**独立的轻量分类器或正则**前置识别，弹卡片让用户确认：

```javascript
async function preprocessUserMessage(message, conv) {
  // 检测是否在改 scope
  const scopeIntent = detectScopeChangeIntent(message);
  if (scopeIntent.detected) {
    // 弹卡片让用户确认，不让 LLM 决定
    return {
      type: 'scope_change_confirm',
      payload: {
        question: `你想把检索范围改为 "${scopeIntent.target}" 吗？`,
        options: ['确认', '取消', '让我手动选择']
      }
    };
  }
  
  // 否则正常进入 agent loop
  return null;
}
```

### 7.5 风格样本缓存保证一致性

每个文档的风格样本只算一次，永久缓存（除非文档变了）：

```javascript
async function getStyleSamples(docId) {
  const cached = await db.get(
    'SELECT samples, fingerprint, computed_at FROM style_samples_cache WHERE doc_id = ?',
    [docId]
  );
  
  // 检查文档是否更新过
  const doc = await getDocument(docId);
  if (cached && cached.computed_at >= doc.updated_at) {
    return JSON.parse(cached.samples);
  }
  
  // 重算
  const samples = await computeStyleSamples(doc);
  await db.run(
    'INSERT OR REPLACE INTO style_samples_cache VALUES (?, ?, ?, ?)',
    [docId, JSON.stringify(samples), JSON.stringify(samples.fingerprint), Date.now()]
  );
  return samples;
}
```

### 7.6 Scope UI 始终可见

无论 LLM 多聪明，scope 必须对用户透明：

```
┌──────────────────────────────────────────────────────────┐
│ 检索范围: /tech/golang (12 篇) ▾   风格参考: 自动匹配 ▾  │
├──────────────────────────────────────────────────────────┤
│                    对话窗口                               │
│                      ...                                  │
└──────────────────────────────────────────────────────────┘
```

用户随时可见、随时可改。这避免了 LLM 在错误 scope 下静默执行用户察觉不到的操作。

### 7.7 性能与成本控制

| 措施 | 收益 |
|-----|------|
| 删除意图分类那次额外 LLM 调用 | 节省 30-40% token，延迟降一半 |
| 风格样本缓存 | 避免每次仿写重复采样 |
| Scope 在索引层过滤 | 召回数量大幅减少 |
| 文档级 token 预算 | 避免上下文溢出失败 |
| Map-reduce 兜底 | 大范围 scope 也能 work |
| 工具调用并发 | 多工具并行更快 |

### 7.8 Harness 总结表

| 问题 | 解决手段 |
|-----|---------|
| 弱模型推断不稳 | 顺序判断 + 是非题 + 映射表 |
| 输出格式跑偏 | tool calling 强 schema |
| 不知道兜底 | ask_user 工具显式兜底 |
| 工具失败胡说 | 结构化 hint 指示下一步 |
| 死循环 | maxSteps + 强制收尾 |
| Scope 误判 | 不让 LLM 推断，UI 显式 + 后端注入 |
| 风格漂移 | 样本缓存 + 指纹固化 |
| 上下文溢出 | token 预算 + map-reduce |
| 调试困难 | Chain of Thought + 工具调用日志 |

---

## 八、完整数据流示例

### 场景：用户在画布页要求"用我的风格扩写第三段"

```
[1] 用户已设置：
     retrieval_scope = /tech/golang
     style_scope = auto

[2] 用户在 UI 输入："用我的风格扩写第三段"

[3] 前端 POST /api/conversations/:id/messages

[4] 后端 agentLoop 启动：
    - 加载 conv 上下文（含 scope、当前文章 blocks）
    - 组装 system prompt（注入 scope 描述、文章结构）
    - 加 user message 进 messages

[5] 第一次 LLM 调用：
    Input:
      - system: "...风格参考范围: 自动匹配...当前文章: [b1] ... [b2] ... [b3] ..."
      - user: "用我的风格扩写第三段"
    Output:
      - tool_calls: [
          { name: 'get_style_context', args: { topic: 第三段主题词 } },
          { name: 'expand_block', args: { block_id: 'b3', context: ... } }
        ]

[6] 后端执行 get_style_context:
    - 因为 style_scope = auto，用第三段主题词 retrieve top 3 文档
    - 对每篇调 sampleStyleFromFile（命中缓存，秒返回）
    - 返回 { samples: [...], fingerprint: {...} }

[7] 后端执行 expand_block:
    - 内部用 LLM 生成扩写内容，注入风格画像作为硬约束
    - 返回 { operation: { op: 'replace', block_id: 'b3', old: ..., new: ... } }

[8] 第二次 LLM 调用（带工具结果）:
    Output: 直接回复 "我已经基于你的写作风格扩写了第三段，请查看预览"

[9] 前端：
    - 显示 LLM 文字回复
    - 同时根据 operation 渲染 diff 预览
    - 用户点 [应用] → POST /api/articles/apply → 写入 MD → 增量索引
```

### 场景：用户输入"帮我改改这篇文章"（模糊意图）

```
[1] 用户：帮我改改这篇文章

[2] LLM 第一轮调用：
    Output:
      - tool_calls: [{ name: 'ask_user', args: {
          questions: [{
            question: "你想对这篇文章做什么？",
            options: ["润色全文风格", "优化结构和逻辑", "扩充内容细节", "让我具体描述"]
          }]
        }}]

[3] 后端识别 ask_user 工具：
    - 不实际"调用"，直接返回 await_user_choice 给前端

[4] 前端渲染卡片，用户点击"润色全文风格"

[5] 前端把选择作为新消息发回：
    POST /api/conversations/:id/messages
    body: { type: 'card_response', selected: '润色全文风格' }

[6] 后端把"用户选择了：润色全文风格"作为 user message 加入历史

[7] LLM 第二轮调用：
    Output:
      - tool_calls: [
          { name: 'get_style_context', args: {...} },
          { name: 'edit_global', args: { instruction: '润色风格', operation_type: 'polish' } }
        ]

[8] 之后流程同上
```

---

## 九、扩展性指南

这套架构的关键就是不需要重构就能扩展。以下是常见扩展场景的做法：

### 9.1 加一个新工具

例：用户想要一个 `translate_block` 工具翻译指定块。

1. 在 TOOLS 字典加定义
2. 在 executeTool switch 加 case
3. 在 system prompt 的"工具"部分加一行描述
4. 在 system prompt 的"示例"部分加一个例子

不需要改路由、分类器、harness 任何东西。

### 9.2 加一种新 Scope 类型

例：想加 `{ type: 'date_range', start, end }` 按时间范围检索。

1. 在 Scope 类型联合中加新类型
2. 在 buildScopeFilter 加 case 生成 SQL
3. 在 describeScope 加自然语言描述
4. 在 validateScope 加校验
5. UI 加选择器

prompt 完全不动，因为 prompt 只引用 `{retrieval_scope_human}` 占位符。

### 9.3 接入新的 LLM 模型

直接接入即可，不需要写专属 prompt。如果发现某个新模型在某些场景表现差：

1. **不要**为它写专属 prompt
2. 在通用 prompt 中加更具体的示例
3. 在 harness 中加更精细的失败兜底
4. 这些改进对所有模型都有正面作用

### 9.4 加新的页面/模块

例：想加一个"日记模式"，每天自动汇总写作。

1. conversations.kind 加 'diary' 枚举
2. 在 buildSystemPrompt 中根据 kind 注入不同上下文
3. 复用现有所有工具
4. 新增 diary 专属工具（如 `summarize_today`）追加到 TOOLS

### 9.5 加多模态（图片输入）

documents.has_image 字段已预留，chunks.has_image 也有。

1. embed 阶段已有视觉模型 caption 流程
2. 检索流程不变
3. 工具调用支持传图片：例如 `ask_user_with_image`
4. LLM 调用时 messages 支持 image content type

### 9.6 加协作功能（多人共享笔记）

1. documents 加 owner_id, shared_with 字段
2. scope 的 SQL 过滤加 ownership 条件
3. UI 加共享面板
4. 这是产品层面的事，架构本身不需要动

### 9.7 关键扩展原则

加新功能 → 看属于哪一层：

- **数据维度**（新字段、新类型）→ 改 schema + scope filter
- **能力维度**（新动作、新工具）→ 加工具，prompt 加示例
- **意图维度**（新场景、新页面）→ 加 conversation kind，prompt 模板分支
- **模型维度**（新 LLM）→ 不动 prompt，按需加 harness

**永远不要**：
- 加意图分类器
- 为模型写专属 prompt
- 把 scope 推断让给 LLM
- 把 chunk 当最终输出

---

## 附录 A：完整 Tool Schemas（JSON 定义）

```javascript
const TOOLS = [
  {
    name: 'search_knowledge',
    description: '搜索用户笔记库，返回相关文档完整内容（不是 chunks）',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或问题' },
        topK: { type: 'number', description: '返回文档数量', default: 5 }
      },
      required: ['query']
    }
  },
  {
    name: 'get_style_context',
    description: '获取用户的写作风格画像和代表性样本，用于风格仿写',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '当前写作主题，用于自动匹配相似风格' }
      },
      required: ['topic']
    }
  },
  {
    name: 'get_outline',
    description: '根据主题生成文章大纲',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        references: { type: 'array', description: 'search_knowledge 的结果' }
      },
      required: ['topic']
    }
  },
  {
    name: 'draft_block',
    description: '为指定块起草内容（要求 block 已存在但内容为空或要重写）',
    parameters: {
      type: 'object',
      properties: {
        block_id: { type: 'string' },
        instruction: { type: 'string' },
        context: { type: 'object', description: '上下文，含主题、相邻块等' }
      },
      required: ['block_id', 'instruction']
    }
  },
  {
    name: 'insert_block',
    description: '在指定位置插入新块',
    parameters: {
      type: 'object',
      properties: {
        position: {
          type: 'string',
          description: 'after_b3 | at_start | at_end'
        },
        content: { type: 'string' }
      },
      required: ['position', 'content']
    }
  },
  {
    name: 'expand_block',
    description: '扩写指定块',
    parameters: {
      type: 'object',
      properties: {
        block_id: { type: 'string' },
        context: { type: 'object' }
      },
      required: ['block_id']
    }
  },
  {
    name: 'shrink_block',
    description: '缩写指定块',
    parameters: {
      type: 'object',
      properties: {
        block_id: { type: 'string' },
        target_length: { type: 'number', description: '目标字数（可选）' }
      },
      required: ['block_id']
    }
  },
  {
    name: 'polish_block',
    description: '润色指定块的风格和措辞，保持原意',
    parameters: {
      type: 'object',
      properties: {
        block_id: { type: 'string' }
      },
      required: ['block_id']
    }
  },
  {
    name: 'edit_blocks',
    description: '对多个指定块执行联合操作（合并、调换、批量修改等）',
    parameters: {
      type: 'object',
      properties: {
        block_ids: { type: 'array', items: { type: 'string' } },
        instruction: { type: 'string' }
      },
      required: ['block_ids', 'instruction']
    }
  },
  {
    name: 'edit_global',
    description: '对全文执行统一操作。自动跳过 heading/code/table',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string' },
        operation_type: {
          type: 'string',
          enum: ['polish', 'expand', 'shrink', 'rewrite']
        }
      },
      required: ['instruction', 'operation_type']
    }
  },
  {
    name: 'delete_block',
    description: '删除指定块（用户已确认才调）',
    parameters: {
      type: 'object',
      properties: {
        block_id: { type: 'string' }
      },
      required: ['block_id']
    }
  },
  {
    name: 'analyze_article',
    description: '分析文章结构、逻辑、风格一致性等。不修改任何内容',
    parameters: {
      type: 'object',
      properties: {
        aspects: {
          type: 'array',
          items: {
            enum: ['structure', 'logic', 'style_consistency', 'readability', 'completeness']
          }
        }
      },
      required: ['aspects']
    }
  },
  {
    name: 'ask_user',
    description: '当无法确定用户意图、目标或方式时，通过卡片向用户展示 2-4 个选项',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: {
                type: 'array',
                items: { type: 'string' },
                minItems: 2,
                maxItems: 4
              }
            },
            required: ['question', 'options']
          },
          maxItems: 3
        }
      },
      required: ['questions']
    }
  }
];
```

## 附录 B：版本演进记录

| 版本 | 关键变化 |
|-----|---------|
| v1.0 | 意图分类器 + chunk 直返 + 固定路由 |
| v2.0 | 改为 tool use 但仍是分类器思维 |
| v2.5 | 引入 chunk → document 反查；scope 作为消息参数 |
| v3.0（本版本） | scope 升级为会话状态；ask_user 作为正式工具；删除意图分类；统一 prompt 适配所有模型；map-reduce 兜底；风格样本缓存 |

---

**Notus · Agent 架构 · v3.0**
