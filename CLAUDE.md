# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 回复语言

- 始终以中文回复任何问题。

---

## Bug 台账流程

- Bug 台账文件位于仓库根目录 `BUG_TRACKER.md`，用于记录每个 bug 的描述、影响范围、根因、修复方案、当前状态与验证结果。
- 每次发现 bug、收到 bug 报告、开始修 bug 或完成 bug 修复时，必须新增或更新 `BUG_TRACKER.md` 中的对应条目。
- 修复过程中应同步更新状态与进度；修复完成后必须补充根因、修复情况和验证结果。
- Bug 修复默认只记录到 `BUG_TRACKER.md`，不要同步更新 `PROGRESS.md`；除非用户明确要求，或该修复同时改变了产品里程碑/功能完成状态。
- 回答 bug 相关问题时，必须明确说明是否已按此流程更新 `BUG_TRACKER.md`。

---

## 项目概述

Notus 是一款运行在**懒猫微服（Lazycat MicroServer）**上的私人知识库 + AI 写作助手。用户将本地 Markdown 笔记文件夹挂载到设备，Notus 自动索引、支持语义检索问答，并提供基于块（Block）的 AI 辅助创作画布。

**当前状态：前端 UI 已完成，核心后端链路已接入真实数据库 / 文件系统 / 检索 / SSE。** 批量导入导出、图片代理和实机打包验证仍待补充。详见 [PROGRESS.md](PROGRESS.md)。

---

## 技术栈约束

- **Next.js 15 Pages Router**（不是 App Router）+ React 19，**纯 JavaScript**（不引入 TypeScript）
- 包管理器：**npm**（不用 yarn/pnpm）
- 样式：**CSS token 驱动**，不用 Tailwind，不用 shadcn-ui
- UI 行为层：Radix Primitives（`@radix-ui/*`）
- 编辑器：**Tiptap + Markdown 双向转换 + lowlight 代码块高亮**，SSR 不兼容，必须 `dynamic(..., { ssr: false })` 加载
- Markdown 渲染：react-markdown + remark-gfm + remark-math + rehype-highlight + rehype-katex
- 拖拽：@dnd-kit/core + @dnd-kit/sortable
- 数据库：better-sqlite3（WAL 模式）+ sqlite-vec（向量）+ FTS5（全文）
- 文件监听：chokidar（`usePolling: true, interval: 3000`，适配 Lazycat NFS 挂载）
- 部署：Next.js `output: 'standalone'` → 打包为 `.lpk`

---

## 常用命令

```bash
# 开发
cd notus
npm install        # 首次安装依赖
npm run dev        # 启动开发服务器 http://localhost:3000

# 构建
npm run build      # 生成 .next/standalone

# 代码检查
npm run lint

# 打包为懒猫 .lpk
bash lzc/build-package.sh
```

环境变量：复制 `notus/.env.local.example` 为 `notus/.env.local`，填入 API Key。

---

## 目录结构与文件作用

```
Notus/
├── CLAUDE.md                    # 本文件
├── PROGRESS.md                  # 任务进度追踪，对齐 PRD 里程碑 M1-M5
├── Notus_PDD.md                 # 产品设计文档：定位、用户、功能描述
├── Notus_PRD.md                 # 技术实现规范：DB schema、所有 API 路由、lib 接口签名
├── Notus_UI_Guide.md            # UI 规范：25 个组件的像素级度量
├── Notus-design-draft/          # 原始设计稿（JSX 原型）
│   ├── tokens.css               # 设计 token 原始定义（已迁移到 styles/globals.css）
│   ├── icons.jsx                # 所有 SVG 图标原型（已迁移到 components/ui/Icons.js）
│   ├── shell.jsx                # TopBar/Sidebar 原型
│   ├── pages-editor.jsx         # 编辑器页面原型
│   ├── pages-chat.jsx           # 知识库问答 + 画布原型
│   └── pages-misc.jsx           # 设置/登录/Setup/索引页原型
├── lzc-manifest.yml             # 懒猫应用声明（端口、volume、env、healthcheck）
├── lzc-build.yml                # 懒猫构建步骤
└── notus/                       # Next.js 应用主目录
    ├── pages/
    │   ├── _app.js              # 全局入口：注入 ToastProvider，从 localStorage 恢复主题
    │   ├── index.js             # 重定向 → /files
    │   ├── login.js             # 登录页（当前为演示自动跳转）
    │   ├── setup.js             # 三步初始化引导
    │   ├── files/index.js       # 主编辑器页：文件树 + WYSIWYG Markdown 编辑器 + 手动保存
    │   ├── knowledge.js         # 知识库问答页：SSE 流式对话
    │   ├── canvas.js            # AI 创作画布：块编辑 + Agent 对话 + OperationPreview
    │   ├── settings/
    │   │   ├── index.js         # /settings → 重定向 /settings/model
    │   │   └── [section].js     # /settings/model|storage|shortcuts|about
    │   ├── indexing.js          # 索引进度页
    │   ├── 404.js / error.js    # 错误页
    │   └── api/                 # 所有 REST API（核心链路已接真实后端）
    │       ├── health.js        # GET /api/health
    │       ├── search.js        # POST /api/search（混合检索）
    │       ├── chat.js          # POST /api/chat（SSE：chunks→tokens→citations→done）
    │       ├── files/           # CRUD + tree
    │       ├── index/           # status + rebuild(SSE)
    │       ├── agent/           # intent / outline(SSE) / run(SSE) / apply
    │       ├── articles/        # parse / save / [id]
    │       ├── conversations/   # index / [id]
    │       ├── settings/        # index / test
    │       └── setup/           # status / complete
    ├── components/
    │   ├── ui/                  # 基础组件：Button, Badge, Input, Dialog, Toast, Toggle,
    │   │                        #   ProgressBar, Skeleton, EmptyState, InlineError,
    │   │                        #   StreamingText, SourceCard, Icons, Spinner
    │   ├── Layout/              # Shell（顶栏+侧栏容器）, TopBar, Sidebar（文件树+TOC）
    │   ├── Editor/              # WysiwygEditor（SSR:false, Tiptap + lowlight）, EditorToolbar, MarkdownPreview
    │   ├── ChatArea/            # ChatMessage（UserBubble/RetrievalStatus/AiBubble）, InputBar
    │   ├── Canvas/              # CanvasBlock（6 状态）, AddBlockButton, InsertIndicator
    │   └── AIPanel/             # OperationPreview（diff 展示 + apply/cancel）
    ├── lib/                     # 后端核心库（数据库、运行时、索引、检索、LLM、Agent）
    │   ├── config.js            # 所有 process.env 读取的唯一入口
    │   ├── db.js                # SQLite + sqlite-vec 初始化，WAL，完整 DDL
    │   ├── embeddings.js        # Embedding API 封装（千问/豆包/OpenAI 可切换）
    │   ├── indexer.js           # 文件分块 → 向量化 → 写入 chunks/vec/fts
    │   ├── retrieval.js         # hybridSearch：向量 KNN + FTS5 BM25 + RRF 融合
    │   ├── prompt.js            # 所有 LLM Prompt 模板
    │   ├── watcher.js           # chokidar 文件监听 → 入队后台索引协调器
    │   ├── agent.js             # 9 个工具 schema + runAgent 循环
    │   └── diff.js              # str_replace 引擎（old 字段乐观锁校验）
    ├── styles/
    │   └── globals.css          # 全部设计 token（:root 亮色 + [data-theme="dark"] 暗色）
    │                            # keyframes: spin/blink/shimmer/pulse-border/fadeIn/slideUp
    └── lzc/
        ├── run.sh               # 容器启动：mkdir data dirs → node server.js
        └── build-package.sh     # 打包：standalone 产物 → notus.lpk
```

---

## 架构关键点

### 主题系统
暗色模式通过 `document.documentElement.setAttribute('data-theme', 'dark')` 切换，CSS 用 `[data-theme="dark"]` 选择器覆盖。主题持久化在 `localStorage('notus-theme')`，在 `pages/_app.js` `useEffect` 中恢复。

### SSE 流式接口规范
所有流式接口（chat、agent/run、agent/outline、index/rebuild）使用 Server-Sent Events，事件格式统一为 `data: JSON\n\n`。事件类型字段 `type` 取值：
- `/api/chat`：`chunks` → `token` → `citations` → `done` | `error`
- `/api/agent/run`：`thinking` → `tool_call` → `tool_result` → `operation` → `done` | `error`
- `/api/agent/outline`：`block`（逐个）→ `done`

### Block 编辑与 str_replace
画布操作使用 Claude Artifacts 同款 str_replace 语义：每次 AI 操作必须携带 `old` 字段（被替换的原始内容），`lib/diff.js:applyOperation` 先校验 `old` 是否存在于文件中再执行替换，防止 Block ID 错位导致误修改。

### 混合检索管道（`lib/retrieval.js`）
7 步：① 嵌入 query → ② sqlite-vec KNN（2×topK）→ ③ FTS5 BM25（2×topK）→ ④ 向量分阈值过滤（distance ≤ 0.5）→ ⑤ RRF 融合（k=60）→ ⑥ 取 topK → ⑦ JOIN 文件元数据。

### DB schema 注意事项
主库继续保存 `files/settings/conversations/messages`，索引产物改为 generation 独立库；`active_generation_id` 指向当前在线索引，检索只读 active generation。Embedding 配置分为当前在线和待生效两套，模型 / 维度 / 多模态变化会创建新的 rebuild generation，成功后再原子切换，不再先清空旧索引。

### Lazycat 部署约束
- 单容器，Next.js standalone 模式
- 运行时路径：`NOTES_DIR=/lzcapp/var/notes`，`DB_PATH=/lzcapp/var/data/index.db`
- chokidar 必须 `usePolling: true`（NFS/SMB 挂载不触发 inotify）
- sqlite-vec 需要 aarch64 预编译 .so（Lazycat 为 ARM 架构）

---

## 服务端说明

当前核心 API 已接入真实文件系统与 SQLite；仍未实现的接口主要是批量导入/导出、图片代理和部分部署验证。所有 API Route 都应通过 `lib/runtime.js:ensureRuntime()` 完成初始化，再通过 `lib/db.js:getDb()` 获取 SQLite 连接。`lib/` 中的 Node.js 模块只能在 API Routes 和 `getServerSideProps` 中调用，不能在浏览器端组件中直接 import。
