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
3. `docs/BUG_TRACKER.md`
4. `docs/PROGRESS.md`
5. `docs/Notus_PDD.md`
6. `docs/Notus_PRD.md`
7. `docs/Notus_UI_Guide.md`

如果低优先级文档与高优先级规则冲突，以高优先级为准，并在回复中明确说明。

---

## 需求记录流程

### 总原则

- 根目录 `Requirements/` 是统一的非 bug 需求入口，用于记录功能需求、功能优化、用户体验优化的分类结果、状态和落地文档。
- `docs/BUG_TRACKER.md` 只记录 bug，不记录功能需求、功能优化、用户体验优化、视觉优化、文案优化或一般性能建议。
- `docs/PROGRESS.md` 只记录阶段性完成度、当前口径和里程碑，不承担逐条需求流水账职责。
- 单纯的打包动作不计入需求文档。仅重新执行 `.lpk` 打包、重新生成安装包、更新校验值、替换同版本产物，这类事项默认不写入 `Requirements/`，也不写入 `docs/BUG_TRACKER.md`。
- 每次执行新的 `.lpk` 打包前，必须先删除同名旧包产物，再执行新的打包命令，避免旧包覆盖、缓存判断和产物校验混淆。
- 如果一次打包同时包含代码、配置或产品行为变更，应记录这些变更本身；不要把“打包”这个动作单独记成一条需求。

### 每次收到需求时的必做动作

1. 先判断需求类型。
2. 如果只是单纯重新打包 `.lpk` 或更新同版本安装包产物，不写入 `Requirements/`，也不写入 `docs/BUG_TRACKER.md`。
3. 如果判定为非 bug 需求，在 `Requirements/LEDGER.md` 新增或更新一条记录。
4. 如果判定为 bug，直接更新 `docs/BUG_TRACKER.md`，不要写入 `Requirements/`。
5. 如果本次交付涉及功能实现变更，必须同步更新 `docs/Notus_PDD.md` 和 `docs/Notus_PRD.md`，让产品口径和技术实现保持一致，不能等用户额外提醒。
6. 如果本次交付涉及新增功能、功能修改、方案重新调整、架构改造、业务流程变化、Agent 行为变化、检索/索引/数据流变化，必须同步检查并按实际影响更新业务文档和相关项目文档，包括但不限于 `docs/Notus_Business_Logic_Upgrade.md`、`docs/Knowledge_Chat_Business_Flow.md`、`docs/Canvas_Chat_Business_Flow.md`、`docs/Notus_PDD.md`、`docs/Notus_PRD.md`、`docs/PROGRESS.md`、`docs/Notus_UI_Guide.md`。
7. 如果该需求改变了当前产品口径、范围或里程碑，再按需更新 `docs/PROGRESS.md` 或 `docs/Notus_UI_Guide.md`。

### 需求分类标准

- bug：
  - 现有承诺、既有设计、已实现逻辑或已上线行为没有按预期工作。
  - 出现报错、异常、回归、数据错误、状态错乱、兼容性失效、安全问题。
  - 这类问题只进入 `docs/BUG_TRACKER.md`，不进入 `Requirements/`。
- 功能需求：
  - 新增此前不存在的能力、页面、接口、流程、配置项或业务规则。
  - 这类需求进入 `Requirements/`，不进入 `docs/BUG_TRACKER.md`。
- 功能优化：
  - 对已有能力做增强、扩展、限制收紧、流程调整、策略升级、能力补强。
  - 即使用户主观上认为“应该这样”，只要当前行为不是错误，就按功能优化处理。
  - 这类需求进入 `Requirements/`，不进入 `docs/BUG_TRACKER.md`。
- 用户体验优化：
  - 现有功能可用，但在交互效率、视觉层级、提示文案、反馈时机、默认值、易理解性等方面需要改进。
  - 这类需求进入 `Requirements/`，不进入 `docs/BUG_TRACKER.md`。

### 混合需求处理

- 如果一个请求同时包含 bug 和优化项，必须拆开记录。
- bug 部分只进入 `docs/BUG_TRACKER.md`。
- 功能需求、功能优化、用户体验优化部分仅进入 `Requirements/`。
- 不能把优化项混记为 bug。

### 分类不明确时

- 优先根据现有文档、当前实现和用户描述判断。
- 如果仍然存在明显歧义，应在回复中明确说明当前按哪一类处理。
- 在无法确认的情况下，默认按“非 bug”处理，并且不要写入 `docs/BUG_TRACKER.md`。

### 回答要求

- 回答 bug 相关问题时，必须明确说明是否已更新 `docs/BUG_TRACKER.md`。
- 回答需求、优化、规划类问题时，必须明确说明是否已更新 `Requirements/LEDGER.md`。
- 回答单纯打包相关问题时，必须明确说明这次事项不计入需求文档，因此未更新 `Requirements/LEDGER.md`。

---

## Bug 台账流程

- Bug 台账文件位于 `docs/BUG_TRACKER.md`，用于记录每个 bug 的描述、影响范围、根因、修复方案、当前状态与验证结果。
- 每次发现 bug、收到 bug 报告、开始修 bug 或完成 bug 修复时，必须新增或更新 `docs/BUG_TRACKER.md` 中的对应条目。
- 修复过程中应同步更新状态与进度；修复完成后必须补充根因、修复情况和验证结果。
- Bug 修复默认只记录到 `docs/BUG_TRACKER.md`，不要同步更新 `docs/PROGRESS.md`；除非用户明确要求，或该修复同时改变了产品里程碑或功能完成状态。

---

## Git 远程与提交范围

- 本仓库默认同时维护两个远程：GitHub 远程和部署在 NAS 上的私有 GitLab 远程。
- 私有 GitLab 远程用于保留完整项目副本，默认应提交源码、文档、需求台账、懒猫兼容配置、脚本和其他项目源文件。
- GitHub 远程默认只提交公开仓库应保留的源码与必要项目文件，不提交 `docs/` 和 `Notus-design-draft/` 目录。
- 私有 GitLab 远程继续排除构建和打包产物，以及本地运行数据；至少包括 `*.lpk`、`web-dist/`、`desktop/dist/`、`desktop/resources/notus/`、`lzc-dist/`、`.next/`、`notus/.next/`、`node_modules/`、`notus/node_modules/`、环境变量文件、数据库文件、日志目录和本地笔记目录。
- GitHub 远程同样继续排除构建和打包产物，以及本地运行数据；此外还应排除 `docs/`、`Notus-design-draft/`。
- 如无额外说明，涉及仓库同步时不要把“私有 GitLab 需要完整文件”误解为重新纳入上述构建产物；GitLab 提交范围以“完整源文件 + 排除构建产物和本地运行文件”为准，GitHub 提交范围以“公开源码文件 + 排除文档设计目录、构建产物和本地运行文件”为准。

---

## 项目概述

Notus 是一款支持 Web 与 Electron 桌面端的私人知识库 + AI 写作助手，同时保留对懒猫运行时的兼容能力。用户将本地 Markdown 笔记导入或接入到工作区后，Notus 会自动索引、支持语义检索问答，并提供基于块（Block）的 AI 辅助创作画布。

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
- Web 与桌面端共用 Next.js `output: 'standalone'` 产物
- 桌面端框架固定为 Electron
- 平台差异必须统一通过平台中间层处理，不要在业务代码里直接写运行环境判断

---

## 常用命令

```bash
# 安装
npm install

# 检查
npm run lint:web
npm run build:web

# 导出 Web 可分发目录（standalone）
npm run dist:web

# 只启动 Web 开发服务
npm run dev:web

# 只启动 Electron，并连接已运行的 http://127.0.0.1:3000
npm run dev:desktop

# 同时启动 Web 与桌面端，日常联调推荐用这个
npm run dev:desktop:all

# 只准备 Electron 桌面资源
npm run build:desktop

# 按当前主机环境打包桌面安装包（macOS 产出 dmg，Windows 产出 exe）
npm run dist:desktop

# 打包 macOS Intel 安装包（dmg）
npm run dist:desktop:mac:x64

# 打包 macOS Apple Silicon 安装包（dmg）
npm run dist:desktop:mac:arm64

# 打包 Windows x64 安装包（exe）
npm run dist:desktop:win:x64

# 懒猫 .lpk 打包（会先删除同包名前缀的旧 .lpk）
npm run dist:lpk

# 使用仓库脚本重打 .lpk（会先删除旧 .lpk，再调用现有打包链路）
sh scripts/dist-lpk.sh

# 使用 npm 快捷入口执行上面的脚本
npm run dist:lpk:script
```

构建产物位置：

- `npm run dist:web`：输出到 `web-dist/`
- `npm run dist:desktop`：输出到 `desktop/dist/`
- `npm run dist:desktop:mac:x64`：输出 Intel Mac 使用的 `dmg`
- `npm run dist:desktop:mac:arm64`：输出 Apple Silicon Mac 使用的 `dmg`
- `npm run dist:desktop:win:x64`：输出 Windows x64 使用的 `exe`
- `npm run dist:lpk`：输出到仓库根目录，例如 `cloud.lazycat.app.notus-v0.1.2.lpk`
- `sh scripts/dist-lpk.sh` / `npm run dist:lpk:script`：先删除仓库根目录下同包名前缀的旧 `.lpk`，再调用现有 `.lpk` 打包流程；适合手动重复打包时直接使用

环境变量：复制 `notus/.env.local.example` 为 `notus/.env.local` 后填写 API Key。

### `.lpk` 打包脚本说明

- 仓库脚本位于 `scripts/dist-lpk.sh`
- 作用：读取 `package.yml` 中的包名，先删除仓库根目录下同包名前缀的旧 `.lpk`，再执行 `desktop/scripts/build-lpk.js`
- 使用场景：需要手动重打 `.lpk`，并确保不会误保留旧产物时，优先使用这个脚本或对应的 `npm run dist:lpk:script`

---

## 仓库结构

```text
Notus/
├── AGENTS.md
├── desktop/                    # Electron 主进程、预加载桥接与桌面脚本
├── Requirements/               # 非 bug 需求总台账与逐条需求记录
├── docs/
│   ├── BUG_TRACKER.md          # 仅记录 bug
│   ├── PROGRESS.md             # 当前里程碑与完成度
│   ├── Notus_PDD.md            # 产品设计文档
│   ├── Notus_PRD.md            # 技术实现规范
│   └── Notus_UI_Guide.md       # UI 规范
├── Notus-design-draft/         # 原始设计稿
├── package.json                # 根目录脚本与 Electron 打包配置
└── notus/                      # Next.js 应用主目录
```

### `notus/` 关键目录

- `pages/`：页面和 API Routes
- `components/`：UI、布局、编辑器、知识库、画布等组件
- `lib/`：数据库、运行时、索引、检索、LLM、Agent、diff 等核心库
- `lib/platform/`：服务端平台中间层，统一解析运行目标、路径和能力
- `styles/`：全局 token 与主题样式

---

## 架构关键点

### 主题系统

- 暗色模式通过 `document.documentElement.setAttribute('data-theme', 'dark')` 切换。
- CSS 使用 `[data-theme="dark"]` 覆盖暗色 token。
- 主题持久化在 `localStorage('notus-theme')`，并在 `pages/_app.js` 中恢复。

### SSE 规范

所有流式接口统一使用 Server-Sent Events，事件格式为 `data: JSON\n\n`。

- `/api/chat`：`chunks` -> `assistant_meta` -> `token` -> `citations` -> `usage?` -> `done | error`
- `/api/agent/run`：`thinking` -> `token` -> `batch_start?` -> `batch_progress*` -> `batch_done?` -> `assistant_meta` -> `operation*` -> `done | error`
- `/api/agent/outline`：`block` -> `done`
- `/api/index/rebuild`：按进度事件持续输出

知识库问答的 `/api/chat` 现在允许输出 `assistant_meta` 与 `usage` 事件；`clarify_needed` 和 `no_evidence` 可以直接模板化返回，不必进入主回答模型。

### Block 编辑与 str_replace

- 画布操作使用类似 Claude Artifacts 的 `str_replace` 语义。
- 每次 AI 操作必须携带 `old` 字段。
- `lib/diff.js:applyOperation` 会先校验 `old` 是否存在，再执行替换，避免块错位导致误修改。

### 混合检索

`lib/retrieval.js` 采用单索引下的知识库检索流程：

1. 查询规划，产出 `intent / clarity_score / ambiguity_flags / clarify_needed / rewrite_strategy`
2. 多 query variant 召回
3. sqlite-vec KNN、FTS5、标题/路径命中与当前文档温和优先
4. section 聚合与证据句提取
5. 必要时做单次条件 rerank
6. 按 `grounded / weak_evidence / conflicting_evidence / no_evidence` 判定回答模式

### 数据库注意事项

- `chunks_vec` 的向量维度由 `EMBEDDING_DIM` 决定。
- 切换 embedding 模型维度后必须重建索引，必要时重建 vec 表。
- 所有运行时配置统一走 `lib/config.js`，不要在别处直接散读 `process.env`。
- 平台差异统一走 `lib/platform/` 与前端平台上下文，不要在页面或业务库里直接判断 Electron、懒猫或系统路径

---

## 服务端实现约束

- API Route 必须先调用 `lib/runtime.js:ensureRuntime()`
- 数据库连接统一通过 `lib/db.js:getDb()` 获取
- `lib/` 下 Node.js 模块只能在 API Routes 或 `getServerSideProps` 中调用，不能直接在浏览器组件中 import

---

## 文档维护约束

- 修改产品口径后，必须同步清理过时文档描述，不保留互相冲突的并列口径。
- 新的功能需求、功能优化、用户体验优化默认先进入 `Requirements/LEDGER.md`，再决定是否需要更新 `docs/PROGRESS.md`、PDD、PRD、UI Guide。
- 只要项目的功能实现发生改变，不论是否影响 UI，都必须同步更新 `docs/Notus_PDD.md` 和 `docs/Notus_PRD.md`，写清最新的产品行为、流程边界和技术实现。
- 只要出现新增功能、功能修改、方案重新调整、架构改造、业务流程变化、Agent 行为变化、检索/索引/数据流变化，必须同步检查并按实际影响更新业务文档和其他相关项目文档，不能只更新代码或只更新 `Requirements/`。
- 业务文档包括但不限于 `docs/Notus_Business_Logic_Upgrade.md`、`docs/Knowledge_Chat_Business_Flow.md`、`docs/Canvas_Chat_Business_Flow.md`；如果变更影响产品定义、技术实现、进度口径或界面规范，还必须同步更新 `docs/Notus_PDD.md`、`docs/Notus_PRD.md`、`docs/PROGRESS.md`、`docs/Notus_UI_Guide.md` 中对应内容。
- 懒猫相关打包文件、迁移文档和安装产物默认不纳入 Git 管理；如需做本地兼容验证，只保留代码层兼容，不把这些文件重新纳入版本库。
- 单纯重新打包 `.lpk`、更新校验值或覆盖同版本安装包时，不新增 `Requirements/` 记录，也不新增 bug 记录。
- 每次重新打包同名 `.lpk` 前，必须先删除仓库内对应旧包，再执行新的打包动作。
- 修 bug 时默认更新 `docs/BUG_TRACKER.md`，不更新 `Requirements/`，也不更新 `docs/PROGRESS.md`；除非用户明确要求，或该修复改变了里程碑状态。
- `CLAUDE.md` 的内容必须与 `AGENTS.md` 保持完全一致；只要 `AGENTS.md` 发生变更，必须同步更新 `CLAUDE.md`。
