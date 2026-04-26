# AGENTS.md

本文件定义本仓库内 AI 编码助手的统一工作规则。

---

## 回复语言

- 始终使用中文回复。

---

## 文档优先级

处理需求时，默认按以下优先级理解项目约束：

1. `AGENTS.md`
2. `Requirements/`
3. `BUG_TRACKER.md`
4. `PROGRESS.md`
5. `Notus_PDD.md`
6. `Notus_PRD.md`
7. `Notus_UI_Guide.md`

如果低优先级文档与高优先级规则冲突，以高优先级为准，并在回复中明确说明。

---

## 需求记录流程

### 总原则

- 根目录 `Requirements/` 是统一的需求入口，用于记录每次收到的需求、分类结果、状态和落地文档。
- `BUG_TRACKER.md` 只记录 bug，不记录功能需求、功能优化、用户体验优化、视觉优化、文案优化或一般性能建议。
- `PROGRESS.md` 只记录阶段性完成度、当前口径和里程碑，不承担逐条需求流水账职责。

### 每次收到需求时的必做动作

1. 先判断需求类型。
2. 在 `Requirements/INDEX.md` 新增或更新一条记录。
3. 如果判定为 bug，再同步更新 `BUG_TRACKER.md`。
4. 如果该需求改变了当前产品口径、范围或里程碑，再按需更新 `PROGRESS.md`、PDD、PRD 或 UI Guide。

### 需求分类标准

- bug：
  - 现有承诺、既有设计、已实现逻辑或已上线行为没有按预期工作。
  - 出现报错、异常、回归、数据错误、状态错乱、兼容性失效、安全问题。
  - 这类需求必须进入 `Requirements/INDEX.md`，同时必须进入 `BUG_TRACKER.md`。
- 功能需求：
  - 新增此前不存在的能力、页面、接口、流程、配置项或业务规则。
  - 这类需求进入 `Requirements/`，不进入 `BUG_TRACKER.md`。
- 功能优化：
  - 对已有能力做增强、扩展、限制收紧、流程调整、策略升级、能力补强。
  - 即使用户主观上认为“应该这样”，只要当前行为不是错误，就按功能优化处理。
  - 这类需求进入 `Requirements/`，不进入 `BUG_TRACKER.md`。
- 用户体验优化：
  - 现有功能可用，但在交互效率、视觉层级、提示文案、反馈时机、默认值、易理解性等方面需要改进。
  - 这类需求进入 `Requirements/`，不进入 `BUG_TRACKER.md`。

### 混合需求处理

- 如果一个请求同时包含 bug 和优化项，必须拆开记录。
- bug 部分进入 `Requirements/INDEX.md` 与 `BUG_TRACKER.md`。
- 功能需求、功能优化、用户体验优化部分仅进入 `Requirements/`。
- 不能把优化项混记为 bug。

### 分类不明确时

- 优先根据现有文档、当前实现和用户描述判断。
- 如果仍然存在明显歧义，应在回复中明确说明当前按哪一类处理。
- 在无法确认的情况下，默认按“非 bug”处理，并且不要写入 `BUG_TRACKER.md`。

### 回答要求

- 回答 bug 相关问题时，必须明确说明是否已更新 `BUG_TRACKER.md`。
- 回答需求、优化、规划类问题时，必须明确说明是否已更新 `Requirements/INDEX.md`。

---

## Bug 台账流程

- Bug 台账文件位于仓库根目录 `BUG_TRACKER.md`，用于记录每个 bug 的描述、影响范围、根因、修复方案、当前状态与验证结果。
- 每次发现 bug、收到 bug 报告、开始修 bug 或完成 bug 修复时，必须新增或更新 `BUG_TRACKER.md` 中的对应条目。
- 修复过程中应同步更新状态与进度；修复完成后必须补充根因、修复情况和验证结果。
- Bug 修复默认只记录到 `BUG_TRACKER.md`，不要同步更新 `PROGRESS.md`；除非用户明确要求，或该修复同时改变了产品里程碑或功能完成状态。

---

## 项目概述

Notus 是一款运行在懒猫微服（Lazycat MicroServer）上的私人知识库 + AI 写作助手。用户将本地 Markdown 笔记文件夹挂载到设备，Notus 自动索引、支持语义检索问答，并提供基于块（Block）的 AI 辅助创作画布。

当前状态：前端 UI 已完成，核心后端链路已接入真实数据库、文件系统、检索和 SSE；批量导入导出、图片代理和实机打包验证已基本补齐，仍需真实环境持续回归。

---

## 技术栈约束

- Next.js 15 Pages Router，不使用 App Router
- React 19
- 纯 JavaScript，不引入 TypeScript
- 包管理器固定为 `npm`
- 样式采用 CSS token 驱动，不使用 Tailwind，不使用 shadcn-ui
- UI 行为层使用 `@radix-ui/*`
- 编辑器使用 Tiptap + Markdown 双向转换 + lowlight 代码块高亮，且必须 `dynamic(..., { ssr: false })`
- Markdown 渲染使用 `react-markdown + remark-gfm + rehype-highlight + rehype-katex`
- 拖拽使用 `@dnd-kit/core + @dnd-kit/sortable`
- 数据库使用 `better-sqlite3 + sqlite-vec + FTS5`
- 文件监听使用 `chokidar`，并固定 `usePolling: true, interval: 3000`
- 部署目标是 Next.js `output: 'standalone'`，最终打包为 `.lpk`

---

## 常用命令

```bash
# 开发
cd notus
npm install
npm run dev

# 检查
npm run lint
npm run build

# 打包
bash lzc/build-package.sh
```

环境变量：复制 `notus/.env.local.example` 为 `notus/.env.local` 后填写 API Key。

---

## 仓库结构

```text
Notus/
├── AGENTS.md
├── Requirements/               # 需求总台账与逐条需求记录
├── BUG_TRACKER.md              # 仅记录 bug
├── PROGRESS.md                 # 当前里程碑与完成度
├── Notus_PDD.md                # 产品设计文档
├── Notus_PRD.md                # 技术实现规范
├── Notus_UI_Guide.md           # UI 规范
├── Notus-design-draft/         # 原始设计稿
├── lzc-manifest.yml            # 懒猫应用声明
├── lzc-build.yml               # 懒猫构建步骤
└── notus/                      # Next.js 应用主目录
```

### `notus/` 关键目录

- `pages/`：页面和 API Routes
- `components/`：UI、布局、编辑器、知识库、画布等组件
- `lib/`：数据库、运行时、索引、检索、LLM、Agent、diff 等核心库
- `styles/`：全局 token 与主题样式
- `lzc/`：运行脚本与打包脚本

---

## 架构关键点

### 主题系统

- 暗色模式通过 `document.documentElement.setAttribute('data-theme', 'dark')` 切换。
- CSS 使用 `[data-theme="dark"]` 覆盖暗色 token。
- 主题持久化在 `localStorage('notus-theme')`，并在 `pages/_app.js` 中恢复。

### SSE 规范

所有流式接口统一使用 Server-Sent Events，事件格式为 `data: JSON\n\n`。

- `/api/chat`：`chunks` -> `token` -> `citations` -> `done | error`
- `/api/agent/run`：`thinking` -> `tool_call` -> `tool_result` -> `operation` -> `done | error`
- `/api/agent/outline`：`block` -> `done`
- `/api/index/rebuild`：按进度事件持续输出

### Block 编辑与 str_replace

- 画布操作使用类似 Claude Artifacts 的 `str_replace` 语义。
- 每次 AI 操作必须携带 `old` 字段。
- `lib/diff.js:applyOperation` 会先校验 `old` 是否存在，再执行替换，避免块错位导致误修改。

### 混合检索

`lib/retrieval.js` 采用混合检索流程：

1. 生成 query embedding
2. sqlite-vec KNN 召回
3. FTS5 BM25 召回
4. 向量阈值过滤
5. RRF 融合
6. 取 topK
7. 关联文件元数据

### 数据库注意事项

- `chunks_vec` 的向量维度由 `EMBEDDING_DIM` 决定。
- 切换 embedding 模型维度后必须重建索引，必要时重建 vec 表。
- 所有运行时配置统一走 `lib/config.js`，不要在别处直接散读 `process.env`。

### Lazycat 部署约束

- 单容器部署
- 运行时路径默认使用懒猫挂载目录
- NFS/SMB 场景必须开启 `usePolling`
- `sqlite-vec` 需要验证 aarch64 运行环境

---

## 服务端实现约束

- API Route 必须先调用 `lib/runtime.js:ensureRuntime()`
- 数据库连接统一通过 `lib/db.js:getDb()` 获取
- `lib/` 下 Node.js 模块只能在 API Routes 或 `getServerSideProps` 中调用，不能直接在浏览器组件中 import

---

## 文档维护约束

- 修改产品口径后，必须同步清理过时文档描述，不保留互相冲突的并列口径。
- 新需求默认先进入 `Requirements/INDEX.md`，再决定是否需要更新 PDD、PRD、UI Guide、PROGRESS。
- 修 bug 时默认不更新 `PROGRESS.md`，除非用户明确要求，或该修复改变了里程碑状态。
- `CLAUDE.md` 的内容必须与 `AGENTS.md` 保持完全一致；只要 `AGENTS.md` 发生变更，必须同步更新 `CLAUDE.md`。
