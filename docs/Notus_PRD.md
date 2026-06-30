# Notus 产品需求文档（PRD）

> v2.1 · 由 PDD 派生 · 接口级技术实现规范（数据库 schema、API、关键函数签名）

---

## 1. 技术栈

| 层次 | 技术选型 |
|------|---------|
| 前端框架 | Next.js 15（**Pages Router**，非 App Router）+ React 19 |
| 语言 | JavaScript（暂不引入 TypeScript） |
| 包管理器 | npm |
| UI 组件策略 | Radix Primitives（行为）+ 手写样式（token 驱动）；编辑器 Tiptap + tiptap-markdown + `@tiptap/extension-mathematics` + lowlight；渲染 react-markdown；拖拽 @dnd-kit/core；命令面板 cmdk |
| MD 渲染插件链 | remark-gfm + remark-math + rehype-highlight + rehype-katex |
| 数据库 | SQLite（better-sqlite3），WAL 模式 |
| 向量检索 | sqlite-vec（SQLite 扩展） |
| 全文检索 | SQLite FTS5（应用层预分词写入 `search_text`） |
| 中文分词 | jieba-wasm（应用层分词，失败时回退简化分词） |
| 文件监听 | chokidar（usePolling:true, interval:3000ms, awaitWriteFinish） |
| Embedding | 用户在设置页手动填写 Base URL、模型名与 API Key；设置页与 /setup 第 1 步首次进入时表单先以空态呈现，读取到服务端已保存配置后只回填 Base URL 与模型名，API Key 不明文回显，也不展示“已保存密钥”类提示；系统根据 Base URL 和模型名自动识别兼容厂商，可选文本或多模态，测试通过后在后端记录向量维度并用于索引 |
| LLM | 用户在设置页手动填写 Base URL、模型名与 API Key，并在新增/编辑弹窗选择兼容协议：OpenAI API 或 Anthropic；默认协议为 OpenAI API，历史配置按 OpenAI API 迁移；系统根据 Base URL 和模型名自动识别 Provider name，流式输出；LLM 配置保存不要求先测试连通性，设置页和引导页使用 notus-agent.html 的暖白单栏卡片、朴素列表和 448px 表单弹窗样式，知识库页与创作页以输入框模型下拉框当前选择作为全局模型选择 |
| 运行平台 | Web + Electron 桌面端主线，保留对懒猫运行时的代码兼容；业务层统一依赖平台中间层解析路径与能力 |

**不用 TypeScript / App Router / shadcn-ui / Python sidecar** —— 减少复杂度、减少 AI 自动生成时的路由混淆、不依赖默认主题。

### 1.1 长期产品形态约束

Notus 的长期形态不是“知识库问答 + 普通文件改写”，而是本地 Markdown 工作区中的 AI 协作环境。技术实现需要遵守以下约束：

- 文件系统是真相来源，数据库只保存索引、缓存、会话、预览和运行状态。
- Agent 的上下文来自工作区状态：当前文件、当前目录、用户选择的范围、检索证据、风格参考、对话历史和运行配置。
- 任何写入 Markdown 的能力都必须先形成可审查结果；单文件使用块级 diff，多文件使用批量预览。
- 检索范围、写入范围和风格参考范围要逐步从请求参数升级为会话级产品状态，并在 UI 中可见。
- 通用知识和用户笔记依据必须分开表达，服务端不能把模型自身知识混入“来自笔记”的证据链。
- 新能力优先以工作区工具形式扩展，例如读取文件、搜索工作区、创建笔记、更新 frontmatter、生成多文件预览、整理目录和检查内部链接。

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
│   │   ├── agentSession.js         # Agentic Loop 会话、权限、快照和回滚
│   │   ├── agentTools.js           # Agentic Loop 工具集
│   │   ├── agentLoop.js            # Agentic Loop 主循环
│   │   ├── agentLoopPrompt.js      # Agentic Loop Prompt 模板
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

长期目标中，`files` 表承担文档元数据表职责，`.md` 正文仍从文件系统读取。为了支持路径变更、多文件任务和工作区级 Agent，后续需要在不破坏现有整数主键的前提下补强稳定身份和文件状态字段：

| 字段 | 所属表 | 作用 |
|------|--------|------|
| `stable_id` | `files` | 跨路径稳定文档身份，可来自 frontmatter id，也可由系统生成 |
| `size` | `files` | 文件字节数，用于启动对账和变化判断 |
| `mtime` | `files` | 文件修改时间，用于快速判断外部变更 |
| `char_count` / `token_count` | `files` | 文档级上下文预算判断 |
| `frontmatter` | `files` | frontmatter JSON 缓存，不作为正文存储 |
| `tags` | `files` | 从 frontmatter 提取的标签 JSON 数组，用于后续范围过滤 |
| `heading_outline` | `files` | 章节结构缓存，用于文档级上下文选择 |
| `index_version` | `files` | 索引算法升级时触发重建 |
| `source_hash` | `chunks` | 生成 chunk 时的文件 hash，用于识别过期索引 |
| `index_version` | `chunks` | 生成 chunk 时使用的索引算法版本 |

其中 `stable_id` 不替换现有 `files.id`。`files.id` 继续作为 SQLite 内部关联主键，`stable_id` 用于长期引用、路径变更识别和未来多文件任务。

### 3.1 建表语句

```sql
-- 文件元数据
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE NOT NULL,           -- 相对 /notes/ 的路径
  title       TEXT,                            -- 从 frontmatter.title、首个 h1 或文件名提取
  stable_id   TEXT,                            -- frontmatter id 或 notus_ 前缀生成 ID
  hash        TEXT,                            -- 文件内容 SHA-256
  size        INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  char_count  INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER NOT NULL DEFAULT 0,
  frontmatter TEXT,
  tags        TEXT,
  heading_outline TEXT,
  index_version INTEGER NOT NULL DEFAULT 1,
  indexed     INTEGER DEFAULT 0,               -- 0=未索引 1=已索引
  indexed_at  DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_indexed ON files(indexed);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_stable_id
  ON files(stable_id)
  WHERE stable_id IS NOT NULL AND stable_id != '';
CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);

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
  search_text  TEXT,                            -- 应用层分词后的检索字段
  source_hash  TEXT,                            -- 生成 chunk 时的文件 hash
  index_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_position ON chunks(file_id, position);
CREATE INDEX IF NOT EXISTS idx_chunks_source_hash ON chunks(source_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_index_version ON chunks(index_version);

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
  read_scope TEXT,                             -- JSON：允许读取哪些 Markdown
  retrieval_scope TEXT,                        -- JSON：检索召回范围
  write_scope TEXT,                            -- JSON：允许生成修改预览的范围
  style_scope TEXT,                            -- JSON：风格参考范围
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,               -- 'user' | 'assistant' | 'tool' | 'system'
  type            TEXT NOT NULL DEFAULT 'text', -- 'text' | 'parsed_attachment'
  content         TEXT NOT NULL,               -- JSON 字符串
  citations       TEXT,                         -- JSON 数组，来源块元数据
  meta            TEXT,                         -- JSON 对象，知识库回答模式/检索统计/helper 遥测
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_attachment ON messages(conversation_id, type, created_at);

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
  agent_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
  file_id         INTEGER REFERENCES files(id) ON DELETE SET NULL,
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  article_hash    TEXT NOT NULL,
  mode            TEXT NOT NULL,
  operations_json TEXT NOT NULL,                 -- 旧块级 operation set
  pathes_json     TEXT,                          -- Agentic Loop 文件级 patches；字段名按已确认口径保留 pathes_json
  status          TEXT NOT NULL DEFAULT 'pending',
  expires_at      DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id        INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',
  goal                   TEXT NOT NULL,
  authorized_paths       TEXT NOT NULL DEFAULT '[]',
  authorized_ops         TEXT NOT NULL DEFAULT '["modify","create"]',
  created_files          TEXT NOT NULL DEFAULT '[]',
  loop_count             INTEGER NOT NULL DEFAULT 0,
  soft_limit             INTEGER NOT NULL DEFAULT 15,
  hard_limit             INTEGER NOT NULL DEFAULT 30,
  search_knowledge_limit INTEGER,
  tool_call_counts       TEXT NOT NULL DEFAULT '{}',
  consecutive_fails      TEXT NOT NULL DEFAULT '{}',
  last_tool_results      TEXT NOT NULL DEFAULT '{}',
  messages_checkpoint    TEXT,
  checkpoint_tool_use_id TEXT,
  waiting_since          TEXT,
  session_token          TEXT UNIQUE NOT NULL,
  expires_at             TEXT,
  created_at             TEXT DEFAULT (datetime('now')),
  updated_at             TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,
  content      TEXT NOT NULL,
  file_hash    TEXT NOT NULL,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_run_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  loop_index   INTEGER NOT NULL,
  tool_name    TEXT,
  tool_input   TEXT,
  tool_result  TEXT,
  thinking     TEXT,
  status       TEXT NOT NULL DEFAULT 'success',
  duration_ms  INTEGER,
  created_at   TEXT DEFAULT (datetime('now'))
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

### 4.0 工作区 Agent 目标分层

当前版本的知识库问答和创作画布已经接入工作区 Agent 基础能力：创作页主输入统一进入 Agentic Loop，并在输入框提供“自动确认 / 手动确认”模式选择；知识库页普通问答继续走 `/api/chat`，写作类任务按保守关键词规则进入 Agentic Loop。Loop 会话在开始执行前创建快照，写入前做系统层权限校验，并支持对话底部逐文件确认、回滚和废弃。旧 `/api/agent/run` 保留为历史兼容接口，不作为创作页主入口。

```
用户界面层
  - 当前文件 / 目录 / 选中文件 / 全库范围
  - 只读分析 / 生成预览 / 确认写入
  - 风格参考范围

会话状态层
  - conversation.kind
  - read_scope / retrieval_scope / write_scope / style_scope
  - 当前任务、交互卡片、批量预览、最近决策摘要

前端工作区本地状态层
  - activeFileId / activePage
  - openFolders / sidebarCollapsed
  - sidebarActiveTab / sidebarScrollByTab
  - files / knowledge / canvas 浏览位置锚点

工作区工具层
  - search_knowledge / read_file
  - create_note / preview_patch_files
  - analyze_folder / check_links

执行与审查层
  - 单文件块级 diff
  - 多文件批量预览
  - 高风险操作确认
  - 应用后自动索引
  - 任务级快照与文件级确认/回滚
```

当前工具集不开放删除、重命名、移动或系统命令能力；删除在任意 Agentic Loop 写入校验路径下都会被拒绝。

`validateWrite()` 按操作类型区分授权边界：`modify` 只允许精确授权文件或授权目录下的文件；`create` 允许在授权目录下新建文件，如果授权项是某个 `.md` 文件，则只额外允许在该文件父目录中新建文件，不扩大同目录其他文件的修改权限。

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
2. 解析 frontmatter、tags、heading outline、size、mtime、char_count、token_count
3. 查 files 表，hash 与 `index_version` 均未变化 → 更新轻量元数据并返回 `{skipped: true}`
4. hash 或版本变化 → 删除旧 chunks 与对应向量，只重建当前文件
5. `splitIntoChunks` 分块
6. 事务批量写 chunks 表，写入 `source_hash` 和 `index_version`（FTS 触发器自动同步）
7. 批量生成 embedding，写 `chunks_vec`
8. Embedding 失败 → 标记 `files.indexed = 0`，不抛错，后台任务重试
9. 成功 → 更新 files 表 hash、indexed=1、indexed_at、index_version

迁移要求：

- `lib/db.js` 只能做非破坏性 `ALTER TABLE` 和索引补齐，不得在普通迁移中清空 `chunks_vec`
- `chunks.source_hash` 初次迁移时回填为对应 `files.hash`
- 切换 embedding 维度时仍由 `resetVec(dim)` 显式重建向量表
- `stable_id` 不替代现有 `files.id`，旧向量仍通过 `chunks.id -> chunks_vec.chunk_id` 关联

`stable_id` 策略：

- frontmatter 有唯一 `id` 时使用它
- 没有 frontmatter id 时仅在数据库生成 `notus_` 前缀 ID
- 旧 Markdown 不批量写回 frontmatter
- Notus 新建 Markdown 时写入 frontmatter id
- 重复 frontmatter id 不覆盖既有文件身份，当前文件使用数据库生成 ID

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

新增 `retrieveWorkspaceDocuments(queryPlan, opts)`，在保留现有 `hybridSearch()` 与 `retrieveKnowledgeContext()` 的基础上增加文档级上下文：

- 根据命中 chunks / sections 聚合到 `file_id`
- 通过 `files.path` 从文件系统读取真实 Markdown 正文
- 重新计算当前文件 hash；若与 `files.hash` 不同，返回 `stale_index: true`，本次仍使用最新正文
- 小文档传完整正文；超出单文档预算时传 heading outline、命中章节和相邻上下文，并标记 `truncated: true`
- SSE 只返回 `document_summaries` 与 `document_stats`，不把完整正文直接发给前端

其中：

- `query_plan` 固定包含 `intent / clarity_score / ambiguity_flags / clarify_needed / clarify_question / clarify_reason / clarify_intro / clarify_questions / clarify_render_mode / rewrite_strategy`
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
9. 将候选 chunk/section 聚合为文档级上下文，从文件系统读取真实 Markdown
10. 必要时对最多 8 个 section 做单次条件 rerank

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

`clarify_needed` 和 `no_evidence` 由服务端直接模板化返回，不走主回答 Prompt。知识库命中 `clarify_needed` 时，服务端会直接创建 `conversation_interactions` 记录，并把提问卡片需要的结构化问题、引导语和状态元信息通过 SSE 一并返回。

### 4.6 `lib/watcher.js`

```javascript
function startWatcher()  // chokidar 监听 NOTES_DIR
```

配置 `{ usePolling: true, interval: 3000, awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 500 } }`。监听 `add`/`change` → `indexFile`；`unlink` → `removeFile`。

### 4.7 创作执行链路

创作页主输入默认使用自动确认模式：发送后直接调用 `/api/agent/loop/start`，不展示任务确认卡；输入框左下角的“自动 / 手动”分段确认控件只在创作页展示，说明文案进入 tooltip，并持久化到浏览器本机。手动确认模式下同样直接启动 Agentic Loop，文件级预览在完成消息底部以摘要卡等待处理，用户打开 DiffDialog 后逐文件应用或回滚。旧 `/api/agent/run` + `/api/agent/apply` 只保留历史兼容，不再作为当前主流程。

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
   - **LLM 是唯一意图决策者**：每次请求都调用一次 `canvas_query_plan` LLM（`target_resolver` 模式），由其决定 `primary_intent / operation_kind / target_refs / scope_mode / clarify_needed`；结果命中 3 分钟内存缓存（articleHash + historyDigest + userInput 三元组）
   - LLM 调用前做无歧义词法预处理，结果作为候选上下文传入 LLM，不直接决策：`@bN / @b2-b5 / 第 N 段`（显式块引用）、`全文 / 整篇`（全局范围）
   - 对”把/将 A 改为/换成/换为/替换为/替换成 B”以及省略前缀的 `A 改为 B / A 换为 B` 这类精准替换短语，LLM 确认 `edit` 意图且目标唯一时，走 `buildDeterministicReplaceOperation` 字符串精准替换，不再额外调用 LLM 生成编辑内容
   - 固定输出 `primary_intent / intent_confidence / target_candidates / source_candidates / source_content_type / target_anchor / position_relation / write_action / risk_level / decision_path / decision_summary / ai_arbitration_mode`
   - 兼容保留旧字段 `intent / scope_mode / target_block_ids / candidate_block_ids / operation_kind / clarify_needed / clarify_reason / missing_slots / prefilled_answers / answer_slots / summary_instruction`
   - LLM 调用失败时保守返回 `clarify_needed=true + reason=ai_arbitration_unavailable`，不静默 fallback 到 text
2. `runCanvasAgent()`：
   - `clarify_needed` 优先转结构化 interaction；超过两轮或不适合结构化时退回自然语言追问
   - `text` 走流式文本回复
   - `analyze` 走文章分析文本回复
   - `edit` 走单块 / 多块 / 全文分批执行器
   - 当 `deterministic_edit + 单块唯一命中` 同时成立时，执行器可直接构造同块 `replace` 预览，不再额外调用 LLM
   - 编辑模型返回非 JSON 或混合文本时，执行器对前端继续返回 `{ summary: 'AI 返回格式异常，请重试。', operations: [] }`；同时写入 `canvas.operation_json.invalid` warning 日志，记录 `scope_mode / operation_kind / allowed_block_ids / raw_content_preview`
   - 对“把上面的内容写到文档中”这类已冻结来源内容的请求，优先用来源快照直接构造写入预览，不重新生成同一段正文
   - 续跑 interaction 前必须基于最新 `article.blocks` 重新校验 `target_block_id`；如果块已不存在，返回新的 `clarify_needed`，只要求重新确认位置，不允许继续硬跑到 `BLOCK_NOT_FOUND`
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

复用 `conversation_interactions` 作为知识库页与创作页共用的结构化提问持久化表，核心字段：

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
- 创作页续跑前必须再次校验 `article_hash` 与 `source_content_digest`
- 知识库页续跑前必须再次校验当前检索范围 hash，并通过 `buildKnowledgeClarifiedQuery()` 把原问题与结构化答案拼成 clarified query
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
                                       embedding_provider, embedding_multimodal_enabled,
                                       llm_provider, llm_api_protocol
                                     }
POST /api/setup/complete             Body: {
                                       notes_dir?,
                                       embedding_provider?, embedding_model?, embedding_dim?, embedding_api_key?,
                                       embedding_multimodal_enabled?,
                                       llm_provider?, llm_api_protocol?, llm_model?, llm_api_key?
                                     }
                                     → { ok, notes_dir, embedding_provider, llm_provider, llm_api_protocol }
```

### 5.2 文件管理

```
GET  /api/files                      → Array<{id, path, title, indexed, updated_at}>
GET  /api/files/tree                 → Array<folder|file 节点>
                                     file: { type:'file', id, name, path, indexed, status, updated_at }
                                     folder: { type:'folder', name, path, children }
GET  /api/files/:id                  → { id, path, title, name, content, indexed, updated_at }
POST /api/files                      Body: { path, content?, kind?: 'file'|'folder' } → 创建文件或文件夹
PUT  /api/files/:id                  Body: { content } → 保存 + 触发增量索引；响应非破坏性新增 `title_binding_applied`、`title_binding_warning`
DELETE /api/files/:id
POST /api/files/rename               Body: { old_path, new_path } 或 { id, name } → 重命名；响应非破坏性新增 `title_binding_applied`、`title_binding_warning`
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
GET  /api/files/export               Query: ?ids=1,2 or ?paths=a.md,b.md → 统一返回 ZIP；选中 Markdown 位于 notes/ 下，资源目录按相对位置一并导出；`Content-Disposition` 需兼容中文文件名
POST /api/files/:id/images           FormData:image → 保存到 assets/images/{sha256}.{ext}，返回相对当前 Markdown 的图片路径
GET  /api/files/:id/content-image    Query: ?src=... → 本地相对图片按当前文件路径解析并返回；远程图片缓存后返回，失败时 307 回源
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
                                       conversation_id?, query?, interaction_id?, model?,
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
                                         clarify_reason?, clarify_intro?,
                                         interaction?,
                                         helper_call_type, helper_call_triggered,
                                         helper_call_cache_hit, helper_call_latency_ms,
                                         helper_call_failed, fallback_reason }
                                       { type: 'token', text }
                                       { type: 'citations', citations }   // citations 支持图片字段
                                       { type: 'usage', usage, budget, compacted }
                                       { type: 'done', conversation_id, message_id,
                                         answer_mode, confidence, meta, interaction?,
                                         usage?, budget?, compacted? }
                                       { type: 'error', error, conversation_id?, request_id }
```

严格 RAG：

- `clarify_needed`：只返回引导语和结构化抽屉，不检索，不调用主回答模型
- `no_evidence`：直接模板化返回“未找到足够证据”
- `weak_evidence`：允许保守回答，但不能新增事实结论

### 5.5 创作 Agent

```
POST /api/agent/outline              Body: { topic }
                                     → SSE:
                                       { type: 'block', block }
                                       { type: 'done', citations }
                                       { type: 'error', error }

POST /api/agent/run                  Body: {                 // 历史兼容，不作为创作页主入口
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

POST /api/agent/apply                Body:                   // 历史兼容，不作为 Agentic Loop 应用入口
                                     { article: Article, operation }
                                     | { article: Article, operations: Operation[], operation_set_id? }
                                     | { action: 'cancel', operation_set_id }
                                     → { success, article?, error?, applied_count, failed_at, operation_set_status }

POST /api/agent/loop/start           Body:
                                     { goal, conversation_id?, active_file_id?, authorized_paths, authorized_ops?, search_knowledge_limit?, llm_config_id }
                                     | { session_id, session_token, llm_config_id }
                                     → SSE:
                                       { type: 'session_created' | 'session_resumed', session_id, conversation_id }
                                       { type: 'snapshot_done', snapshot_count }
                                       { type: 'loop_start', loop_index }
                                       { type: 'thinking', text, loop_index }
                                       { type: 'tool_start', tool_name, tool_input_summary, loop_index }
                                       { type: 'tool_done', tool_name, result_summary, failed, loop_index }
                                      { type: 'loop_done', reason, loop_index, operation_set_id? }
                                      { type: 'error', error, code }

POST /api/agent/loop/apply           Body:
                                     { session_id, session_token, current_conversation_id, operation_set_id, action: 'apply_file', patch_index?, file_path? }
                                     | { session_id, session_token, current_conversation_id, operation_set_id, action: 'rollback_file', patch_index?, file_path? }
                                     | { session_id, session_token, current_conversation_id, operation_set_id, action: 'discard_file', patch_index?, file_path? }
                                     | { session_id, session_token, current_conversation_id, operation_set_id, action: 'discard_pending' }
                                     | { session_id, session_token, current_conversation_id, operation_set_id, action: 'apply_all' }
                                     | { session_id, session_token, action: 'extend', extra_loops? }
                                     → { success, changed_files?, conflict?, conflicting_files?, operation_set?, new_hard_limit? }

POST /api/agent/loop/cancel          Body: { session_id } → { success }
GET  /api/agent/sessions/:id         → { session, run_logs, snapshots_count, operation_sets }
POST /api/agent/sessions/:id/rollback Body: { force? } → { success, restored_count, conflicts? }

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
GET    /api/conversations/:id        → { ...conversation, messages, pending_operation_sets, pending_interactions, agent_sessions }
DELETE /api/conversations/:id
```

- 知识库页默认只按 `kind=knowledge` 读取全局历史，不再用 `file_id` 分桶。
- 创作页默认只按 `kind=canvas` 读取全局创作历史，不再用 `file_id` 或 `draft_key` 分桶；`file_id` 和 `draft_key` 仅保留给旧数据兼容、会话详情和服务端上下文。
- 画布会话详情会附带 `pending_operation_sets`，前端刷新后可恢复全部未应用预览。
- 知识库与画布会话详情都会附带 `pending_interactions`，前端刷新后可恢复 `pending / stale / failed` 提问卡片；提问卡片继续以底部抽屉形式恢复，不再把 interaction 摘要用户消息和 retry 助手消息重新露回消息流。
- 会话详情会附带同一 conversation 下的 `agent_sessions` 导出数据，每个 session 包含运行状态、快照数量、`agent_run_logs` 工具日志和关联修改预览，但不返回 session token。
- 会话列表会附带 `agent_session_count`，前端用于在历史抽屉显示 Agent Loop 执行日志入口。
- 删除会话前需要确认会话存在；不存在返回 `404 CONVERSATION_NOT_FOUND`，删除成功返回 `204`。数据库外键负责级联删除 `messages`、`canvas_operation_sets` 和 `conversation_interactions`。
- 历史抽屉删除当前会话后，知识库页回到新对话空态；创作页回到当前文章的新对话空态，并保留文章块内容和未保存状态。

### 5.8 设置

```
GET  /api/settings                   → { notes_dir, assets_dir, setup_completed, embedding, llm, editor, layout }
PUT  /api/settings                   Body: {
                                       notes_dir?, assets_dir?, setup_completed?,
                                       embedding?: { provider?, model?, dim?, multimodal_enabled?, base_url?, api_key? },
                                       llm?: { provider?, api_protocol?, model?, base_url?, api_key? },
                                       editor?: { title_filename_binding_enabled? },
                                       layout?: { knowledge_left_percent?, canvas_left_percent? }
                                     }
                                     → 持久化到 settings 表
POST /api/settings/test              Body: { kind: 'embedding'|'llm', config }
                                     → { success, error?, latency_ms? }
```

- `layout.knowledge_left_percent`：知识库页左侧编辑区宽度百分比
- `layout.canvas_left_percent`：创作页左侧画布区宽度百分比
- `editor.title_filename_binding_enabled`：标题与文件名双向绑定开关，默认 `false`

### 5.9 前端工作区本地状态

浏览器本地状态不进入服务端数据库，统一存储在 `localStorage`：

- `notus-workspace-state`：保存 `activeFileId / activePage / openFolders / sidebarCollapsed / pendingCitation / sidebarActiveTab / sidebarScrollByTab`
- `sidebarActiveTab` 只允许 `tree | toc`；当前页面没有大纲时 UI 临时显示 `tree`，但不覆盖用户在文件页留下的 `toc` 偏好
- `sidebarScrollByTab` 分别保存文件树和大纲滚动位置，侧边栏展开、跨页返回和 tab 切换后恢复对应位置
- `notus-view-position-v1`：保留 `files:file:<id>`、`knowledge:file:<id>`、`canvas:file:<id>` 页面级记录，并新增 `document:file:<id>` 作为同一文档跨页面共享的最近位置；恢复时按 `updatedAt` 选择较新的记录
- 文件页与知识库页保存 Tiptap 滚动容器的 `scrollTop / scrollProgress`、当前可见文本锚点及其 `viewportOffset`；恢复时优先按文本锚点定位，找不到再按滚动进度回退
- 创作页保存当前可见 block 的 `blockId`、正文文本、`viewportOffset` 和 `scrollProgress`；编辑器与创作块之间允许通过正文文本互相匹配
- 普通滚动仅在停止 `240ms` 后保存；`routeChangeStart / beforeunload / pagehide` 同步写入。恢复未完成时禁止初始化滚动覆盖共享位置
- `pendingCitation`、URL 行号 / 预览参数和 hash 行号属于显式定位，优先级高于历史浏览位置
- AI 聊天滚动位置不保存，继续维持自动滚到最新消息

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

- 查询规划：结合最近若干轮 `user + assistant` 历史，生成更适合检索的独立问题、扩写问题、关键词和标题线索，并固定输出 `clarity_score / ambiguity_flags / clarify_needed / clarify_question / clarify_reason / clarify_intro / clarify_questions / clarify_render_mode / rewrite_strategy`
- 文件级命中：先用 `files_fts` 找文档标题和路径
- chunk 级混合检索：对多个 query variant 并行执行向量召回、FTS 召回与图片向量召回
- 章节证据扩展：命中 seed chunk 后，补齐同 heading 下的邻近 chunk，合并为可直接回答的 section 证据包
- 条件 rerank：仅在复杂问题或候选不稳定时触发，且一轮只允许一次 helper
- 证据保守策略：只命中文档标题但正文证据不足时，明确说明“已定位到相关文档，但正文证据有限”
- 展示口径统一：SSE 需显式回传 `source_count`，让检索状态条、助手消息元数据和最终来源卡片使用同一份来源计数；检索状态、补充说明和来源卡片在前端与 AI 回复正文共用同一个回复容器；AgentWorkspace 中的知识库引用必须复用 `SourceCard` 垂直来源列表并保留选中态；只命中文档标题且正文几乎没有有效内容的候选，不进入最终来源卡片
- 回答模式：固定为 `clarify_needed / grounded / weak_evidence / conflicting_evidence / no_evidence`
- helper 缓存：`rewrite` 与 `rerank` 使用 5 分钟短时缓存，键包含会话、查询、当前文档、参考模式、参考文件和历史摘要哈希

### 6.3 图片缓存与图片向量

- 索引时提取 Markdown 图片语法，写入 `images` 表，记录 `url / alt_text / cache_status / embedding_status`
- 本地粘贴或工具栏插入的图片通过 `/api/files/:id/images` 保存到 `assets/images/{sha256}.{ext}`，Markdown 中只写相对路径；编辑器渲染时把相对路径转为 `/api/files/:id/content-image?src=...` 预览地址
- 远程图片通过 `/api/files/:id/content-image?src=...` 代理下载到 `/lzcapp/var/assets/images/{sha256}.{ext}`
- 代理只允许 `http/https`，并阻止 localhost、内网地址和非法协议，避免服务端请求风险
- 缓存成功且开启 `EMBEDDING_MULTIMODAL_ENABLED` 时，调用第三方多模态 embedding 模型写入 `images_vec`
- 若当前 embedding 模型不支持图片输入，则标记 `embedding_status=skipped`，不影响文本索引和检索
- 缓存或图片向量失败只记录数据库状态；页面请求图片时会 307 回到原外链，文章仍能显示

### 6.4 创作 Agent 工具链

创作 Agent 当前主流程为 Agentic Loop：

1. 创作页主输入按当前执行模式创建 `agent_sessions`：自动确认和手动确认都会直接启动 Loop，不再生成前置任务确认卡；前端构造任务时必须同时传 `goal` 与 `user_query`：`goal` 显式包含当前打开文档的可见名称、当前文章路径和块快照等执行上下文，`user_query` 只保留用户本轮输入框提交的原始文字，消息列表本身不额外绑定展示文件名；Loop 按 LLM 工具调用自主执行多轮，工具包括 `search_knowledge`、`read_file`、`create_note`、`preview_patch_files`、`preview_canvas_blocks`、`ask_question_card`、`analyze_folder`、`check_links`。
2. 写入前置：每次 Loop 开始前先写入 `agent_snapshots`；`create_note` 与 `preview_patch_files` 必须通过 `validateWrite()`；删除操作始终拒绝。
3. 预览、提问与应用：`create_note`、`preview_patch_files`、`preview_canvas_blocks` 和 `ask_question_card` 在单轮内必须是唯一工具调用。`create_note` 不直接落盘，而是生成 `old='' / new=完整新文件内容 / change_type='create'` 的文件级 operation set；手动确认模式等待用户应用后才创建文件，自动确认模式由后端自动应用，已创建的新文件可从同一 DiffDialog 回滚删除。`preview_patch_files` 创建 operation set 前会对 `old` 文本做精确匹配、首尾裁剪匹配和空白折叠后的唯一匹配，匹配成功后使用当前文件中的精确片段写入文件级 patches；patches 存入 `canvas_operation_sets.pathes_json`，每个 patch 额外记录 `pending / applied / auto_applied / rolled_back / discarded / failed` 状态。`preview_canvas_blocks` 用当前创作页块快照和 `@bN` 引用生成 `operations_json` 块级 operation set，并通过 `/api/agent/apply` 应用到当前画布后保存 Markdown。`ask_question_card` 创建 `source='agent_loop'` 的 `conversation_interactions` 记录，将 session 置为 `waiting_confirm` 并保存消息 checkpoint；用户回答后通过同一 session 恢复 Loop，把答案作为 tool result 注入后续推理。自动确认模式下，后端在 Loop 完成前自动应用全部文件级 patch；块级预览仍显示确认卡片。手动确认模式下，消息流只展示摘要卡，用户打开详情弹窗逐文件点击应用或回滚，也可全部应用，接口只写文件和更新状态，不再续跑 Loop 或触发 LLM 总结；应用/回滚必须携带当前对话 ID，并要求 session、operation set 与当前对话一致。前端在应用或回滚后必须刷新文件树；若当前创作页打开的文件已被回滚删除，应清空当前文章状态、跳回 `/canvas` 生成大纲空态，并提示“您打开的文档已被删除”。
4. 异常终止：软上限提醒、硬上限暂停、连续工具失败、重复工具结果死循环、连续无工具无进展都会结束或暂停本次任务。
5. 回滚与废弃：回滚以文件级 patch 为单位执行，已应用文件使用 `new -> old` 恢复，未应用文件直接标记为 `rolled_back`；新建文件回滚删除时必须先删除磁盘文件，再通过 `indexer.removeFile()` 清理 `files/chunks/chunks_vec/FTS`，sqlite-vec 向量虚表不能依赖外键级联；下一条 prompt 发出前会把上一条任务仍未处理的 patch 标记为 `discarded`，不影响同任务中已经应用的文件；新建/切换对话、会话权限过期、预览已处理或文件内容变化后，旧预览不再允许应用或回滚。

Agentic Loop 的 LLM 调用适配 OpenAI-compatible `tool_calls` 和 Anthropic `tool_use/tool_result` 两种协议；system prompt 继续接入 `getStyleContext()` 产生的风格画像、相关原文摘录，以及同一 conversation 中已解析的附件/网页正文。Prompt 明确要求用户本轮输入优先于历史任务：历史上下文只能辅助理解，不能替代本轮明确指令；只有当前任务已经明确但缺少必要结构化槽位，或用户要求“生成提问卡片 / 先问我几个问题”时，才调用 `ask_question_card`。如果本轮只有附件或外部材料且用户没有明确要求写入、更新、修改或合并当前文档，默认读取并总结附件，或用普通文本询问用途，不自动把附件关联到历史写作任务。

创作页解析输入源：

- 前端只在创作页为 `AgentWorkspace` 开启 `attachmentMode="parsed"`；知识库页保持现有附件展示，不调用解析上传接口。
- `/api/agent/attachments/upload` 接受 `.pdf/.docx/.md/.markdown/.txt`，使用 `formidable` 暂存到运行时 `sessionDir/attachments`；前端也会做格式校验。
- `/api/agent/loop/start` 在创建或确认 conversation 后，先解析本轮上传附件和 `user_query/input_text/display_query` 中的 `http/https` 网页链接，再写入用户消息；不得从完整 `goal`、当前打开文档内容、当前块快照、文章路径或历史任务中提取 URL。PDF 使用 LiteParse 且关闭 OCR，standalone / `.lpk` 产物必须包含 LiteParse 对应平台 optional package、`.node` 与 `libpdfium.so`；DOCX 使用 mammoth，MD/TXT 使用 UTF-8，网页正文优先用 Readability，失败时用 HTML 正文提取兜底。
- 解析结果为 `success` 或 `partial` 时，以 `role='system'`、`type='parsed_attachment'` 写入 `messages`；`error` 只进入本轮解析摘要和工具过程，不污染后续上下文。
- `runAgentLoop()` 每轮按 conversation 读取解析来源，拼接到 system prompt；单来源默认最多 12,000 字符，总预算保留较新的来源优先。
- 网页链接解析只处理用户本轮显式提供 URL 的正文提取，不等同于联网搜索；旧客户端如果只传 `goal` 而没有 `user_query/input_text/display_query`，URL 解析应跳过。搜索供应商选择进入 Agent Loop 请求和消息 meta，并仅在用户打开联网搜索开关时用于注入 `web_search` 工具。

Agent Loop 日志接口：

```
GET /api/agent/sessions              → { sessions: AgentSessionWithLogs[] }，支持 `limit`、`logs_limit`、`conversation_id`
GET /api/agent/sessions/:id          → { session, run_logs, snapshots_count, operation_sets }；无 token 时只返回不含 session token 和 checkpoint 的只读数据
```

设置页日志视图会读取最近 `agent_sessions` 和 `agent_run_logs`，按 session 与轮次展示工具名、执行结果摘要、失败状态和耗时；历史抽屉的 Agent Loop 日志入口通过 `conversation_id` 跳转到同一视图。

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

补充约束：

- AI 返回 `replace / delete` 操作时，如果 `old` 缺失，必须回填为目标块当前真实内容
- 生成 `replace` 操作时，目标块必须以完整正文进入编辑 Prompt；邻近块可以裁剪，但目标块不能裁剪，否则大文本块的 `old` 会与真实内容不一致
- `replace.new` 必须表示目标块修改后的完整全文，局部修改时未修改部分必须逐字保留，不能只返回修改片段
- 编辑 Prompt 必须包含短示例说明“只改一句也要输出整块 new”，并在无法保证完整 `old/new` 时返回空 `operations`
- 规划器 Prompt 不得使用“无关键词时优先 edit”这类过强规则；缺少明确修改动词时，只有显式块引用、上一轮编辑建议承接、写入/替换/应用到正文等表达可偏向 `edit`，普通讨论应保持 `text`
- 如果模型返回的 `old` 只是目标块正文的裁剪片段、只存在换行差异，或与当前块内容存在明确包含关系，应在服务端归一到当前块真实内容后再进入最终比对，避免用户未改文档也触发 `OLD_MISMATCH`
- 若最终仍因文章内容变化而返回 `OLD_MISMATCH`，前端应把该预览标记为过期，并提示用户重新生成，而不是直接暴露底层错误码

成功后：更新画布 state → 序列化 blocks 为 MD 文本 → 写回 MD 文件 → watcher 触发增量索引。

### 6.6 编辑器块级对齐

- 所见即所得编辑器需要支持“文本居中”按钮，作用范围限于 `paragraph / heading`
- 居中不是纯前端临时样式，保存后必须继续可回读
- Markdown 持久化时使用可解析的块级容器语法包裹居中段落，再由编辑器解析链路恢复为 `textAlign=center`

### 6.7 编辑器图片预览

- 文件页与知识库页复用同一套所见即所得编辑器图片预览逻辑，不额外在页面层分叉实现
- 编辑器必须单独接管剪贴板中的图片文件，优先上传到当前文件对应的 `assets/images/` 资源目录并插入相对路径，避免浏览器默认粘贴与编辑器内容同步相互覆盖，导致连续粘贴时只短暂闪现后丢失
- Tiptap 图片节点需要保留 Markdown 相对路径作为真实 `src` 属性；渲染 HTML 时再把本地相对路径转换为 `/api/files/:id/content-image?src=...`，避免把预览 API 地址写回 Markdown。历史 data URL 仍允许解析，但新插入图片不再以 base64 持久化
- 点击编辑器正文内的图片后，前端只收集当前 `.ProseMirror` 节点下的图片列表，预览切换范围严格限定为当前文档
- 预览层需要支持 `ArrowLeft` / `ArrowRight` 切换上一张或下一张图片，支持 `Escape` 关闭
- 文档内容变化时，如果预览仍处于打开状态，前端应重新同步当前文档图片列表；若图片列表已为空，则自动关闭预览层
- 预览打开期间需要锁定页面滚动，避免底层编辑区跟随方向键或滚轮产生干扰
- 标题层级下拉按钮打开菜单时，触发器 tooltip 必须立即关闭，不能残留遮挡菜单内容

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
LLM_API_PROTOCOL=openai              # openai | anthropic
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

### 9.1 `package.yml`

```yaml
package: cloud.lazycat.app.notus
version: 0.1.3
name: Notus
description: 私有化个人知识库与 AI 写作协作工具
author: dnwwdwd
license: Apache-2.0
homepage: https://github.com/dnwwdwd/Notus
unsupported_platforms:
  - ios
  - android

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

静态元数据统一写入 `package.yml`；当前 `.lpk` 包标识符固定为 `cloud.lazycat.app.notus`，并通过 `unsupported_platforms` 显式声明不支持 `ios` 与 `android`。

### 9.2 `lzc-manifest.yml`

```yaml
application:
  subdomain: notus
  image: registry.lazycat.cloud/u30387910/library/node:549f023f95a10c59
  background_task: false
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
  health_check:
    start_period: "90s"
    test_url: "http://127.0.0.1:3000/api/health"
```

**注意：** 当前仓库使用 LPK v2 结构，`lzc-manifest.yml` 只保留运行时配置；静态字段不要再写回 manifest 顶层。运行形态仍为 v1 单体架构（`application.upstreams` + `backend_launch_command`，无 `services` 块）。

### 9.3 `lzc-build.yml`

```yaml
buildscript: ./lzc/build-package.sh
contentdir: ./lzc-dist
```

### 9.4 `lzc/build-package.sh`

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

### 9.5 `lzc/run.sh`

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
  - 文件页、知识库页、创作页在当前内容为 `dirty` 时，从侧边栏、顶部搜索或页内切换到其他文档前都必须先触发同一套未保存确认弹窗；确认保存或放弃后，才允许继续跳转；弹窗底部不显示“取消”按钮，关闭弹窗则保持当前页面不跳转
  - 文档内容搜索浮层只显示输入、匹配计数、上下切换和关闭，不显示额外说明文案或空关键词提示
  - 文件页与知识库页都必须提供 H1-H6 大纲；大纲项使用真实标题 active 状态，点击后即时设置精确滚动位置并更新选中视觉，切换文件树 / 大纲 tab 后不得恢复旧选中项
  - 创作页对 `?fileId=` 的处理必须避免“旧 query 把新选中文档写回去”的状态循环；切换中的目标文档只有在文章内容真正切到目标文件后，才能释放路由同步保护；当路由携带 `fileId` 且 `article` 尚未加载完成时，必须显示文档加载骨架，不能回退到新建创作空态
  - 侧边栏“新建文件后自动打开”必须复用与普通点文件相同的页面级切换入口；当页面存在未保存守卫或创作页路由保护时，不能在共享上下文里直接 `selectFile`
  - 文件页、知识库页、创作页在同页切换 `fileId` 时都必须触发路由更新；知识库页和创作页的同页切文档也应显示统一的全局 `PageTransitionOverlay`
  - 创作块编辑态必须持续保留，textarea 失焦不能自动保存或退出；只允许 `Mod+Enter` / “完成”保存，`Esc` / “取消编辑”放弃当前块编辑
  - 侧边栏文件树 / 大纲 tab、两个 tab 各自滚动位置必须持久化；文件页、知识库页和创作页既保留页面级位置，又共享同一文档的最近阅读位置，从其他页面进入时恢复最新位置
  - AI 未就绪时，知识库锁定层只能覆盖右侧问答面板，不能阻断左侧文章编辑区、文件树或大纲
  - 显式定位优先级必须高于历史浏览位置：`pendingCitation`、`?fileId + lineStart/preview/headingPath`、`#Lx-Ly` 都不能被旧滚动位置覆盖
- M2-02 FileTree 组件 + `/api/files/*` API
  - 前端所有可见文档标签统一优先 `title`，其次显示去掉 `.md` 的文件名，最后才使用占位文案；禁止显示 `article_xxx`、`notus_xxx`、裸 `fileId` 这类技术标识
  - 侧边栏显式重命名属于强制改名操作；若目标文件已存在，整次重命名必须失败，不能覆盖已有文件
  - 当 `editor.title_filename_binding_enabled=true` 时，侧边栏显式重命名后需要同步更新正文首个可见 H1；若正文没有 H1，则自动补一个新的一级标题
- M2-03 WYSIWYG Markdown 编辑器 + Typora 风格 CSS
  - 文件页、知识库页和创作页的可见编辑区都必须隐藏仅包含系统 `id` 的 frontmatter；保存时再与正文重新合并，避免在编辑区直接暴露内部 fileId 风格文案
  - 当 `editor.title_filename_binding_enabled=true` 时，文件页与知识库页在手动保存 Markdown 时，需要读取正文首个可见 H1，规范化后尝试同步文件名；若目标文件名冲突，正文保存仍需成功，但响应里要返回 `title_binding_warning`
  - 编辑器粘贴 Markdown 纯文本时，必须继续启用 `tiptap-markdown` 的 `transformPastedText`，并补齐与当前支持语法对应的 Tiptap 节点；至少要覆盖标题、列表、任务列表和 GFM 表格，避免“支持粘贴 Markdown 但表格退化成普通文本”
  - 编辑器在加载已有 Markdown 文档时，必须把标题和 GFM 表格稳定还原为真实的 `heading/table` 节点；同时在所见即所得里直接输入完整的 Markdown 表格语法后，也要自动把该语法块转换为真正的表格节点，而不是长期停留在普通段落文本
  - 所见即所得编辑器中的 GFM 表格必须显示外框、单元格边框、表头背景和选中单元格反馈；编辑态显示不能弱于 Markdown 预览区的表格可读性
  - 当剪贴板同时包含 HTML 与纯文本，且纯文本命中 `$...$` / `$$...$$` 数学语法时，编辑器需要优先按 Markdown 解析这一份纯文本，保证公式第一次粘贴就直接进入 KaTeX 渲染态，而不是先显示源码、再靠回车触发转换
  - 编辑器必须支持 `$...$` 行内公式与 `$$...$$` 块级公式，并统一使用 KaTeX 渲染；数学节点需可点击再次编辑，不能只做到一次性显示后无法修改
  - 编辑器中的图片必须支持文档内预览，点击图片后可在当前文档范围内查看大图，并用左右方向键切换相邻图片
- M2-04 MarkdownRenderer（remark/rehype 插件链）
  - Markdown 展示链路必须补齐 `remark-math + rehype-katex`，保证预览区、聊天流式回答和编辑器输出的公式语法一致
- M2-05 TocTree + 滚动高亮
  - 文件页 TOC 必须统一基于编辑器真实渲染的 `h1~h6` 节点生成；采集、点击跳转和滚动高亮不能只覆盖前三级标题
  - 文件页 TOC 在切换文档或编辑器回填 Markdown 内容后，必须允许等待编辑器 DOM 稳定再刷新，不能因为首帧未完成渲染就把已有标题误判成空 TOC
- M2-06 URL hash 来源跳转 + 3s 高亮淡出
- M2-07 批量导入/导出 API + SSE 进度
- 导出接口即使只收到 1 个文件也返回 zip，zip 中包含 `notes/` 下的选中文档和对应资源目录，保证相对图片路径可用并避免单个 Markdown 过大
- M2-08 `/indexing` 页面

### M3 知识库问答

- M3-01 `lib/retrieval.js`：查询规划、多路召回与章节证据扩展
- M3-02 jieba-wasm 集成 + FTS 分词
- M3-03 `lib/prompt.js`：知识库 Prompt 模板
- M3-04 `/api/chat` SSE 流式 API
- M3-05 ChatArea + SourceCard 组件
- M3-06 多模型切换下拉（支持搜索）
- 知识库页与创作页在流式回复开始后，都必须立即渲染 AI 气泡占位；首 token 到来前使用固定占位的柔和三点等待态，避免布局跳动。知识库检索状态必须进入 AI loading 气泡内部，按“分析问题 / 检索笔记 / 找到证据 / 组织答案”等步骤动态切换，不作为独立状态条固定在回复外部
- 输入框生成中只保留停止按钮；真正的“AI 正在回复”反馈只能放在 AI 回复气泡区，不能继续放在输入框内部
- AgentWorkspace 输入框上方不得展示预制问题列表；知识库页和创作页都只保留直接输入、附件、联网搜索、搜索商单选、模型选择和发送/停止控件
- AgentWorkspace 聊天滚动必须采用贴底跟随策略：仅当用户原本处于底部阈值内时，才随 `token`、工具链步骤、消息和任务结果继续滚动；用户上滑或生成中手动滚动后不得继续抢滚，模型切换、搜索商切换和自动/手动模式切换也不得触发消息定位
- AI 回复气泡本体不显示边框；来源卡片、状态徽标等内部组件可按自身语义保留必要边界
  - 模型选择器必须固定在输入框右下角发送/停止按钮左侧；触发器在窄宽度下单行 `ellipsis` 缩略显示，菜单项仍展示完整模型名

### M4 AI 创作画布

- M4-01 `lib/diff.js`：applyOperation + applyOperations + computeDiff
- M4-02 `/api/articles/parse` + `/api/articles/save`
- M4-03 `lib/style.js` + `lib/canvasRequestPlanner.js` + `lib/canvasAgent.js`
- M4-04 旧 intent / legacy agent 清理
- M4-05 大纲生成 `/api/agent/outline` SSE
- M4-06 Agentic Loop 运行 `/api/agent/loop/start` SSE
- M4-07 CanvasBlock 组件（6 状态）+ dnd-kit 拖拽
- M4-08 AIPanel（后台事实补充 + 风格来源 + 对话 + 批量预览恢复）
- M4-09 新建创作入口页
- M4-10 编辑器"AI 创作"按钮流程
- M4-11 图片延迟处理后台任务 + 风格回填后台任务

### M5 体验打磨 & 部署

- M5-01 设置页（模型/搜索/个性化/存储/快捷键/关于 + 校验流程；LLM 预算字段持久化但不在卡片中展示；关于页版本说明文案使用纯文本展示，不保留外层边框）
- M5-02 CommandPalette（cmdk）
  - 顶部全局文章搜索弹层打开后，搜索输入框必须自动聚焦，保证鼠标或快捷键唤起后都能直接输入，不需要再额外点击一次
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
# 2026-06-20 Agent 聊天 UI 技术口径

- 共享 AgentWorkspace 前端组件改为右侧聊天面板，不再整页替换知识库页和创作页；页面业务主区域继续使用原有文档编辑、块画布和批量预览组件。
- `/api/settings/search-providers` 用 settings 表保存搜索启用状态、当前服务商、调用模式、结果数和 API Key；响应只返回 `api_key_set` 和 provider 是否需要 Key，不返回明文密钥。设置页联网搜索总开关可单独 PUT `{ enabled }` 实时保存，服务商、模式、结果数和 API Key 仍由保存按钮提交；Firecrawl 允许无 Key，Tavily、Exa、智谱必须配置 Key。
- AgentWorkspace 输入框接受 `webSearchEnabled`、`searchProvider`、`attachments` 和 `modelConfigId` 兼容字段；`/api/agent/loop/start` 将联网开关、provider 和工具 profile 写入 `agent_sessions`。联网开关打开且 provider 可用时，Agent Loop 注入 `web_search` 工具；关闭时不注入工具，也不拼入历史联网上下文。知识库页联网问答走只读 Agent Loop，创作页仍使用可写 Agent Loop。
- `web_search` 工具通过官方 npm SDK 调用 Firecrawl、Tavily、Exa、智谱（`firecrawl@1.20.0`、`@tavily/core`、`exa-js`、`openai`），Notus 只做统一参数映射与返回结构归一化，返回 `{ query, provider, results, durationMs }`，不手写维护各 Provider 的 HTTP 请求细节。成功搜索结果以 `messages.role='system'`、`type='web_search_context'` 持久化到同一 conversation，后续仅在本会话且联网开关打开时按预算拼入 system prompt；结果不进入知识库索引。
- 创作页主输入在自动确认或手动确认模式下都直接进入 `/api/agent/loop/start`，不再生成 `pendingAgentTask`；应用、回滚和废弃文件级预览通过 `/api/agent/loop/apply` 完成，成功后只更新文件内容与 operation set 状态，不携带 `session_id` 续跑；新建/切换对话时前端清空 active Agent session，历史对话恢复不返回 `session_token`，旧预览只能查看和导出。
- 搜索配置进入设置菜单 /settings/search；聊天顶部不再提供模型配置和搜索配置入口。
- AgentWorkspace 不再接收或渲染 suggestions，避免输入框上方出现预制问题列表。
- `AgentWorkspace.ToolChain` 以 `notus-agent.html` 为视觉基准：外层为顶部状态图标 + border-top 步骤列表；步骤行使用 button 控制折叠状态，`aria-expanded` 暴露展开状态，运行态使用圆环持续旋转，不使用 refresh 图标；失败态使用警示图标，完成态使用 check；展开区使用左侧细线、13.5px 说明文本、浅色工具卡片、monospace input/result 和三点等待态。
- 创作页 `/canvas` 在 `/api/agent/loop/start` SSE 过程中累计 `session_created / snapshot_done / loop_start / thinking / tool_start / tool_done / loop_done` 对应的工具步骤，写入最终 assistant message 的 `toolSteps`，历史会话中不丢失中间步骤；旧 `waiting_preview_confirm` 事件仅作为历史兼容分支保留。
- AgentWorkspace 的已完成 AI 消息和流式 AI 消息都通过 `StreamingText` 渲染，保持 Markdown、GFM、数学公式和代码高亮一致。
- 创作页文件变更消息使用摘要卡承载文件数量和状态，`DiffDialog` 展示逐文件 old/new diff、状态、应用、回滚和全部应用；弹窗高度必须限制在视口内，diff 内容区独立提供横向和纵向滚动，底部操作按钮始终可见；弹窗底部说明应用/回滚只在当前对话有效，且在新建/切换对话、预览已处理、权限过期或文件内容变化后失效。

# 2026-06-19 Agentic Loop 技术口径

- 创作页和知识库页继续复用 AgentWorkspace 输入入口；创作页主输入默认以自动确认进入 `/api/agent/loop/start`，也可切换为手动确认后逐文件处理 diff；知识库页写作类任务进入 `/api/agent/loop/start`，普通问答继续走 `/api/chat`。
- `canvas_operation_sets` 新增可空 `agent_session_id` 与 `pathes_json`；旧 `operations_json` 继续服务块级 operation set，新文件级 patch 使用 `{ file_path, old, new }` 存入 `pathes_json`。
- Agentic Loop 新增 `agent_sessions`、`agent_snapshots`、`agent_run_logs`；任务开始前必须完成快照，写入走 `validateWrite()`，删除能力不开放。
- `lib/agentTools.js` 提供八个基础工具：`search_knowledge`、`read_file`、`create_note`、`preview_patch_files`、`preview_canvas_blocks`、`ask_question_card`、`analyze_folder`、`check_links`；联网搜索打开时额外注入 `web_search`。`create_note`、`preview_patch_files`、`preview_canvas_blocks` 与 `ask_question_card` 单轮唯一；`create_note` 生成新建文件预览，`preview_patch_files` 创建预览前会先把空白差异下的唯一近似 `old` 对齐到当前文件精确片段，块级工具根据 `@bN` 生成 `operations_json`，提问卡片工具暂停 Loop 并等待用户回答。
- `lib/agentLoop.js` 负责多轮工具调用、context 压缩、LLM 429 退避、SSE 断开取消、软/硬轮数上限、连续失败、重复结果和无进展检测。
