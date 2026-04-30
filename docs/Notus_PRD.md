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
| Embedding | 用户在设置页手动填写 Base URL、模型名与 API Key；系统根据 Base URL 和模型名自动识别兼容厂商，可选文本或多模态，开启 `EMBEDDING_MULTIMODAL_ENABLED` 后为图片建立向量 |
| LLM | 用户在设置页手动填写 Base URL、模型名与 API Key；系统根据 Base URL 和模型名自动识别兼容厂商，流式输出 |
| 运行平台 | 懒猫微服，**v1 单体模式** .lpk 打包（application + upstreams + backend_launch_command，单容器） |

**不用 TypeScript / App Router / shadcn-ui / Python sidecar** —— 减少复杂度、减少 AI 自动生成时的路由混淆、不依赖默认主题。

---

## 2. 目录结构

```
notus/
├── pages/
│   ├── _app.js                      # 全局样式、主题
│   ├── index.js                     # 重定向到 /files
│   ├── login.js                     # /login
│   ├── setup.js                     # /setup
│   ├── files/index.js               # /files
│   ├── knowledge.js                 # /knowledge（未选中文件时仅问答；历史会话全局化；支持手动指定参考来源与页内来源定位）
│   ├── canvas.js                    # /canvas（点击侧边栏文件后留在当前页创作；事实参考后台自动补充，仅前台展示风格来源；新大纲需先保存再继续 AI 改写）
│   ├── settings/
│   │   ├── index.js                 # /settings → /settings/model
│   │   └── [section].js             # /settings/model|storage|shortcuts|about
│   ├── indexing.js                  # /indexing
│   ├── 404.js                       # /404
│   └── api/                         # 所有 REST API（见 §5）
│       ├── health.js
│       ├── files/...
│       ├── index/...
│       ├── search.js
│       ├── chat.js
│       ├── agent/...
│       └── settings/...
├── lib/
│   ├── db.js                        # SQLite + sqlite-vec 初始化
│   ├── indexer.js                   # AST 分块 + 增量索引
│   ├── embeddings.js                # Embedding API 封装
│   ├── retrieval.js                 # 混合检索 + RRF
│   ├── prompt.js                    # Prompt 模板
│   ├── watcher.js                   # chokidar 文件监听
│   ├── agent.js                     # 创作 Agent 工具链
│   ├── diff.js                      # str_replace 引擎 + diff 计算
│   └── config.js                    # 环境变量读取
├── components/
│   ├── Layout/                      # TopBar, Sidebar, Shell
│   ├── FileTree/
│   ├── TocTree/
│   ├── Editor/                      # WYSIWYG Markdown 编辑器封装（含代码高亮）
│   ├── MarkdownRenderer/            # react-markdown + 插件
│   ├── ChatArea/                    # ChatMessage, SourceCard
│   ├── Canvas/                      # CanvasBlock, AddBlockButton
│   ├── AIPanel/                     # StyleSelector, OperationPreview
│   ├── Settings/                    # 设置页布局与分区内容
│   └── ui/                          # Button, Dialog, Input 等基础组件
├── styles/
│   └── globals.css                  # 所有 design tokens（PDD §6.1）
├── public/
├── lzc/
│   ├── build-package.sh             # 懒猫打包脚本
│   └── run.sh                       # 容器启动入口
├── lzc-manifest.yml                 # 懒猫运行配置
├── lzc-build.yml                    # 懒猫构建入口
├── lzc-icon.png
└── .env.local.example
```

**Next.js 使用 standalone 输出**（`next.config.js` 中 `output: 'standalone'`）。

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
  INSERT INTO chunks_fts(chunks_fts, rowid, content, search_text)
  VALUES('delete', old.id, old.content, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, search_text)
  VALUES('delete', old.id, old.content, old.search_text);
  INSERT INTO chunks_fts(rowid, content, search_text)
  VALUES (new.id, new.content, new.search_text);
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
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- 设置（键值对）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
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
 * 混合检索
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

**七步流程：**
1. 向量：`getEmbedding(query)` → `chunks_vec` KNN Top 20
2. FTS：jieba 分词 → `chunks_fts MATCH '词1 OR 词2 OR ...'` Top 20（索引字段为 `search_text`）
3. 合并去重：以 `chunk_id` 为 key
4. RRF：`1/(k+vec_rank) + 1/(k+fts_rank)`（未命中一侧为 0）
5. 重排序：heading 类型 +0.1，近 7 天修改 +0.05
6. 阈值过滤：**`vec_score < 0.5` 直接丢弃**（作用于向量原始分，非 RRF 分）
7. 取 Top K（问答 K=5，风格召回 K=3）

**降级：** 向量失败或零结果 → FTS5 兜底，结果标 `source: 'fts_only'`。`jieba-wasm` 失败 → `lib/tokenizer.js` 回退到简化分词（拉丁词、中文单字、中文双字 gram）。

### 4.5 `lib/prompt.js`

```javascript
function buildKnowledgePrompt(query, chunks)
function buildCanvasIntentPrompt(userInput, article)
function buildDraftBlockPrompt(blockId, instruction, styleChunks, contextBlocks)
// ... 9 个 Agent 工具对应的模板
```

所有 Prompt 声明"只能基于提供的上下文，不可推断；无相关内容直接说'笔记中没有这方面内容'"。

### 4.6 `lib/watcher.js`

```javascript
function startWatcher()  // chokidar 监听 NOTES_DIR
```

配置 `{ usePolling: true, interval: 3000, awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 500 } }`。监听 `add`/`change` → `indexFile`；`unlink` → `removeFile`。

### 4.7 `lib/agent.js`

```javascript
// 9 个工具的 schema（OpenAI tool_calls 格式）
const tools = [
  { name: 'search_knowledge', parameters: {...} },
  { name: 'get_style_samples', parameters: {...} },
  { name: 'get_outline', parameters: {...} },
  { name: 'draft_block', parameters: {...} },
  { name: 'expand_block', parameters: {...} },
  { name: 'shrink_block', parameters: {...} },
  { name: 'polish_style', parameters: {...} },
  { name: 'insert_block', parameters: {...} },
  { name: 'delete_block', parameters: {...} },
];

/**
 * 执行 Agent 循环
 * @param {string} userInput
 * @param {Article} article
 * @param {(chunk) => void} onStream
 * @returns {Promise<{operations: Operation[], citations: Chunk[]}>}
 */
async function runAgent(userInput, article, onStream)
```

### 4.8 `lib/diff.js`

```javascript
/**
 * str_replace 操作，Block ID 优先 + old 字段二次校验
 * @param {Article} article
 * @param {Operation} op
 * @returns {{success, article?, error?}}
 */
function applyOperation(article, op)

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

**匹配失败时：** 返回 `{ success: false, error: 'BLOCK_NOT_FOUND' | 'OLD_MISMATCH' }`，前端提示，画布不变。

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
                                       { type: 'chunks', chunks }
                                       { type: 'token', text }
                                       { type: 'citations', citations }   // citations 支持图片字段
                                       { type: 'done', conversation_id, message_id }
                                       { type: 'error', error, conversation_id? }
```

严格 RAG：无检索结果时 SSE 推 `{ type: 'token', text: '笔记中没有这方面的内容。' }`。

### 5.5 创作 Agent

```
POST /api/agent/intent               Body: { user_input, article_id? }
                                     → { intent: 'knowledge'|'canvas', confidence }

POST /api/agent/outline              Body: { topic }
                                     → SSE:
                                       { type: 'block', block }
                                       { type: 'done', citations }
                                       { type: 'error', error }

POST /api/agent/run                  Body: {
                                       conversation_id?, user_input,
                                       article: Article,
                                       reference_mode?, fact_file_ids?,
                                       style_mode?, style_file_ids?
                                     }
                                     → SSE:
                                       { type: 'thinking', text }
                                       { type: 'tool_call', name, args }
                                       { type: 'tool_result', data }
                                       { type: 'operation', operation, diff }
                                       { type: 'done', conversation_id, message_id, citations }
                                       { type: 'error', error, conversation_id? }

POST /api/agent/apply                Body: { article_id?, article: Article, operation }
                                     → { success, article?, error? }
                                     若 article.file_id 或 article_id 存在，则应用 operation → 同步写 MD → 触发增量索引
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
GET    /api/conversations/:id        → { ...conversation, messages }
DELETE /api/conversations/:id
```

- 知识库页默认只按 `kind=knowledge` 读取全局历史，不再用 `file_id` 分桶。
- 创作页会话默认按 `kind=canvas + file_id` 读取；`draft_key` 仅保留给旧数据兼容与迁移。

### 5.8 设置

```
GET  /api/settings                   → { notes_dir, assets_dir, setup_completed, embedding, llm }
PUT  /api/settings                   Body: {
                                       notes_dir?, assets_dir?, setup_completed?,
                                       embedding?: { provider?, model?, dim?, multimodal_enabled?, base_url?, api_key? },
                                       llm?: { provider?, model?, base_url?, api_key? }
                                     }
                                     → 持久化到 settings 表
POST /api/settings/test              Body: { kind: 'embedding'|'llm', config }
                                     → { success, error?, latency_ms? }
```

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

向量化输入 = `{heading_path}\n{content}`（拼接后 embedding）。

**增量索引：** hash 比对 → 相同跳过 / 不同 CASCADE 删除旧块 + 重新索引。

**Embedding 失败重试：** `setInterval(5 * 60 * 1000)` 扫描 `files.indexed=0` 重试；失败次数通过 `settings` 表记录，超过 5 次停止自动重试。

### 6.2 混合检索

流程见 §4.4。中文分词使用 `jieba-wasm` 的 `cut_for_search` 模式，在应用层生成 `search_text` 并构造 FTS 查询；长度超 20 词截断。

### 6.3 图片缓存与图片向量

- 索引时提取 Markdown 图片语法，写入 `images` 表，记录 `url / alt_text / cache_status / embedding_status`
- 远程图片通过 `/api/files/:id/content-image?src=...` 代理下载到 `/lzcapp/var/assets/images/{sha256}.{ext}`
- 代理只允许 `http/https`，并阻止 localhost、内网地址和非法协议，避免服务端请求风险
- 缓存成功且开启 `EMBEDDING_MULTIMODAL_ENABLED` 时，调用第三方多模态 embedding 模型写入 `images_vec`
- 若当前 embedding 模型不支持图片输入，则标记 `embedding_status=skipped`，不影响文本索引和检索
- 缓存或图片向量失败只记录数据库状态；页面请求图片时会 307 回到原外链，文章仍能显示

### 6.4 创作 Agent 工具链

| 工具 | 输入 | 输出 |
|------|------|------|
| search_knowledge | `{query, topK}` | `{chunks}` |
| get_style_samples | `{topic, k=3}` | `{samples: Chunk[]}` |
| get_outline | `{topic, references}` | `{outline: Block[]}` |
| draft_block | `{block_id, instruction, style_samples, context}` | `{operation}` |
| expand_block | `{block_id, context}` | `{operation}` |
| shrink_block | `{block_id, target_length?}` | `{operation}` |
| polish_style | `{block_id, style_samples}` | `{operation}` |
| insert_block | `{position, content}` | `{operation}` |
| delete_block | `{block_id}` | `{operation}` |

**意图识别：** 当前通过独立 `/api/agent/intent` 返回 `{ intent, confidence }`；当 LLM 失败时回退到规则判断，保证入口可用。

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
- M2-02 FileTree 组件 + `/api/files/*` API
- M2-03 WYSIWYG Markdown 编辑器 + Typora 风格 CSS
- M2-04 MarkdownRenderer（remark/rehype 插件链）
- M2-05 TocTree + 滚动高亮
- M2-06 URL hash 来源跳转 + 3s 高亮淡出
- M2-07 批量导入/导出 API + SSE 进度
- M2-08 `/indexing` 页面

### M3 知识库问答

- M3-01 `lib/retrieval.js`：hybridSearch 七步
- M3-02 jieba-wasm 集成 + FTS 分词
- M3-03 `lib/prompt.js`：知识库 Prompt 模板
- M3-04 `/api/chat` SSE 流式 API
- M3-05 ChatArea + SourceCard 组件
- M3-06 多模型切换下拉（支持搜索）

### M4 AI 创作画布

- M4-01 `lib/diff.js`：applyOperation + computeDiff
- M4-02 `/api/articles/parse` + `/api/articles/save`
- M4-03 `lib/agent.js`：9 个工具 schema + runAgent
- M4-04 意图识别 Prompt + `/api/agent/intent`
- M4-05 大纲生成 `/api/agent/outline` SSE
- M4-06 Agent 运行 `/api/agent/run` SSE
- M4-07 CanvasBlock 组件（6 状态）+ dnd-kit 拖拽
- M4-08 AIPanel（后台事实补充 + 风格来源 + 对话 + OperationPreview）
- M4-09 新建创作入口页
- M4-10 编辑器"AI 创作"按钮流程
- M4-11 图片延迟处理后台任务

### M5 体验打磨 & 部署

- M5-01 设置页（模型/存储/快捷键/关于 + 校验流程）
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
| 意图判断 | 独立 `/api/agent/intent` + 规则回退 | LLM 失败时仍能给出可用判断 |
| 图片处理 | 延迟按需 | 不阻塞主流程 |
| 维度配置 | 环境变量动态建表 | 千问 1024/豆包 2048 可切 |
| 部署架构 | 懒猫 v1 单体 | 单进程应用，无外部中间件 |
| 组件策略 | Radix Primitives + 手写样式 | 自定义 tokens 不适合 shadcn 覆写 |

---

**Notus PRD v2.1 · 配合 Notus PDD v2.0 使用**
