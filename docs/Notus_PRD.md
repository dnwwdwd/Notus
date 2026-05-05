# Notus 产品需求文档（PRD）

> v2.0 · 由 PDD 派生 · 接口级技术实现规范（数据库 schema、API、关键函数签名）

---

## 1. 技术栈

| 层次 | 技术选型 |
|------|---------|
| 前端框架 | Next.js 15（**Pages Router**，非 App Router）+ React 19 |
| 语言 | JavaScript（暂不引入 TypeScript） |
| 包管理器 | npm |
| UI 组件策略 | Radix Primitives（行为）+ 手写样式（token 驱动）；编辑器 Tiptap + tiptap-markdown + lowlight；渲染 react-markdown；拖拽 @dnd-kit/core；命令面板 cmdk |
| MD 渲染插件链 | remark-gfm + rehype-highlight + rehype-katex |
| 数据库 | SQLite（better-sqlite3），WAL 模式 |
| 向量检索 | sqlite-vec（SQLite 扩展） |
| 全文检索 | SQLite FTS5（应用层预分词写入 `search_text`） |
| 中文分词 | jieba-wasm（应用层分词，失败时回退简化分词） |
| 文件监听 | chokidar（usePolling:true, interval:3000ms, awaitWriteFinish） |
| Embedding | 用户在设置页手动填写 Base URL、模型名与 API Key；设置页与 `/setup` 第 1 步初次展示时，这三个输入框默认留空，不自动回填已保存值，API Key 仅通过“已保存，留空不修改”占位提示反映状态；系统根据 Base URL 和模型名自动识别兼容厂商，可选文本或多模态，开启 `EMBEDDING_MULTIMODAL_ENABLED` 后为图片建立向量 |
| LLM | 用户在设置页手动填写 Base URL、模型名与 API Key；系统根据 Base URL 和模型名自动识别兼容厂商，流式输出 |
| 运行平台 | Web + Electron 桌面端主线，保留对懒猫运行时的代码兼容；业务层统一依赖平台中间层解析路径与能力 |

**不用 TypeScript / App Router / shadcn-ui / Python sidecar** —— 减少复杂度、减少 AI 自动生成时的路由混淆、不依赖默认主题。

---

## 2. 目录结构

```
Notus/
├── desktop/
│   ├── main/                      # Electron 主进程
│   ├── preload/                   # 桌面桥接
│   └── shared/                    # 桌面共享工具
├── notus/
│   ├── pages/
│   │   ├── _app.js                 # 全局样式、主题
│   │   ├── index.js                # 重定向到 /files
│   │   ├── login.js                # /login
│   │   ├── setup.js                # /setup
│   │   ├── files/index.js          # /files
│   │   ├── knowledge.js            # /knowledge
│   │   ├── canvas.js               # /canvas
│   │   ├── settings/
│   │   │   ├── index.js            # /settings → /settings/model
│   │   │   └── [section].js        # /settings/model|storage|shortcuts|about
│   │   ├── indexing.js             # /indexing
│   │   ├── 404.js                  # /404
│   │   └── api/                    # 所有 REST API（见 §5）
│   ├── lib/
│   │   ├── platform/               # 运行平台识别、路径解析、能力清单
│   │   ├── db.js                   # SQLite + sqlite-vec 初始化
│   │   ├── indexer.js              # AST 分块 + 增量索引
│   │   ├── embeddings.js           # Embedding API 封装
│   │   ├── queryPlanner.js         # 查询理解、清晰度判断、条件改写
│   │   ├── retrieval.js            # 查询规划后的混合检索 + 章节证据扩展
│   │   ├── knowledgeRuntime.js     # 回答模式、条件重排、成本护栏
│   │   ├── knowledgeHelperCache.js # rewrite / rerank 短时缓存
│   │   ├── prompt.js               # Prompt 模板
│   │   ├── watcher.js              # chokidar 文件监听
│   │   ├── style.js                # 风格指纹、全局画像、运行时风格上下文
│   │   ├── canvasRequestPlanner.js # 创作请求规划
│   │   ├── canvasAgent.js          # 创作执行器
│   │   ├── canvasOperationSets.js  # 批量预览持久化
│   │   ├── diff.js                 # str_replace 引擎 + diff 计算
│   │   └── config.js               # 环境变量读取
│   ├── components/
│   ├── styles/
│   ├── public/
│   └── .env.local.example
├── README.md
├── AGENTS.md
└── CLAUDE.md
```

**Next.js 使用 standalone 输出**（`next.config.js` 中 `output: 'standalone'`）。  
Electron 桌面端在拷贝 standalone 产物后，必须按目标 `platform/arch` 重新准备 `desktop/resources/notus/node_modules`，确保 `better-sqlite3` 与 `sqlite-vec` 使用目标平台可加载的 Electron 运行时二进制，而不是直接复用普通 Node 构建产物。

---

## 3. 数据库设计

SQLite 只存索引数据，不存文件内容本体。所有表支持 CASCADE 清理。

### 3.1 建表语句

```sql
-- 文件元数据
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE NOT NULL,           -- 相对 /notes/ 的路径
  title       TEXT,                            -- 从首个 h1 或文件名提取
  hash        TEXT,                            -- 文件内容 SHA-256
  indexed     INTEGER DEFAULT 0,               -- 0=未索引 1=已索引
  indexed_at  DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_indexed ON files(indexed);

-- 分块
CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,                  -- 块原始 MD 内容
  type         TEXT NOT NULL,                  -- heading/paragraph/code/table/list/blockquote
  position     INTEGER NOT NULL,               -- 文件内顺序
  line_start   INTEGER,
  line_end     INTEGER,
  heading_path TEXT,                            -- 所属 heading 层级，如 "性能优化 > 缓存策略"
  has_image    INTEGER DEFAULT 0,
  search_text  TEXT                             -- 应用层分词后的检索字段
);
CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_position ON chunks(file_id, position);

-- 向量（sqlite-vec 虚拟表，维度由 EMBEDDING_DIM 环境变量决定）
-- 建表语句由 lib/db.js 在初始化时动态拼接（见 §3.2）

-- 全文检索（独立 FTS 表；中文分词由应用层写入 search_text）
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  search_text,
  tokenize='unicode61'
);

-- FTS5 触发器（保持与 chunks 表同步）
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, search_text)
  VALUES (new.id, new.content, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.id;
  INSERT INTO chunks_fts(rowid, content, search_text)
  VALUES (new.id, new.content, new.search_text);
END;

-- 文件级标题 / 路径检索
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  title,
  path,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, title, path)
  VALUES (new.id, new.title, new.path);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  DELETE FROM files_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  DELETE FROM files_fts WHERE rowid = old.id;
  INSERT INTO files_fts(rowid, title, path)
  VALUES (new.id, new.title, new.path);
END;

-- 图片（延迟处理）
CREATE TABLE IF NOT EXISTS images (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id         INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  alt_text         TEXT,
  caption          TEXT,
  status           TEXT DEFAULT 'pending',      -- pending/done/failed
  local_path       TEXT,                        -- /assets/ 下的相对路径
  processed_at     DATETIME,
  cache_status     TEXT DEFAULT 'pending',      -- pending/done/failed
  cache_error      TEXT,
  mime_type        TEXT,
  content_length   INTEGER,
  cached_at        DATETIME,
  embedding_status TEXT DEFAULT 'pending',      -- pending/done/skipped/failed
  embedding_error  TEXT,
  embedded_at      DATETIME
);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);

-- 图片向量（sqlite-vec 虚拟表，维度与 chunks_vec 保持一致）
-- 建表语句由 lib/db.js 在初始化时动态拼接：
-- CREATE VIRTUAL TABLE IF NOT EXISTS images_vec USING vec0(
--   image_id INTEGER PRIMARY KEY,
--   embedding FLOAT[${dim}]
-- )

-- 对话历史（知识库 + 画布共用）
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                    -- 'knowledge' | 'canvas'
  title      TEXT,
  file_id    INTEGER REFERENCES files(id) ON DELETE SET NULL,
  draft_key  TEXT,                             -- 仅用于兼容旧版未保存草稿会话，现行前端新流程不再创建新的 draft 会话
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,               -- 'user' | 'assistant' | 'tool'
  content         TEXT NOT NULL,               -- JSON 字符串
  citations       TEXT,                         -- JSON 数组，来源块元数据
  meta            TEXT,                         -- JSON 对象，知识库回答模式/检索统计/helper 遥测
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- 设置（键值对）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS style_fingerprints (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id                INTEGER UNIQUE NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  file_hash              TEXT,
  sentence_style         TEXT,
  tone                   TEXT,
  structure              TEXT,
  vocabulary             TEXT,
  rhetoric               TEXT,
  signature_phrases_json TEXT,
  raw_response           TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
  retry_count            INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  model_used             TEXT,
  created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS style_profile (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_json  TEXT NOT NULL,
  source_count  INTEGER NOT NULL DEFAULT 0,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS canvas_operation_sets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  file_id         INTEGER REFERENCES files(id) ON DELETE SET NULL,
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  article_hash    TEXT NOT NULL,
  mode            TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  expires_at      DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3.2 维度动态配置

`chunks_vec` 的向量列维度写死会导致切换 Embedding 模型时必须重建整库。`lib/db.js` 在初始化时从 `process.env.EMBEDDING_DIM` 读取并拼接 DDL：

```javascript
const dim = parseInt(process.env.EMBEDDING_DIM || '1024', 10);
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding FLOAT[${dim}]
  )
`);
```

切换维度时提示用户重建索引（设置页 [重建索引] 按钮）。

---

## 4. 核心库接口（`lib/*.js`）

### 4.1 `lib/db.js`

```javascript
module.exports.db                      // better-sqlite3 Database 单例
module.exports.initDb()                // 建表、建索引、开启 WAL、加载 sqlite-vec
module.exports.resetVec(dim)           // 切换维度时重建 chunks_vec
```

初始化后立即执行 `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`。

### 4.2 `lib/indexer.js`

```javascript
/**
 * 将 MD 内容切分为 AST 块
 * @param {string} content
 * @returns {Array<{type,content,position,line_start,line_end,heading_path,has_image}>}
 */
function splitIntoChunks(content)

/**
 * 索引单个文件（增量）
 * @param {string} relativePath
 * @returns {Promise<{fileId, chunksCount, skipped: boolean}>}
 */
async function indexFile(relativePath)

async function indexBatch(paths, onProgress)  // onProgress({current,total,currentFile})
function removeFile(relativePath)
```

**`indexFile` 流程：**
1. 读文件，计算 SHA-256 hash
2. 查 files 表，hash 未变 → 返回 `{skipped: true}`
3. hash 变化 → 删除旧 chunks（CASCADE 自动清 vec/fts/images）
4. `splitIntoChunks` 分块
5. 事务批量写 chunks 表（FTS 触发器自动同步）
6. 逐块调用 `getEmbedding`，写 chunks_vec
7. Embedding 失败 → 标记 `files.indexed = 0`，不抛错，后台任务重试
8. 成功 → 更新 files 表 hash、indexed=1、indexed_at

### 4.3 `lib/embeddings.js`

```javascript
async function getEmbedding(text)              // 返回 number[]（长度=EMBEDDING_DIM）
async function getEmbeddings(texts)            // 批量
```

从 `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`/`EMBEDDING_API_KEY` 读配置，支持 qwen/doubao/openai/custom；Provider 改为根据 Base URL 和模型名自动推断，向量维度在测试连接后自动确认；失败抛错不静默。

### 4.4 `lib/retrieval.js`

```javascript
/**
 * 基础混合检索
 * @param {string} query
 * @param {object} opts
 * @param {number} [opts.topK=5]
 * @param {number} [opts.vecThreshold=0.5]    - 向量原始相似度阈值
 * @param {number} [opts.rrfK=60]
 * @param {number} [opts.headingBoost=0.1]
 * @param {number} [opts.recencyBoost=0.05]
 * @returns {Promise<Chunk[]>}
 */
async function hybridSearch(query, opts)

// Chunk 类型
{
  chunk_id, file_id, file_title, content,
  heading_path, line_start, line_end,
  preview,         // content 前 50 字
  score,           // RRF + boost 后最终分
  vec_score,       // 向量原始余弦相似度
  fts_rank,        // 可能为 null
  source           // 'hybrid' | 'fts_only' | 'vec_only'
}
```

`hybridSearch()` 负责单条 query 的基础召回：向量、FTS、图片向量、RRF 融合与基础重排。知识库问答不会只跑这一层，而是由查询规划驱动多路召回。

新增 `retrieveKnowledgeContext(queryPlan, opts)`，对外输出：

- `query_plan`
- `chunks`
- `sections`
- `matched_files`
- `rewrite_queries`
- `seed_count`
- `expanded_section_count`
- `stats`
- `sufficiency`

其中：

- `query_plan` 固定包含 `intent / clarity_score / ambiguity_flags / clarify_needed / clarify_question / rewrite_strategy`
- `sections[i]` 除正文和 quotes 外，还包含 `evidence_sentences`
- `stats` 至少包含 `chunk_count / section_count / file_count / section_file_count / matched_file_count / best_score / top_score_gap`

知识库主检索流程：
1. 先做查询规划，得到 `intent / standalone_query / expanded_query / keywords / title_hints / clarity_score / ambiguity_flags / clarify_needed / rewrite_strategy`
2. 用 query variants 并行执行 `hybridSearch()`
3. 用 `files_fts` 命中文档标题与路径
4. 对标题命中的文件做二次 chunk 召回
5. 合并候选并限制单文件上限
6. 对 heading chunk 做正文提升
7. 将命中 chunk 扩展成 section 级证据包
8. 基于证据包质量计算 `sufficiency`
9. 必要时对最多 8 个 section 做单次条件 rerank

**单索引约束：**

- 不引入文档摘要索引、章节摘要索引和句级持久索引
- chunk 候选池固定使用 `max(20, topK * 4)`
- section seed 固定使用 `max(8, topK * 2)`
- 当前文档优先只做温和加权，不能硬性压过更强证据

**helper 成本护栏：**

- 单次请求最多 2 次业务级 LLM 调用
- `clarify_needed`：0 次
- `no_evidence`：0 次
- 普通回答：1 次
- `rewrite + answer` 或 `rerank + answer`：2 次
- 同一请求禁止同时触发 `rewrite` 和 `rerank`

**降级：** 向量失败或零结果 → FTS5 兜底，结果标 `source: 'fts_only'`。`jieba-wasm` 失败 → `lib/tokenizer.js` 回退到简化分词（拉丁词、中文单字、中文双字 gram）。

### 4.5 `lib/prompt.js`

```javascript
function buildKnowledgeQAPrompt(query, context, options)
function buildKnowledgeQueryPlanPrompt(query, options)
function buildKnowledgeRerankPrompt(query, sections, options)
function buildCanvasIntentPrompt(userInput, article)
function buildCanvasQueryPlanPrompt(userInput, options)
function buildCanvasEditPrompt(input)
function buildCanvasTextPrompt(input)
function buildCanvasAnalysisPrompt(input)
```

知识库 Prompt 需要显式区分：

- `grounded`
- `weak_evidence`
- `conflicting_evidence`

并约束模型：

- 只能根据证据回答
- `weak_evidence` 只能写可确认部分和解释性补充
- `conflicting_evidence` 不能把冲突来源合并成单一结论

`clarify_needed` 和 `no_evidence` 由服务端直接模板化返回，不走主回答 Prompt。

### 4.6 `lib/watcher.js`

```javascript
function startWatcher()  // chokidar 监听 NOTES_DIR
```

配置 `{ usePolling: true, interval: 3000, awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 500 } }`。监听 `add`/`change` → `indexFile`；`unlink` → `removeFile`。

### 4.7 创作执行链路

```javascript
async function resolveCanvasRequest({
  userInput,
  article,
  conversationHistory,
  styleMode,
  referenceMode,
  factFileIds,
  llmConfig,
})

async function runCanvasAgent({
  userInput,
  article,
  conversationHistory,
  activeFileId,
  referenceMode,
  factFileIds,
  styleMode,
  styleFileIds,
  llmConfig,
}, onStream)
```

当前创作主链路不再依赖旧的多轮工具循环，而是拆成两层：

1. `resolveCanvasRequest()`：
   - 先用规则识别 `@bN / @b2-b5 / 第 N 段 / 全文 / 上一轮目标块延续 / 上一轮建议摘要延续`
   - 固定输出 `intent_candidates / primary_intent / intent_confidence / target_candidates / source_candidates / source_content_type / target_anchor / position_relation / write_action / risk_level / decision_path / decision_summary / ai_arbitration_mode`
   - 兼容保留旧字段 `intent / scope_mode / target_block_ids / candidate_block_ids / operation_kind / clarify_needed / clarify_reason / missing_slots / prefilled_answers / answer_slots / summary_instruction`
   - 规则层先产出候选，不直接一把定案；只有低置信或高风险场景才触发单次 `canvas_query_plan` helper
   - helper 只允许受控增强，不扩张成多轮规划；高风险场景最多再做一次轻量核验
2. `runCanvasAgent()`：
   - `clarify_needed` 优先转结构化 interaction；超过两轮或不适合结构化时退回自然语言追问
   - `text` 走流式文本回复
   - `analyze` 走文章分析文本回复
   - `edit` 走单块 / 多块 / 全文分批执行器
   - 对“把上面的内容写到文档中”这类已冻结来源内容的请求，优先用来源快照直接构造写入预览，不重新生成同一段正文
   - 助手结果会额外回传 `primary_intent / intent_confidence / risk_level / decision_summary / ai_arbitration_mode / source_content_type / target_anchor / position_relation / write_action / correction_state / show_decision_summary`

全文改写固定规则：

- 只处理 `paragraph / list / blockquote`
- 软上限 `12`，硬上限 `20`
- 单批最多 `4` 块
- 预计编辑 LLM 调用超过 `6` 次时直接拦截

风格上下文固定通过 `getStyleContext()` 获取：

- `manual`：全局画像 + 手动指定文章的指纹 / 原文摘录
- `auto`：全局画像 + 最相关 `1-2` 篇文章
- `/api/agent/outline` 与 `runCanvasAgent()` 统一复用这套风格上下文，不再保留旧的独立风格样本分支

### 4.8 `lib/canvasOperationSets.js`

```javascript
function computeArticleHash(article)
function createOperationSet(input)
function updateOperationSet(id, updates)
function listOperationSetsByConversation(conversationId, options)
function markOperationSetStatus(id, status)
```

未应用预览默认保存 `7` 天；刷新后恢复全部 `pending / stale` 预览；文章 hash 改变后自动转 `stale`。

### 4.9 `lib/conversationInteractions.js`

```javascript
function createInteraction(input)
function updateInteraction(id, updates)
function getInteractionById(id)
function listInteractionsByConversation(conversationId, options)
function normalizeInteractionResponse(interaction, input)
function buildResumePlanFromInteraction(interaction)
```

新增 `conversation_interactions` 作为创作页结构化提问持久化表，核心字段：

- `conversation_id`
- `message_id`
- `kind`
- `source`
- `status`
- `schema_version`
- `reason_code`
- `article_hash`
- `payload_json`
- `response_json`
- `answer_message_id`
- `expires_at`
- `created_at / updated_at / answered_at`

状态固定为：

- `pending`
- `answered`
- `stale`
- `cancelled`
- `failed`

规则：

- 同一会话同一时刻最多只允许 1 张 `pending` 卡片
- 新卡片创建时，旧 `pending` 卡片自动转 `stale`
- 默认过期时间 `7` 天
- 回答成功后必须追加一条 `user` 摘要消息，不使用 `tool` 角色
- `normalizeInteractionResponse()` 要支持 `primary_intent`；当回答为 `text / analyze` 时，不再继续要求 `source_content_ref / target_location / write_mode`
- `buildResumePlanFromInteraction()` 必须能直接恢复 `primary_intent / target_anchor / position_relation / write_action / decision_summary / correction_state`
- 执行续跑前必须再次校验 `article_hash` 与 `source_content_digest`
### 4.10 `lib/diff.js`

```javascript
/**
 * str_replace 操作，Block ID 优先 + old 字段二次校验
 * @param {Article} article
 * @param {Operation} op
 * @returns {{success, article?, error?}}
 */
function applyOperation(article, op)
function applyOperations(article, operations)

// Operation 类型
{
  op: 'replace' | 'insert' | 'delete',
  block_id,            // 目标块 ID
  old?,                // replace 时二次校验
  new?,                // replace/insert 时新内容
  position?            // insert 位置: 'before' | 'after' | number
}

function computeDiff(oldContent, newContent)  // 返回 DiffChunk[] 供前端渲染
```

`applyOperations()` 会按顺序在文章副本上执行，任一操作出现 `BLOCK_NOT_FOUND` 或 `OLD_MISMATCH` 都整体回滚，并返回 `failed_at / applied_count`。

---

## 5. REST API

所有路径在 `pages/api/` 下。响应 `Content-Type: application/json`，错误 `{ error, code }` + 合适 HTTP 状态码。

### 5.1 系统

```
GET  /api/health                     → { status, version, runtime, tokenizer, directories }
GET  /api/setup/status               → {
                                       configured, completed, indexed_files, total_files,
                                       notes_dir, model_configured, indexed,
                                       embedding_provider, embedding_multimodal_enabled, llm_provider
                                     }
POST /api/setup/complete             Body: {
                                       notes_dir?,
                                       embedding_provider?, embedding_model?, embedding_dim?, embedding_api_key?,
                                       embedding_multimodal_enabled?,
                                       llm_provider?, llm_model?, llm_api_key?
                                     }
                                     → { ok, notes_dir, embedding_provider, llm_provider }
```

### 5.2 文件管理

```
GET  /api/files                      → Array<{id, path, title, indexed, updated_at}>
GET  /api/files/tree                 → Array<folder|file 节点>
                                     file: { type:'file', id, name, path, indexed, status, updated_at }
                                     folder: { type:'folder', name, path, children }
GET  /api/files/:id                  → { id, path, title, name, content, indexed, updated_at }
POST /api/files                      Body: { path, content?, kind?: 'file'|'folder' } → 创建文件或文件夹
PUT  /api/files/:id                  Body: { content } → 保存 + 触发增量索引
DELETE /api/files/:id
POST /api/files/rename               Body: { old_path, new_path }
POST /api/files/move                 Body: { paths, dest }
POST /api/files/import               Body: {
                                       parentPath?,
                                       conflict_policy: 'skip'|'overwrite',
                                       files: Array<{ name, content }>
                                     }
                                     → SSE:
                                       { type: 'progress', current, total, currentFile }
                                       { type: 'file', status, name, path, id?, indexed?, error? }
                                       { type: 'done', imported, overwritten, skipped, failed, total }
GET  /api/files/export               Query: ?ids=1,2 or ?paths=a.md,b.md → ZIP
GET  /api/files/:id/content-image    Query: ?src=https://... → 缓存图片并返回；失败时 307 回源
```

### 5.3 索引

```
GET  /api/index/status               → { total, indexed, pending, failed }
POST /api/index/rebuild              Body: {} → 清空 chunks_*，全量重建（SSE 进度）
                                     SSE: progress → done | error
POST /api/index/retry                Body: { file_ids? } → 重试失败项
```

### 5.4 检索 & 问答

```
POST /api/search                     Body: { query, topK? } → { chunks }
                                     chunks[i] 包含：
                                     {
                                       chunk_id, file_id, file_title, file_path, content,
                                       heading_path, line_start, line_end, preview,
                                       score, vec_score, fts_rank, source,
                                       image_id?, image_url?, image_proxy_url?,
                                       image_alt_text?, image_caption?
                                     }

POST /api/chat                       Body: {
                                       conversation_id?, query, model?,
                                       active_file_id?, reference_mode?, reference_file_ids?
                                     }
                                     → SSE:
                                       { type: 'chunks', chunks, sections, stats, sufficiency,
                                         query_plan, matched_files, rewrite_queries,
                                         seed_count, expanded_section_count,
                                         answer_mode, confidence, rerank_applied }
                                       { type: 'assistant_meta', answer_mode, confidence,
                                         clarity_score, ambiguity_flags, rerank_applied,
                                         weak_evidence_reason, conflict_summary,
                                         retrieval_stats, clarify_question,
                                         helper_call_type, helper_call_triggered,
                                         helper_call_cache_hit, helper_call_latency_ms,
                                         helper_call_failed, fallback_reason }
                                       { type: 'token', text }
                                       { type: 'citations', citations }   // citations 支持图片字段
                                       { type: 'usage', usage, budget, compacted }
                                       { type: 'done', conversation_id, message_id,
                                         answer_mode, confidence, meta,
                                         usage?, budget?, compacted? }
                                       { type: 'error', error, conversation_id?, request_id }
```

严格 RAG：

- `clarify_needed`：只返回追问，不检索，不调用主回答模型
- `no_evidence`：直接模板化返回“未找到足够证据”
- `weak_evidence`：允许保守回答，但不能新增事实结论

### 5.5 创作 Agent

```
POST /api/agent/outline              Body: { topic }
                                     → SSE:
                                       { type: 'block', block }
                                       { type: 'done', citations }
                                       { type: 'error', error }

POST /api/agent/run                  Body: {
                                       conversation_id?, user_input,
                                       article: Article,
                                       user_meta?,
                                       reference_mode?, fact_file_ids?,
                                       style_mode?, style_file_ids?,
                                       interaction_id?, interaction_response?
                                     }
                                     → SSE:
                                       { type: 'thinking', text }
                                       { type: 'token', text }
                                       { type: 'batch_start', total_batches, total_blocks }
                                       { type: 'batch_progress', current_batch, total_batches, text }
                                       { type: 'batch_done', total_batches, total_operations }
                                       { type: 'assistant_meta', assistant_meta, operation_set?, interaction? }
                                       { type: 'interaction_request', interaction, message_id, assistant_message, assistant_meta }
                                       { type: 'operation', operation, diff }
                                       { type: 'done', conversation_id, message_id, citations, assistant_message, assistant_meta, operation_set?, interaction? }
                                       { type: 'error', error, conversation_id? }

POST /api/agent/apply                Body:
                                     { article: Article, operation }
                                     | { article: Article, operations: Operation[], operation_set_id? }
                                     | { action: 'cancel', operation_set_id }
                                     → { success, article?, error?, applied_count, failed_at, operation_set_status }

POST /api/interactions/:id/respond   Body:
                                     { response? | raw_text?, article, schema_version }
                                     → {
                                         interaction,
                                         answer_message?,
                                         resolution_status,
                                         normalized_response,
                                         should_continue,
                                         resume_payload?
                                       }
```

### 5.6 画布 / 文章

```
GET  /api/articles/:id               → { id, title, blocks, file_id }
POST /api/articles/parse             Body: { file_id } → 将本地 MD 解析为 Block 列表
POST /api/articles/save              Body: { article, path? } → 保存为本地 MD 文件

// Block 类型
{
  id,                  // 如 "b_abc123"
  type,                // heading/paragraph/code/table/list/blockquote
  content,
  line_start,
  line_end
}

// Article 类型
{ id, title, blocks: Block[], file_id? }
```

### 5.7 对话历史

```
GET    /api/conversations            ?kind=knowledge|canvas&file_id?&draft_key?&limit? → Array<Conversation>
POST   /api/conversations            Body: { title?, kind?, file_id?, draft_key? } → Conversation
GET    /api/conversations/:id        → { ...conversation, messages, pending_operation_sets, pending_interactions }
DELETE /api/conversations/:id
```

- 知识库页默认只按 `kind=knowledge` 读取全局历史，不再用 `file_id` 分桶。
- 创作页会话默认按 `kind=canvas + file_id` 读取；`draft_key` 仅保留给旧数据兼容与迁移。
- 画布会话详情会附带 `pending_operation_sets`，前端刷新后可恢复全部未应用预览。
- 画布会话详情还会附带 `pending_interactions`，前端刷新后可恢复 `pending / stale / failed` 提问卡片。

### 5.8 设置

```
GET  /api/settings                   → { notes_dir, assets_dir, setup_completed, embedding, llm, layout }
PUT  /api/settings                   Body: {
                                       notes_dir?, assets_dir?, setup_completed?,
                                       embedding?: { provider?, model?, dim?, multimodal_enabled?, base_url?, api_key? },
                                       llm?: { provider?, model?, base_url?, api_key? },
                                       layout?: { knowledge_left_percent?, canvas_left_percent? }
                                     }
                                     → 持久化到 settings 表
POST /api/settings/test              Body: { kind: 'embedding'|'llm', config }
                                     → { success, error?, latency_ms? }
```

- `layout.knowledge_left_percent`：知识库页左侧编辑区宽度百分比
- `layout.canvas_left_percent`：创作页左侧画布区宽度百分比

---

## 6. 功能模块详解

### 6.1 索引 Pipeline

**AST 分块（`splitIntoChunks`）：**

| 节点类型 | 规则 |
|---------|------|
| heading | 单独块，记录层级（h1-h6），heading_path 追加 |
| paragraph | 以 `\n\n` 为边界，单独块 |
| code | 整体块，保留语言标注 |
| table | 整体块，不拆行 |
| list | 整体块，不拆 item |
| blockquote | 整体块 |

向量化输入与 `search_text` 均统一带入：

- 文档标题
- 文件路径
- 标题层级路径
- 当前块正文

**增量索引：** hash 比对 → 相同跳过 / 不同 CASCADE 删除旧块 + 重新索引。

**Embedding 失败重试：** `setInterval(5 * 60 * 1000)` 扫描 `files.indexed=0` 重试；失败次数通过 `settings` 表记录，超过 5 次停止自动重试。

### 6.2 知识库检索

知识库问答当前采用“查询规划 + 多路召回 + 章节证据扩展”：

- 查询规划：结合最近若干轮 `user + assistant` 历史，生成更适合检索的独立问题、扩写问题、关键词和标题线索，并固定输出 `clarity_score / ambiguity_flags / clarify_needed / clarify_question / rewrite_strategy`
- 文件级命中：先用 `files_fts` 找文档标题和路径
- chunk 级混合检索：对多个 query variant 并行执行向量召回、FTS 召回与图片向量召回
- 章节证据扩展：命中 seed chunk 后，补齐同 heading 下的邻近 chunk，合并为可直接回答的 section 证据包
- 条件 rerank：仅在复杂问题或候选不稳定时触发，且一轮只允许一次 helper
- 证据保守策略：只命中文档标题但正文证据不足时，明确说明“已定位到相关文档，但正文证据有限”
- 回答模式：固定为 `clarify_needed / grounded / weak_evidence / conflicting_evidence / no_evidence`
- helper 缓存：`rewrite` 与 `rerank` 使用 5 分钟短时缓存，键包含会话、查询、当前文档、参考模式、参考文件和历史摘要哈希

### 6.3 图片缓存与图片向量

- 索引时提取 Markdown 图片语法，写入 `images` 表，记录 `url / alt_text / cache_status / embedding_status`
- 远程图片通过 `/api/files/:id/content-image?src=...` 代理下载到 `/lzcapp/var/assets/images/{sha256}.{ext}`
- 代理只允许 `http/https`，并阻止 localhost、内网地址和非法协议，避免服务端请求风险
- 缓存成功且开启 `EMBEDDING_MULTIMODAL_ENABLED` 时，调用第三方多模态 embedding 模型写入 `images_vec`
- 若当前 embedding 模型不支持图片输入，则标记 `embedding_status=skipped`，不影响文本索引和检索
- 缓存或图片向量失败只记录数据库状态；页面请求图片时会 307 回到原外链，文章仍能显示

### 6.4 创作 Agent 工具链

创作页当前不再以“9 个显式工具循环”作为主路径，而是固定走：

1. 请求规划
2. 风格上下文获取
3. 事实补充（可选）
4. 单块 / 多块 / 全文编辑执行
5. 批量预览持久化

运行时约束：

- 单次请求最多 1 次规划 helper
- 风格上下文最多获取 1 次
- 全文编辑固定分批执行
- 文本回复和文章分析复用现有 `streamChat()` 输出 `token`

### 6.5 str_replace 引擎

```javascript
function applyOperation(article, op) {
  const block = article.blocks.find(b => b.id === op.block_id);
  if (!block) return { success: false, error: 'BLOCK_NOT_FOUND' };
  if (op.op === 'replace') {
    if (op.old && block.content.trim() !== op.old.trim())
      return { success: false, error: 'OLD_MISMATCH' };
    block.content = op.new;
  }
  // insert / delete 类似
  return { success: true, article };
}
```

成功后：更新画布 state → 序列化 blocks 为 MD 文本 → 写回 MD 文件 → watcher 触发增量索引。

---

## 7. 降级策略

| 故障场景 | 降级 |
|---------|------|
| Embedding API 超限/故障 | 文件正常保存，`files.indexed=0`，5 分钟后台重试，不阻塞写作 |
| 图片 fetch 失败 | `images.status=failed`，RAG 用文字，不阻塞 |
| 当前 embedding 模型不支持图片输入 | 图片向量跳过，文本索引与问答照常工作 |
| 向量零结果 | 降级 FTS5 全文，来源卡片标注"来自全文搜索" |
| LLM 调用失败 | 返回 `{error}`，前端 Toast，画布不变 |
| jieba-wasm 加载失败 | 回退到简化分词（拉丁词、中文单字、中文双字 gram），召回率下降但不崩溃 |
| 知识库无相关内容 | Prompt 强制 LLM 回复"笔记中没有这方面内容"，不幻觉 |
| str_replace Block ID 不存在 | 返回 BLOCK_NOT_FOUND，提示"AI 指定的块已不存在，请重试" |
| str_replace old 不匹配 | 返回 OLD_MISMATCH，提示"块内容已变化，请重新描述" |
| sqlite-vec 加载失败 | 健康检查失败，容器重启循环（修复：平台预编译扩展） |

---

## 8. 环境变量

```env
# Embedding
EMBEDDING_PROVIDER=qwen               # qwen | doubao | openai | custom（设置页显式选择）
EMBEDDING_MODEL=text-embedding-v3
EMBEDDING_DIM=1024                    # 千问 1024，豆包 2048
EMBEDDING_MULTIMODAL_ENABLED=false    # true 时尝试图片向量；需模型支持
EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# LLM
LLM_PROVIDER=qwen
LLM_MODEL=qwen-max
LLM_API_KEY=
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# 路径（懒猫容器内固定）
NOTES_DIR=/lzcapp/var/notes
ASSETS_DIR=/lzcapp/var/assets
DB_PATH=/lzcapp/var/data/index.db

# Next.js
NODE_ENV=production
PORT=3000
```

API Key 运行时可在设置页覆盖，优先级：设置页保存值 > 环境变量 > 空。

---

## 9. 懒猫微服部署（v1 单体）

### 9.1 `lzc-manifest.yml`

```yaml
package: cloud.lazycat.app.notus
version: 0.1.2
name: Notus
description: 私有化个人知识库与 AI 写作协作工具
license: MIT
author: YourName

application:
  subdomain: notus
  image: registry.lazycat.cloud/library/node:20-alpine
  upstreams:
    - location: /
      backend: http://127.0.0.1:3000
      disable_trim_location: true
      backend_launch_command: /bin/sh /lzcapp/pkg/content/lzc/run.sh
  environment:
    - NODE_ENV=production
    - PORT=3000
    - NOTES_DIR=/lzcapp/var/notes
    - ASSETS_DIR=/lzcapp/var/assets
    - DB_PATH=/lzcapp/var/data/index.db
  public_path:
    - /lzcapp/var/notes
    - /lzcapp/var/assets
    - /lzcapp/var/data
  health_check:
    start_period: "45s"
    test_url: "http://127.0.0.1:3000/api/health"

locales:
  zh:
    name: Notus
    description: 私有化个人知识库与 AI 写作协作工具
  zh_CN:
    name: Notus
    description: 私有化个人知识库与 AI 写作协作工具
  en:
    name: Notus
    description: Private personal knowledge base and AI writing assistant
```

**注意：** v1 单体架构（`application.upstreams` + `backend_launch_command`，无 `services` 块）。

### 9.2 `lzc-build.yml`

```yaml
buildscript: ./lzc/build-package.sh
contentdir: ./lzc-dist
```

### 9.3 `lzc/build-package.sh`

```bash
#!/bin/sh
set -e

DIST="lzc-dist"
rm -rf "$DIST" && mkdir -p "$DIST"

# 1. Next.js standalone 构建
npm ci
npm run build

# 2. 拷贝产物
cp -r .next/standalone/* "$DIST/"
cp -r .next/static "$DIST/.next/static"
cp -r public "$DIST/public"

# 3. sqlite-vec 原生扩展预编译
mkdir -p "$DIST/node_modules/sqlite-vec"
cp lzc/vendor/vec0-linux-${ARCH}.so "$DIST/node_modules/sqlite-vec/vec0.so"

# 4. 拷贝 lzc 目录和元数据
cp -r lzc "$DIST/"
cp LICENSE README.md "$DIST/" 2>/dev/null || true

chmod +x "$DIST/lzc/run.sh"
```

### 9.4 `lzc/run.sh`

```bash
#!/bin/sh
set -e

APP=/lzcapp/pkg/content
VAR=/lzcapp/var

# 确保持久化目录存在
mkdir -p "$VAR/notes" "$VAR/assets" "$VAR/data"

# 启动 Next.js
cd "$APP"
exec node server.js
```

### 9.5 打包约束清单

- [ ] `application` 块（非 `services`），v1 单体
- [ ] `backend` 指向 `http://127.0.0.1:3000`
- [ ] 镜像来自 `registry.lazycat.cloud`
- [ ] `public_path` 声明所有需持久化目录
- [ ] `locales` 至少 zh / zh_CN / en
- [ ] sqlite-vec 原生扩展按目标平台预编译（ARM64 / x86_64）
- [ ] `run.sh` 可执行、用 `exec` 启动主进程
- [ ] 可写数据全在 `/lzcapp/var/`，不写入 `/lzcapp/pkg/content/`
- [ ] Electron 打包前必须生成 `desktop/build/icon.icns` 与 `desktop/build/icon.ico`
- [ ] Electron 桌面资源目录必须按目标平台重新安装生产依赖，并补齐 `better-sqlite3` Electron 预编译包与对应 `sqlite-vec-*` 平台扩展

---

## 10. 开发子任务拆分

### M1 基础骨架

- M1-01 Next.js 15 Pages Router 项目初始化 + CSS Token 系统
- M1-02 `lib/db.js`：SQLite + sqlite-vec + WAL + 全量建表
- M1-03 `lib/indexer.js`：splitIntoChunks + indexFile + removeFile
- M1-04 `lib/embeddings.js`：千问/豆包双厂商封装
- M1-05 `lib/watcher.js`：chokidar + 增量索引
- M1-06 `.env.local.example` + pages/_app.js + 全局 CSS

### M2 文件管理 & 编辑器

- M2-01 App Shell（TopBar + Sidebar + Layout）
  - TopBar 顶部保存按钮统一承载 `saving / dirty / saved` 三种状态；其中 `dirty` 必须使用红色文字和红色边框，明确提示当前内容尚未保存
  - 文件页、知识库页、创作页在当前内容为 `dirty` 时，从侧边栏、顶部搜索或页内切换到其他文档前都必须先触发同一套未保存确认弹窗；确认保存或放弃后，才允许继续跳转
- M2-02 FileTree 组件 + `/api/files/*` API
- M2-03 WYSIWYG Markdown 编辑器 + Typora 风格 CSS
- M2-04 MarkdownRenderer（remark/rehype 插件链）
- M2-05 TocTree + 滚动高亮
- M2-06 URL hash 来源跳转 + 3s 高亮淡出
- M2-07 批量导入/导出 API + SSE 进度
- M2-08 `/indexing` 页面

### M3 知识库问答

- M3-01 `lib/retrieval.js`：查询规划、多路召回与章节证据扩展
- M3-02 jieba-wasm 集成 + FTS 分词
- M3-03 `lib/prompt.js`：知识库 Prompt 模板
- M3-04 `/api/chat` SSE 流式 API
- M3-05 ChatArea + SourceCard 组件
- M3-06 多模型切换下拉（支持搜索）

### M4 AI 创作画布

- M4-01 `lib/diff.js`：applyOperation + applyOperations + computeDiff
- M4-02 `/api/articles/parse` + `/api/articles/save`
- M4-03 `lib/style.js` + `lib/canvasRequestPlanner.js` + `lib/canvasAgent.js`
- M4-04 旧 intent / legacy agent 清理
- M4-05 大纲生成 `/api/agent/outline` SSE
- M4-06 Agent 运行 `/api/agent/run` SSE
- M4-07 CanvasBlock 组件（6 状态）+ dnd-kit 拖拽
- M4-08 AIPanel（后台事实补充 + 风格来源 + 对话 + 批量预览恢复）
- M4-09 新建创作入口页
- M4-10 编辑器"AI 创作"按钮流程
- M4-11 图片延迟处理后台任务 + 风格回填后台任务

### M5 体验打磨 & 部署

- M5-01 设置页（模型/存储/快捷键/关于 + 校验流程；LLM 预算字段持久化但不在卡片中展示）
- M5-02 CommandPalette（cmdk）
- M5-03 快捷键绑定
- M5-04 Toast 全局错误降级
- M5-05 主题样式基础（当前不单独提供外观设置入口）
- M5-06 `/setup` 三步引导
- M5-07 404 / 错误页
- M5-08 懒猫打包（lzc-manifest + build-package + run.sh）
- M5-09 sqlite-vec 双平台预编译验证
- M5-10 健康检查 + 启动时延调优

---

## 11. 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 路由模式 | Next.js Pages Router | AI 生成不易混淆 App/Pages 特性，JavaScript 更稳 |
| 向量库 | sqlite-vec | 零额外服务，个人量级够用，Next.js 直连 |
| 全文检索 | 应用层分词 + SQLite FTS5 | 不依赖 SQLite 自定义 tokenizer，单容器友好 |
| 检索融合 | RRF k=60 | 无需调参，效果稳定 |
| 阈值作用域 | 向量原始分 0.5 | RRF 分值量级 0.01~0.05 不适合固定阈值 |
| 分块粒度 | 标题层级优先 + AST 语义回退 | 让创作块更接近章节语义，同时保留代码块/表格完整性 |
| 画布编辑 | str_replace + Block ID + old 校验 | Claude Artifacts 同款，防 ID 错位 |
| 意图判断 | 内置请求规划 + 单次 helper 回退 | 避免双轨维护，继续控制额外 LLM 调用 |
| 图片处理 | 延迟按需 | 不阻塞主流程 |
| 维度配置 | 环境变量动态建表 | 千问 1024/豆包 2048 可切 |
| 部署架构 | 懒猫 v1 单体 | 单进程应用，无外部中间件 |
| 组件策略 | Radix Primitives + 手写样式 | 自定义 tokens 不适合 shadcn 覆写 |

---

**Notus PRD v2.1 · 配合 Notus PDD v2.0 使用**
