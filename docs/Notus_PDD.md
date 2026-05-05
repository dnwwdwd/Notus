# Notus 产品设计文档（PDD）

> v2.1 · 单一事实源 · 定义产品是什么、为谁做、解决什么问题、长什么样

---

## 1. 产品定位

### 1.1 一句话

Notus 是一款支持 Web 与 Electron 桌面端的私有化个人知识库与 AI 写作协作工具，让你的历史文章成为 AI 的记忆，在画布上与 AI 共同创作，并保留对懒猫运行时的兼容能力。

### 1.2 核心价值

| 痛点 | Notus 的解法 |
|------|-------------|
| NotebookLM 每次对话都重新生成全文，前后不一致 | 画布模式 + 块级 str_replace，AI 只改指定的块 |
| NotebookLM 无法模仿个人写作风格 | 以用户历史文章的风格指纹、全局画像和相关原文摘录作为风格上下文 |
| 知识库数据存在第三方服务器 | 私有部署，MD 文件、索引和日志都保存在本地工作区，数据不出本机 |
| Obsidian 太重，想要 Typora 那种干净编辑体验 | 编辑器还原 Typora 风格，侧边栏文件树 + TOC Tab 切换 |
| AI 工具黑盒式生成，信任成本高 | 所有 AI 修改走 diff 预览 + 用户确认，Block ID 精准定位 |

### 1.3 不是什么

- 不是通用 AI 助手，不回答知识库之外的问题
- 不是全功能笔记应用（Notion、Obsidian），不做数据库视图、看板、日历
- 不是后台常驻 AI Agent，所有 AI 调用均由用户触发
- 不是云服务，无账号体系，不支持多人协作

### 1.4 设计原则

- **文件优先**：`.md` 文件是唯一真相来源，SQLite 只存索引，可随时重建
- **块级协作**：AI 通过 str_replace + Block ID 定位，不重新生成全文
- **单索引优先**：知识库长期保持单索引，不做文档摘要索引、章节摘要索引和句级持久索引
- **检索质量优先**：查询规划 + 混合检索（向量 + FTS5 全文）+ 标题命中 + 章节证据扩展 + 条件重排
- **预算感知**：所有主要 LLM 调用按模型上下文窗口裁剪历史、证据和相关块，必要时自动 compact
- **降级友好**：Embedding API、图片 fetch、jieba 加载失败均不阻塞主流程
- **风格学习**：以用户历史文章的离线风格指纹和全局画像为主，而不是只在运行时临时抓 few-shot 片段

---

## 2. 目标用户

**核心画像：** 有大量 Markdown 文章积累的个人创作者，希望在本地工作区中统一管理知识库与写作素材，习惯用 Typora 这类干净的 Markdown 写作体验，希望 AI 辅助而非替代写作。

**典型场景：**
- 写了很多技术教程，想用历史文章的知识和风格辅助写新文章
- 查阅自己以前写过的某个主题，记不清在哪篇文章
- 对现有文章某段落不满意，想让 AI 按自己的风格改写

---

## 3. 产品结构

三个核心模块 + 共用基础设施：

```
┌──────────────────────────────────────────────────┐
│                      Notus                        │
├──────────────┬──────────────┬────────────────────┤
│   文件管理    │   知识库问答  │    AI 创作画布      │
│   (写作)     │   (检索)     │    (创作)          │
└──────────────┴──────────────┴────────────────────┘
           共用：文件系统 + 索引 Pipeline
```

九个页面（见 §6.3）。

---

## 4. 核心功能一览

### 4.1 文件管理（编辑器）

- 两栏布局：Sidebar（文件树/TOC）+ 所见即所得编辑器
- 基于 Markdown 双向转换的所见即所得编辑体验，还原 Typora 写作手感
- AST 实时解析生成 TOC，点击跳转，滚动高亮当前章节
- 文件保存自动触发增量索引（hash 比对，未变化则跳过）
- 批量导入（ZIP / 文件夹 / 单文件），SSE 进度推送
- 来源跳转锚点：URL `#L24-L28` 精确行号定位 + 高亮 3s 淡出

### 4.2 知识库问答

- 对话式布局，流式输出；历史入口收敛为 icon + tooltip，旧会话通过右侧抽屉切换
- 单索引知识库：不做分层摘要索引，依靠查询理解、混合检索和条件重排提高命中质量
- 查询规划 + 混合检索（向量 + FTS5 + 标题命中 + RRF + 章节证据扩展）
- 先判断问题是否足够清晰；如果范围不明确，直接追问，不检索，也不生成事实回答
- 对复杂问题最多只允许一次辅助调用，且只会在“改写”与“重排”之间二选一，再进入主回答
- 严格 RAG：无命中直接说不知道，不触发幻觉
- 回答会基于章节级证据自然作答，不再固定套用“结论 / 整理 / 证据”模板
- 回答模式固定为 `clarify_needed / grounded / weak_evidence / conflicting_evidence / no_evidence`
- 证据偏弱时只输出可确认部分和解释性补充；证据冲突时明确提示不同笔记中存在不同说法
- 当前打开文档优先参与召回，但只做温和优先，不能压过更强的正文证据；参考来源支持自动匹配或手动指定文档范围，但不会切换历史对话
- 支持全局历史会话与新建对话；页面默认进入新对话，不自动恢复最近一条旧会话，当前打开文档只影响优先检索
- 来源卡片：file_title + heading_path + preview + 行号，点击后在知识库页左侧编辑器定位原文并高亮
- 主要 LLM 调用按 `context_window_tokens` / `max_output_tokens` 做预算控制，必要时自动 compact 历史与证据包
- 多模型切换：Embedding 与对话模型独立配置

### 4.3 AI 创作画布

- 左右分栏（35/65）：AI 协作区 + 画布区
- 画布以块（Block）为单位，每块附 Block ID
- AI 通过 str_replace 操作 + old 字段二次校验，精准修改指定块
- 创作主链路改为“请求规划器 + 执行器”，优先用规则识别改单块、多块、全文、纯对话或文章分析，只在必要时触发一次低成本 helper
- 支持 `@bN`、`@b2 @b3`、`@b2-b5`、自然语言序号、开头/结尾、全文以及上一轮目标块延续
- 助手消息会记录最近目标块、最近操作类型、最近建议摘要、当前判断摘要和短时纠错状态，用于处理“继续改刚才那段”“按刚才建议改”“不是聊天，是改文档”这类多轮承接
- 创作请求规划固定走“候选召回 + 受控 AI 仲裁 + 风险校验”，只在低置信或高风险场景启用有限 AI 辅助，不改为 AI-first
- “写到文档中”类请求会先按编辑意图处理，并把来源内容区分为 `draft_text / edit_suggestion / analysis_feedback / general_chat`；只有合格正文草稿能直接进入写入链路
- 当主意图、来源、目标位置或写入方式不够稳定时，会在助手消息下方以内联卡片形式一次性补问最多 `3` 个问题；回答后自动续跑，但仍只生成待应用预览
- 高风险预览和澄清后续跑会回显“当前理解”摘要，并提供轻量纠偏入口，支持快速纠正“继续讨论 / 直接改文档 / 目标不对 / 来源不对 / 写入方式不对”
- 事实参考：后台自动补充，始终优先当前文档与相关笔记，不在创作页前台单独展示配置
- 风格来源：自动语义匹配（默认）或手动指定文件；大纲生成和改写统一使用“全局画像 + 相关风格指纹 + 原文摘录”的风格上下文，不新增独立风格向量索引
- 已保存文章的历史入口收敛为 icon + tooltip，旧会话通过右侧抽屉切换；从主题新建时可先生成大纲，但必须保存为正式文档后才能继续 AI 改写和续聊
- 入模上下文改为“相关块包 + 少量最近历史 + 请求内摘要 + 事实/风格裁剪”，不再默认整篇文章全量直传
- 全文改写始终保持块级结构与预览确认，只处理正文类块；软上限 `12`，硬上限 `20`，超过后自动分批或要求缩小范围
- 所有编辑结果先落为可恢复的批量预览，刷新后仍能恢复，当前文章内容变化后会自动转为 `stale`
- 主要 LLM 调用按模型上下文窗口做预算控制，接近上限时自动 compact，必要时最多重试一次
- 所有修改走 diff 预览，用户点击"应用"才落地

### 4.4 两个创作入口

- **从现有文章进入**：编辑器工具栏"AI 创作"按钮，将当前文章解析为 Block 结构打开画布
- **从主题新建**：顶部"创作"Tab → 输入主题 → Agent 检索知识库 + 生成大纲 → 写入画布 → 保存为正式文档 → 继续逐块起草

---

## 5. 核心交互流程

### 5.1 首次使用

```
启动 Web 或桌面端 → /setup 引导三步(配置模型/导入笔记/完成)
→ 后台建立索引 → 文件树就绪 → 索引完成后知识库可用
```

桌面端安装包要求附带独立应用图标，并且内置的数据库与向量检索原生依赖必须按目标平台单独准备；不能直接复用普通 Node 环境下构建出的原生模块，否则会出现安装后应用无窗口、启动即失败的情况。

### 5.2 日常写作

```
打开文件树 → 选择文章 → 编辑 → 保存 → 自动增量索引（无感知）
```

### 5.3 知识库查询

```
切换到「知识库」Tab → （可选）选择当前文章或手动限定参考范围 → 输入问题
→ 先做查询理解（直接检索 / 追问 / 单次辅助改写）
→ 混合检索 + section 证据整理 + 必要时单次条件重排
→ 按回答模式生成结果（可能是追问、保守回答或正常回答） + 来源卡片
→ 可通过历史抽屉恢复旧会话或新建对话 → 点击来源卡片并在页内定位原文
```

### 5.4 AI 创作（从现有文章）

```
编辑器打开文章 → 点击「AI 创作」→ 画布模式，文章解析为块
→ AI 协作区输入指令（如 "@b2 扩写第二段，参考我的风格"）
→ 系统先做范围规划（单块 / 多块 / 全文 / 纯对话）
→ 选取相关块包 + 事实/风格上下文 → 执行器生成一组 str_replace 操作
→ 前端展示可恢复的批量预览 → 用户确认后整体应用
→ 块更新 → MD 文件同步保存 → 增量索引
```

### 5.5 AI 创作（从主题新建）

```
点击「创作」Tab → 输入主题 → Agent 调用 search_knowledge + get_outline
→ 大纲骨架以 SSE 逐块写入画布 → 用户调整大纲（拖拽/改标题）
→ 先保存为新 MD 文件 → 再进入正式创作对话
→ 系统按请求范围生成单块 / 多块 / 全文预览，必要时分批执行
→ 用户确认后应用修改 → 自动索引
```

---

## 6. UI 规范（单一事实源）

> 本节吸收自 Notus UI Guide v2.2，是所有页面的权威定义，PRD 不重复。

### 6.1 Design Tokens

#### 6.1.1 颜色（Claude 风格，Terracotta + Cream）

```
/* ===== Light ===== */
--bg-primary: #FAF9F5;         --bg-secondary: #F0EDE6;
--bg-elevated: #FFFFFF;        --bg-hover: #EAE7E0;
--bg-active: #E2DED6;          --bg-sidebar: #EEEBE4;
--bg-input: #FFFFFF;

--bg-diff-add: #DAFBE1;        --bg-diff-remove: #FFE2E0;
--bg-diff-modified: #FFF8C5;
--bg-ai-bubble: #FAF9F5;       --bg-user-bubble: #F0EDE6;

--border-primary: #D8D4CB;     --border-subtle: #E8E5DE;

--text-primary: #1A1311;       --text-secondary: #6B6158;
--text-tertiary: #9C9489;      --text-on-accent: #FFFFFF;

--accent: #C15F3C;             /* Terracotta */
--accent-hover: #A8502F;       --accent-subtle: #FBEEE8;
--accent-muted: #D4896E;

--danger: #D93025;             --danger-subtle: #FDE7E7;
--warning: #E09A1A;            --warning-subtle: #FFF8E1;
--success: #1E8E3E;            --success-subtle: #E6F4EA;

--shadow-sm: 0 1px 2px rgba(26,19,17,0.06);
--shadow-md: 0 4px 12px rgba(26,19,17,0.08);
--shadow-lg: 0 8px 24px rgba(26,19,17,0.12);

/* ===== Dark（保持暖调） ===== */
--bg-primary: #1C1917;         --bg-secondary: #252220;
--bg-elevated: #2E2A27;        --bg-hover: #38332F;
--bg-active: #443E39;          --bg-sidebar: #211E1C;
--bg-input: #2E2A27;
--bg-diff-add: #1A3326;        --bg-diff-remove: #3D2020;
--bg-diff-modified: #3D3520;
--border-primary: #3D3835;     --border-subtle: #332F2C;
--text-primary: #EDE8E3;       --text-secondary: #A69E95;
--text-tertiary: #7A7269;
--accent: #D4896E;             --accent-hover: #C15F3C;
--accent-subtle: #3D2E27;      --accent-muted: #A8502F;
--danger: #F87171;             --danger-subtle: #3D2020;
--warning: #FBBF24;            --warning-subtle: #3D3520;
--success: #4ADE80;            --success-subtle: #1A3326;
```

#### 6.1.2 字体

```
--font-ui: 'PingFang SC', 'Noto Sans SC', -apple-system, sans-serif;
--font-editor: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', Georgia, serif;
--font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;

--text-xs: 11px;    --text-sm: 13px;    --text-base: 15px;
--text-lg: 18px;    --text-xl: 22px;    --text-2xl: 28px;  --text-3xl: 36px;
```

`Noto Serif SC` + `JetBrains Mono` 通过 Google Fonts CDN 加载（font-display:swap），UI 字体走系统栈。

#### 6.1.3 间距 / 圆角 / 动画

```
--space-1..8: 4/8/12/16/20/24/32 px
--radius-sm/md/lg/xl/full: 4/6/8/12/9999 px
--transition-fast/normal/slow: 120/200/300 ms ease
```

### 6.2 全局 Shell

```
┌──────────────────────────────────────────────┐
│  TopBar (h:48px, fixed)                      │
├──────────┬───────────────────────────────────┤
│ Sidebar  │  Main Content                     │
│ w:240px  │  (flex:1, overflow-y:auto)        │
│ 可折叠    │                                   │
└──────────┴───────────────────────────────────┘
```

TopBar = Logo + 三 Tab（文件/知识库/创作）+ 顶部保存状态按钮 + 设置按钮 + 索引 mini indicator（h:2px bg:--accent）。保存按钮统一承载“保存中 / 未保存 / 已保存”三种状态，其中未保存态使用红色文字和红色边框强调待保存风险。
Sidebar = 顶部 Tab（📁/≡）+ 搜索框 + 内容区（bg:--bg-sidebar）。
AI 页面间切换使用轻量过渡层，已完成 AI 配置时不应短暂闪出锁态；Sidebar 收缩态仅保留展开按钮，不显示文件树 / 大纲入口。
登录页、初始化页、错误页不使用 Shell。

### 6.3 页面清单

| # | 路由 | 名称 | Shell | 说明 |
|---|------|------|-------|------|
| 1 | `/login` | 登录 | 否 | OIDC 中间态 |
| 2 | `/setup` | 初始化引导 | 否 | 首次三步配置（模型/导入/完成） |
| 3 | `/files` | 文件管理 | 是 | 默认页，所见即所得 Markdown 编辑器 |
| 4 | `/knowledge` | 知识库问答 | 是 | 左侧文章编辑（可关闭）+ 右侧对话 |
| 5 | `/canvas` | AI 创作画布 | 是 | 左侧创作块 + 右侧风格来源与对话（事实参考后台自动补充） |
| 6 | `/settings/model` 等 | 设置 | 是 | 模型/存储/快捷键/关于 |
| 7 | `/indexing` | 索引进度 | 是 | 批量索引可视化 |
| 8 | `/*` | 404 | 是 | 未匹配路由 |
| 9 | — | 错误页 | 否 | 不可恢复错误 |

### 6.4 文件管理页（`/files`）

布局：Sidebar + EditorToolbar(h:40px) + EditorArea(max-width:780px mx:auto padding:60px font:--font-editor --text-lg line-height:1.8)。

**EditorToolbar 分组：** 文字格式（B/I/U/S）| 标题 H▾ | 插入（🔗/🖼）| 块级（`</>`/❝/—）| 列表（UL/OL/Todo）| 清除样式 | [AI 创作]。按钮 32x32 icon 18x18，hover 显示 tooltip。

**EditorArea：** H1 --text-3xl/700, H2 --text-2xl/600, H3 --text-xl/600；代码块 bg:--bg-secondary --font-mono；引用块左边框 3px --accent；图片 max-width:100% shadow:--shadow-sm；来源高亮响应 URL hash `#L24-L28`。

**状态：** 空态(📝 "选择一篇文章开始编辑") / 加载中(Skeleton) / 加载失败(⚠️+ 重试) / 保存中(TopBar Spinner → ✓)。

### 6.5 知识库问答页（`/knowledge`）

布局：Sidebar + 右侧 ChatArea + InputBar(sticky bottom)。只有在选中文件后，才展开左侧文章编辑区（默认约 44%，可拖拽调整并记住上次宽度，可关闭）。

用户消息右对齐 bg:--bg-user-bubble radius:--radius-lg max-width:80%；AI 回复左对齐无背景，头部 ✨+Notus label，正文 markdown + StreamingText，底部 SourceCard 列表。

左侧文章区直接复用 WYSIWYG 编辑器和工具栏，可边看边改，也可一键收起。问答区顶部展示当前文章提示、历史抽屉入口、新建对话 icon 按钮，以及“参考来源”区（自动匹配 / 手动指定文件）。当前打开文档只影响优先检索与参考来源设置，不再切换聊天历史。InputBar：模型 Select(sm，下拉展开，仅展示 modelId) + TextArea(flex:1) + 发送按钮(40x40 bg:--accent radius-full)；`v1` 不展示 `+` 附件入口。

来源卡片点击后保持在知识库页，自动展开左侧编辑区并定位原文，可手动关闭高亮。

AI 回复头部可按回答模式显示轻量状态标记，例如“需澄清 / 证据偏弱 / 证据冲突 / 未找到证据”。

**状态：** 空态(✨ + 3 个 suggestion chip) / 索引未完成(⏳ + ProgressBar) / 模型未就绪(整块锁态 + 前往设置) / AI 回复中(StreamingText + 停止生成) / 需澄清(只追问，不检索) / 证据偏弱(保守回答) / 证据冲突(明确提示不同说法) / 检索无足够证据(文字提示) / API 错误(InlineError + 重试)。

### 6.6 AI 创作画布页（`/canvas`）

布局：Sidebar + CanvasArea(默认约 62%) + AIPanel。中间分栏可拖拽调整，并记住上次使用宽度。

**AIPanel：** 已保存文章时，顶部仅保留“查看历史对话 / 新建对话”两个 icon 按钮，旧会话通过 ConversationDrawer 抽屉展示；其下是风格来源区域（自动匹配 / 手动指定） + 对话区（支持文本回复、文章分析、批量修改预览恢复，以及结构化提问卡片恢复） + InputBar（`@b2` / `@b2-b5` / “全文”快捷项，`@` 触发当前文档块 autocomplete，模型选择框下拉展开且仅展示 modelId）。当系统无法稳定理解“把上面的内容写到文档中”“把刚才生成的内容写进去”这类编辑请求时，会在助手消息下方以内联卡片形式一次性补问最多 3 个问题；用户回答后会自动继续生成预览，不要求再补发一轮消息。高风险预览和澄清后续跑会额外显示“当前理解”摘要，并提供轻量纠偏入口，用户可以直接点选“继续讨论 / 直接改文档 / 目标不对 / 来源不对 / 写入方式不对”，不必每次都重新组织完整提示词。事实参考由后台默认自动补充，并始终优先当前文档；系统入模时只选取相关块包、最近少量历史和请求内摘要，不再默认整篇文章全量直传；文章分析默认关闭，只保留后端开关；未保存的大纲草稿则显示“先保存再继续 AI 改写”的引导卡片，并禁用历史会话与输入栏。只要当前创作存在未保存改动，用户从侧边栏、顶部搜索或页内切换到其他文章前，都必须先经过统一的未保存确认弹窗。

创作页点击侧边栏文件时，不跳回文件页，而是在当前画布页读取对应文章内容并转成创作块。

**CanvasArea：** 标题 --text-3xl/700 + CanvasBlock 列表（gap:--space-1）+ AddBlockButton（dashed border）。

**CanvasBlock 六态：** 默认 / hover（border-left + 操作栏 ⠿/✏️/🗑/↻）/ 编辑中（inline textarea）/ AI 已纳入待应用预览（bg:--bg-diff-modified）/ AI 处理中（border-left 脉冲）/ 已应用（flash success 300ms）。

**无文章态：** 新建创作入口（居中 max-width:480px，主题 Input h:48px + primary "生成大纲并开始" + 最近创作列表）；模型未就绪时整体禁用并展示锁态说明。

**状态：** 加载中(Skeleton) / 模型未就绪(整页浅遮罩 + 锁态卡片) / AI 处理中(脉冲 + StreamingText) / 大纲生成中(整页蒙版 + loading 卡片，底层块内容逐步写入) / 提问卡片待回答(内联卡片 + 输入框轻提示) / 提问卡片已失效(只读提示，需重新确认) / 回答已记录但续跑失败(助手提示 + 重试生成预览) / 高风险预览(当前理解摘要 + 轻量纠偏入口)。

### 6.7 设置页（`/settings/model` 等）

布局：SettingsNav(w:200px) 替换 Sidebar + 内容区(max-width:920px mx:auto)。四项：模型配置 / 存储 / 快捷键 / 关于；每项使用单独路径。

**模型配置：** Embedding（Base URL + 模型名 + API Key + 维度只读）+ LLM 卡片列表（配置名称 + 厂商识别 + 模型名 + Base URL + 密钥状态）+ [测试连接] + [保存 / 设为默认]。系统根据 Base URL 与模型名自动识别兼容厂商，Embedding 维度在测试后自动确认；设置页和引导页 Step 1 中的 Embedding 三个输入框初次展示默认留空，不自动回填已保存的 Base URL、模型名和 API Key；保存成功后，Base URL 与模型名输入框立即显示当前值，API Key 输入框继续留空，并通过“已保存，留空不修改”占位提示反映状态。LLM 卡片保留默认配置说明，但去掉非默认配置的冗余说明区和“配置完整”状态徽标；LLM 预算字段仍会在后端持久化用于运行时控制，但不在卡片中直接展示。

API Key 四态：默认 / 已填写（•••• + 👁）/ 校验通过（✓ + border success）/ 校验失败（✕ + border danger + 错误文字）。

测试连接：默认 secondary → loading → 成功 Toast + 按钮闪绿 → 失败 Toast + 按钮闪红。

外观配置已从设置页移除，当前版本默认采用统一的编辑工作界面，不再单独暴露主题、字号、行高入口。

**存储：** 笔记目录只读 + 索引状态 Badge + [重建索引] + [清除索引]（danger ConfirmDialog）。

### 6.8 登录 / 初始化页

**`/login`**：全屏居中。Logo 64x64 + Spinner + "正在登录..."。5s 超时 fadeIn [重新登录]。失败态 → ✕ + 错误文字。

**`/setup`**：三步，全屏居中；Step 1 使用更宽的双栏容器（约 max-width:1180px），Step 2/3 约 max-width:760px。步骤指示器圆点 12x12 + 连接线。

| Step | 内容 | 跳过 |
|------|------|------|
| 1 | 配置 AI 模型 | ✓ |
| 2 | 导入笔记（拖拽区 border:2px dashed） | ✓ |
| 3 | 完成 + 索引进度 + [开始使用] | ✗ |

### 6.9 索引进度 / 404 / 错误

**`/indexing`**：有 Shell，居中 max-width:640px。ProgressBar + 文件计数 + 当前文件 + 已完成列表（✓/⚠）。

**404**：有 Shell。EmptyState：404 大字 opacity:0.15 + [返回首页]。

**错误页**：无 Shell。⚠️ 64x64 --danger + "出了点问题" + [重新加载] [前往设置]。

### 6.10 通用组件库（28 个）

**基础（20 个）：** Button（4×3）、Dialog、ContextMenu、Input、TextArea、Select、SearchInput、CommandPalette（⌘K）、SearchResults、Spinner、Badge（5 变体）、Tooltip（500ms 延迟）、Toast、Toggle、Tabs、ConfirmDialog、FilePickerDialog、ProgressBar、EmptyState、IconButton。

**业务（8 个）：** SourceCard（来源卡片）、BatchOperationCard（批量预览卡片）、CanvasBlock（画布块）、StreamingText（闪烁光标）、Skeleton（shimmer）、InlineError、ConversationDrawer（历史对话抽屉）、PageTransitionOverlay（页面切换过渡层）。

### 6.11 布局边界

- 当前版本按桌面工作区设计。
- 侧边栏折叠状态与文件树展开状态会持久化。
- 侧边栏收缩态顶部仅保留展开按钮，不显示文件树 / 大纲入口。
- 已完成 AI 配置后，切往知识库页 / 创作页时通过轻量 PageTransitionOverlay 过渡，避免短暂闪出锁态。
- 本版本不提供移动端适配，也不提供平板/手机降级布局。

### 6.12 快捷键

界面内不再直接展示快捷键提示，统一在 `/settings/shortcuts` 页面查看和维护。

⌘K 全局搜索 · ⌘S 保存 · ⌘B/I 加粗/斜体 · ⌘\ 折叠 Sidebar · ⌘Enter 发送 · Esc 关闭浮层

---

## 7. 设计决策备忘

| 决策 | 选择 | 理由 |
|------|------|------|
| 侧边栏结构 | 文件树 + TOC 共用 Sidebar，Tab 切换 | 与 Typora 一致，节省空间 |
| 创作画布布局 | 左右分栏（35/65） | 类 Cursor 体验，宽屏友好 |
| 对话历史入口 | icon button + drawer 抽屉 | 降低顶部表单感，保留旧会话快速切换 |
| 上下文入模策略 | budget-aware + 自动 compact | 优先保留当前证据、相关块和最近对话，避免超限失败 |
| 风格样本策略 | 风格指纹 + 全局画像 + 自动语义匹配 / 手动覆盖 | 在效果、速度和 token 成本之间取中间值 |
| 创作事实策略 | 后台自动补充，前台只暴露风格来源 | 减少配置负担，同时保留表达控制 |
| 创作入口 | 编辑器按钮 + 独立 Tab | 覆盖"改现有"+"写新文" |
| 编辑器方案 | Tiptap + tiptap-markdown | 直接提供所见即所得与 Markdown 双向转换 |
| 配色 | Claude Terracotta + Cream | 温暖、非 AI 冷感 |
| AI 修改确认 | diff 预览 → 用户确认 | 防改错，保留撤销 |
| 来源跳转 | 精确行号 + 高亮 3s 淡出 | 定位段落而非开文章 |
| AI 定位块 | Block ID + old 字段校验 | Claude Artifacts 同款 |
| 组件库策略 | Radix Primitives 行为 + 手写样式 | 比 shadcn 覆写更干净 |

---

**Notus · 私有部署 · 数据自主**
