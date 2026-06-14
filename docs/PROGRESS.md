# Notus 项目进度

> 最后更新：2026-06-14
> 对应文档：`docs/Notus_PDD.md` / `docs/Notus_PRD.md` / `docs/Notus_UI_Guide.md` / `docs/Notus_Business_Logic_Upgrade.md` / `docs/Notus_Desktop_Roadmap.md` / `docs/Notus_Release_Notes.md`

---

## 总体状态

| 阶段 | 说明 | 状态 |
|------|------|------|
| 产品长期形态 | 已重新明确为本地 Markdown 工作区中的 AI 知识与写作协作环境，第一阶段已落地文件系统真相、数据库索引、文档级上下文和会话 scope | ✅ 第一阶段完成 |
| 前端 UI（完整交互） | 所有页面、组件、样式 + 完整前端交互逻辑 | ✅ 完成 |
| 后端核心库 | 数据库、运行时、索引、检索、Agent、设置 | ✅ 核心链路完成 |
| 真实后端接口 | 接入真实文件系统 + SQLite + SSE + LLM / Embedding | ✅ 已切到真实后端，批量导入/导出、图片代理与图片向量检索已补齐 |
| 可观测性 | 结构化日志 + 请求 ID + 日志查询接口 + 设置页日志查看 | ✅ 已完成 |
| 平台中间层与桌面端 | Web + Electron 并存、托管工作区、桌面桥接 | ✅ 已完成主链路接入，待实机安装验证 |

桌面端逐条未完成项、专项验证和后续迭代记录，统一维护在 `docs/Notus_Desktop_Roadmap.md`。

---

## M1 基础骨架

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M1-01 项目初始化 + CSS Token 系统 | `notus/package.json` `notus/next.config.js` `styles/globals.css` | ✅ | 含 light/dark 双主题，所有设计 token |
| M1-02 `lib/db.js` SQLite + sqlite-vec 初始化 | `lib/db.js` | ✅ | 已补齐 `files/chunks/chunks_vec/chunks_fts/images/conversations/messages/settings`、FTS5 触发器与运行时设置读写；Workspace Agent 第一阶段已新增稳定身份、文件元数据、chunk 来源 hash、四类会话 scope，迁移不清空 `chunks_vec` |
| M1-03 `lib/indexer.js` 分块 + 索引 | `lib/indexer.js` | ✅ | 已改为 AST 分块；Embedding 失败时保留 FTS 检索并标记待重试；hash 与 `index_version` 未变化时跳过重切分和重新 embedding |
| M1-04 `lib/embeddings.js` | `lib/embeddings.js` | ⚠️ 部分 | 已接真实文本 / 多模态 Embedding API；图片向量支持已补；设置页与引导页现改为只填写 Base URL / 模型名 / API Key，厂商由系统自动识别；仍需用真实 API Key 做多提供商实测 |
| M1-05 `lib/watcher.js` chokidar | `lib/watcher.js` | ✅ | 已接入运行时初始化，监听 `add/change/unlink` 并触发索引；已增加文件级串行队列、延迟删除和基于 frontmatter id 的重命名识别 |
| M1-06 env.local.example + _app.js + globals.css | `.env.local.example` `pages/_app.js` | ✅ | |

---

## M2 文件管理 & 编辑器

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M2-01 App Shell（TopBar + Sidebar + Shell） | `components/Layout/` | ✅ | Shell 已同步全局 `activePage`；侧边栏折叠、文件树展开、文件树 / 大纲 tab 与各 tab 滚动位置现已持久化；知识库页已开放文章大纲 |
| M2-02 FileTree 组件（前端交互） | `components/Layout/Sidebar.js` `contexts/AppContext.js` `pages/api/files/` | ✅ | 已接真实文件系统与 SQLite；新建文件无需输入 `.md` 后缀，索引告警不再阻断文件创建；搜索已加 `useDeferredValue` 防抖；已添加右键上下文菜单（重命名/删除），并支持在开启设置项后将侧边栏重命名反向同步到正文首个 H1；同一文档可在文件、知识库、创作页恢复最近阅读位置 |
| M2-03 WYSIWYG Markdown 编辑器 | `components/Editor/WysiwygEditor.js` `components/Editor/EditorToolbar.js` | ✅ | Tiptap + Markdown 双向转换；支持标题、链接、加粗、斜体、下划线、列表、任务列表、引用、代码块、分隔线、图片；代码块已接入 lowlight 语法高亮与语言选择；工具栏底部添加橙色脉冲条以指示未保存状态 |
| M2-04 MarkdownRenderer | `components/Editor/MarkdownPreview.js` | ✅ | remark-gfm，待接入 rehype-katex |
| M2-05 TocTree | `components/Layout/Sidebar.js` `hooks/useEditorToc.js` `pages/files/index.js` `pages/knowledge.js` | ✅ | 文件页和知识库页共用真实 H1-H6 大纲；支持点击精确跳转、滚动联动高亮和 tab 往返后的正确选中状态 |
| M2-06 URL hash 来源跳转 + 高亮淡出 | `pages/files/index.js` `components/ui/SourceCard.js` | ✅ | 来源卡片已支持按 fileId + lineStart/lineEnd 跳转并高亮淡出；已补充 `#L24-L28` hash 格式解析（mount 时读 `window.location.hash`，清理后注入现有滚动流程）与 Tiptap 光标定位（`posAtDOM` + `setTextSelection`） |
| M2-07 批量导入/导出 + SSE 进度 | `pages/api/files/` `components/Layout/Sidebar.js` | ✅ | 已完成 `/api/files/import` `/api/files/export`；导入支持 50MB 请求体、保存/索引阶段进度、逐文件告警与请求 ID |
| M2-08 `/indexing` 页面 | `pages/indexing.js` | ✅ | 已接 `/api/index/status` 与 `/api/index/rebuild` SSE，支持真实进度、当前文件、失败项与重新构建；顶部已常驻显示"已索引 N / 总数"统计与失败数警示 |

---

## M3 知识库问答

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M3-01 `lib/retrieval.js` 查询规划 + 混合检索 | `lib/retrieval.js` | ✅ | 已升级为单索引下的查询规划、多 query variant 召回、文件标题 FTS 命中、章节证据扩展、证据句提取、条件重排输入与更保守的当前文档优先策略 |
| M3-02 jieba-wasm 集成 + FTS 分词 | `lib/tokenizer.js` | ✅ | 已改为应用层分词，不再依赖 SQLite 自定义 tokenizer |
| M3-03 `lib/prompt.js` 知识库 Prompt | `lib/prompt.js` | ✅ | 已补齐 `clarify_needed / grounded / weak_evidence / conflicting_evidence / no_evidence` 五种回答模式的提示约束，并新增条件 rerank Prompt |
| M3-04 `/api/chat` SSE 流式 | `pages/api/chat.js` | ✅ | 已接真实检索、对话存储、查询规划与 LLM 流式输出；新增澄清直返、`no_evidence` 模板化直返、单次 helper 护栏、`assistant_meta` 回传与消息 meta 落库；已增加文档级上下文读取和 `documents/document_stats` 元信息 |
| M3-05 ChatArea + SourceCard 组件 | `components/ChatArea/` `components/ui/SourceCard.js` | ✅ | 知识库页已支持”无文件时仅问答，选中文件后显示左侧编辑器”的分屏模式；前端现改为消费 `assistant_meta / done.meta` 展示真实回答模式、来源说明和本次读取的 Markdown 文档摘要；AI 回复开始后会立即渲染无边框气泡内等待态，检索状态在 loading 气泡内按步骤切换，来源卡片与当前文档标题统一使用可读标签；左侧文档区与其他工作页共享最近阅读位置，AI 未就绪时文章和大纲仍可使用 |
| M3-06 多模型切换 Select | `components/ChatArea/InputBar.js` | ✅ | UI 与 `/api/chat` 的 `model` 参数已打通；模型选择框固定在底部输入栏右下角，触发器单行缩略，菜单项展示完整模型名 |
| M3-07 知识库参考来源手动指定 | `pages/knowledge.js` `pages/api/chat.js` `lib/retrieval.js` | ✅ | 已接 file id 过滤、当前文档优先召回、章节聚合与证据不足兜底；来源卡片留在知识库页并定位左侧编辑器 |

---

## M4 AI 创作画布

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M4-01 `lib/diff.js` str_replace 引擎 | `lib/diff.js` | ✅ | 已支持 `replace/insert/delete` 与 `applyOperations` 批量回滚，返回 `BLOCK_NOT_FOUND` / `OLD_MISMATCH` |
| M4-02 `/api/articles/parse` + `/api/articles/save` | `pages/api/articles/` `utils/markdownBlocks.js` | ✅ | 已接本地 Markdown 文章解析与保存；文章分块现改为服务端 AST 驱动的结构化分块 |
| M4-03 创作规划器 + 执行器主链路 | `lib/canvasRequestPlanner.js` `lib/canvasAgent.js` | ✅ | 已从旧的单块工具循环升级为“规则规划 + 单次 helper + 执行器”主链路，支持单块、多块、全文与文本回复/文章分析；多轮续聊现会沿用最近目标块、最近操作类型和最近建议摘要 |
| M4-04 旧 intent 链路清理 | `pages/api/agent/intent.js` `lib/agent.js` | ✅ | 旧的独立 intent 接口和 legacy Canvas 工具循环已移除，当前只保留内置请求规划主链路 |
| M4-05 大纲生成 `/api/agent/outline` SSE | `pages/api/agent/outline.js` `lib/prompt.js` | ✅ | 已接 LLM 大纲生成，并改为复用 `getStyleContext()`，让大纲和改写共用同一套风格上下文 |
| M4-06 Agent 运行 `/api/agent/run` SSE | `pages/api/agent/run.js` | ✅ | 已升级为返回 `thinking/token/batch_start/batch_progress/batch_done/assistant_meta/operation/done`；创作聊天现支持批量预览持久化、刷新恢复、全文分批执行，以及 Canvas 专用日志观测 |
| M4-07 CanvasBlock 组件 | `components/Canvas/CanvasBlock.js` `pages/canvas.js` | ✅ | 6 状态完整；双击进入 textarea 内联编辑；已接 dnd-kit 拖拽排序；快捷键提示已从界面隐藏，配置移入设置页；已添加 30s 自动保存（dirty 状态下计时，保存中/保存成功时重置）；创作块区可按 block id 或正文锚点与文件页、知识库页互相恢复位置 |
| M4-08 AIPanel + 批量预览恢复 | `components/AIPanel/BatchOperationCard.js` `pages/canvas.js` | ✅ | 已支持整组预览、整组应用/取消、刷新恢复全部未应用预览、文章变更后 `stale` 提示；AIPanel 继续保留后台自动事实补充 + 前台风格来源配置；历史会话抽屉支持二次确认删除 |
| M4-09 新建创作入口页 | `pages/canvas.js` CanvasEntry | ✅ | 话题输入 + 最近列表全部可点击，"从空白开始"按钮可用；侧边栏选中文件后会在当前页基于该文章进入创作；新主题内容可保存为 Markdown 并索引 |
| M4-10 编辑器"AI 创作"按钮 | `components/Editor/EditorToolbar.js` | ✅ | 点击跳转 /canvas |
| M4-11 风格指纹与旧文回填 | `lib/style.js` `lib/indexer.js` `lib/runtime.js` | ✅ | 已新增 `style_fingerprints / style_profile`、索引后自动提取、旧文后台回填、重建索引暂停与恢复 |
| M4-12 工作区工具层第一阶段 | `lib/workspaceAgentTools.js` `lib/workspaceScope.js` `pages/api/conversations/[id]/scope.js` | ✅ | 已新增 `search_knowledge/read_file/get_style_context/ask_user/preview_edit_article` 工具骨架、四类会话 scope 与预览应用前的写入范围校验 |

---

## M5 体验打磨 & 部署

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M5-01 设置页（模型/个性化/存储/日志/关于） | `pages/settings/[section].js` `components/Settings/SettingsScreen.js` | ✅ | 模型配置现统一为手动填写 Base URL / 模型名 / API Key；页面已去除说明性段落、默认配置说明条和弹窗自动识别说明句；个性化页提供“标题与文件名双向绑定”开关，默认关闭；存储页已接真实重建/清除索引；日志页可查询服务端 JSONL 日志 |
| M5-02 CommandPalette（cmdk） | `components/Layout/TopBar.js` | ⚠️ 部分 | 已提供全局文章搜索弹层和 ⌘K 快捷键；空输入时不再展示文章；完整命令面板仍未实现 |
| M5-03 快捷键绑定 | `contexts/ShortcutsContext.js` `components/Editor/WysiwygEditor.js` `components/Layout/TopBar.js` `components/ChatArea/InputBar.js` `components/Canvas/CanvasBlock.js` | ✅ | 常用快捷键已集中到 `/settings/shortcuts` 维护，并接入搜索、发送、保存文档、保存块编辑、取消块编辑；用户可见提示已按平台显示 Command / Ctrl；Electron 已补充固定系统级搜索快捷键 |
| M5-04 Toast 全局错误降级 | `components/ui/Toast.js` `lib/errors.js` | ✅ | `lib/errors.js` 已补充 `HTTP_ERROR_MESSAGES` 映射表（400/401/403/429/500/502/503）与 `httpErrorMessage()` 工具函数，供所有 API 路由与前端错误分支调用 |
| M5-05 主题样式基础 | `styles/globals.css` | ✅ | 保留亮/暗色 token 结构，但当前设置页不再暴露外观配置 |
| M5-06 `/setup` 三步引导 | `pages/setup.js` `contexts/AppStatusContext.js` | ✅ | Step 1 现统一为手动填写 Base URL / 模型名 / API Key，并自动识别兼容厂商；Step 2 支持真实 Markdown 文件/目录导入；Step 3 已接真实导入、索引进度、导入后文件树同步与告警展示；入口守卫已接入 |
| M5-07 404 / 错误页 | `pages/404.js` `pages/error.js` | ✅ | |
| M5-08 平台中间层与 Electron 桌面壳 | `lib/platform/` `contexts/PlatformContext.js` `desktop/` | ✅ | 已补齐运行目标识别、路径解析、能力清单、桌面桥接、托管工作区存储与 Electron 启动壳 |
| M5-09 桌面端安装与卸载验证 | `desktop/` | ❌ | Windows NSIS 卸载清理、macOS DMG 清理流程仍需实机验证；逐条事项见 `docs/Notus_Desktop_Roadmap.md` |
| M5-10 健康检查 + 启动延迟调优 | `pages/api/health.js` | ✅ | 已接运行时初始化、sqlite-vec 状态与目录检查 |
| M5-11 可观测日志系统 | `lib/logger.js` `pages/api/logs.js` `components/Settings/SettingsScreen.js` | ✅ | JSONL 落盘、`x-request-id`、日志查询 API、设置页日志查看；核心导入/索引/模型/设置链路已接入 |

---

## API 接口完成度

## 当前需求口径

- Notus 的长期形态是本地 Markdown 工作区中的 AI 协作环境，目标是结合 Obsidian 式文件可控性与 Claude Code / Codex 式工作区 Agent 能力。
- 旧的“知识库问答 + 普通文件改写”只能描述当前部分能力，不能作为最终产品定义。
- 文件系统仍是真相来源；数据库只保存索引、缓存、会话、预览和运行状态。
- 后续 Agent 能力应围绕工作区工具扩展，包括读取文件、搜索工作区、创建笔记、更新 frontmatter、多文件预览、整理目录和检查内部链接。
- 检索范围、写入范围和风格参考范围应逐步升级为会话级可见状态，而不是仅作为单次请求参数。
- 所有写入 Markdown 的能力都必须先生成可审查结果；单文件使用块级 diff，多文件使用批量预览。
- 知识库页以问答为主；未选中文件时不显示文章编辑器，选中文件后在当前页内展开左侧编辑区。
- 知识库回答已从“只给来源入口”升级为“基于章节证据自然回答”，并新增查询规划、标题命中、章节上下文扩展、澄清追问、条件重排、弱证据/冲突模式与证据不足保守回答。
- 知识库页历史会话仍统一保留在全局空间；页面首次进入默认新对话，不再自动恢复最近一条历史，只有用户主动选择旧会话时才续聊。
- 知识库来源卡片点击后不再跳文件页，而是在知识库页左侧编辑器内定位原文并保持高亮，直到手动关闭。
- 知识库问答继续保持单索引架构，不做摘要层级索引；每轮请求最多只允许“辅助 1 次 + 主回答 1 次”，且 `clarify_needed` 与 `no_evidence` 不调用主回答模型。
- 知识库页与创作页的 AI 回复等待态统一放回 AI 气泡区；知识库检索状态在 loading 气泡内动态切换；输入栏生成中只保留停止按钮。
- 知识库页与创作页的澄清交互已统一为设计稿 `ClarifyDrawer`：知识库页改为结构化澄清抽屉，创作页改为答完先回顾再继续生成预览；两页都会隐藏 interaction 摘要用户消息与 retry 助手消息。
- 侧边栏文件树 / 大纲 tab 与各 tab 滚动位置已持久化；文件页、知识库页和创作页共享同一文档的最近阅读位置，普通滚动停止后再保存，切页时同步写入；显式来源定位和 URL 行号定位优先。
- 知识库页与创作页历史抽屉支持删除整条会话；删除当前会话后回到新对话空态，创作页保留当前文章块内容和未保存状态。
- 文件页、知识库页与创作页的可见文档标题统一优先显示标题或去掉 `.md` 的文件名，不再暴露 `article_xxx`、`notus_xxx`、裸 `fileId` 等内部标识。
- 文件页与知识库页新增可选的标题与文件名双向绑定；默认关闭，开启后按正文首个可见 H1 在保存或侧边栏显式重命名时同步标题与文件名。
- 文件页、知识库页、创作页共享当前文档状态；用户切页后无需二次重新打开同一篇文档。
- 创作页事实参考已收口为后台自动补充；前台只保留风格来源配置，并让当前文档参与大纲生成与 AI 改写。
- 创作页风格仿写已从“临时样本片段”升级为“风格指纹 + 全局画像 + 相关原文摘录”的组合上下文；大纲生成与改写已统一复用 `getStyleContext()`，不新增独立风格向量索引。
- 创作页 AI 面板支持按文章绑定的历史会话、新建对话与多轮续聊；从主题新建时可先生成大纲，但必须保存为正式文档后才能继续 AI 改写与历史对话。
- 创作页已支持单块、多块、全文改写范围识别；继续兼容 `@bN`、`@b2 @b3`、`@b2-b5` 和“全文”。
- 创作页 Agent Prompt 已收紧：没有明确修改动词时不再默认偏向编辑，局部修改时继续要求输出完整目标块 `old/new`，无法保证完整时不生成操作。
- 全文改写维持块级结构，不做 raw text 整篇覆盖；正文块软上限 `12`，硬上限 `20`，超限时自动分批或要求用户缩小范围。
- 文章分析能力已接入，但默认保持关闭，只能通过后端配置开启；Canvas 新配置目前不在设置页提供 UI。
- 创作页文章分块已升级为“标题层级优先，语义分块回退”的结构化分块。
- 侧边栏折叠状态与文件树展开状态会持久化；当前工作区继续沿用原有页面壳层和桌面布局，未额外改动知识库页与创作页的侧边栏响应式行为。
- 快捷键提示默认不直接展示，统一通过设置页维护。

### 已接真实后端

| 路由 | 方法 | 状态 |
|------|------|------|
| `/api/health` | GET | ✅ |
| `/api/setup/status` | GET | ✅ |
| `/api/setup/complete` | POST | ✅ |
| `/api/files` | GET / POST | ✅ |
| `/api/files/tree` | GET | ✅ |
| `/api/files/:id` | GET / PUT / DELETE | ✅ |
| `/api/files/rename` | POST | ✅ |
| `/api/files/move` | POST | ✅ |
| `/api/files/import` | POST SSE | ✅ |
| `/api/files/export` | GET | ✅ |
| `/api/files/:id/content-image` | GET | ✅ |
| `/api/index/status` | GET | ✅ |
| `/api/index/rebuild` | POST SSE | ✅ |
| `/api/index/retry` | POST | ✅ |
| `/api/index/clear` | POST | ✅ |
| `/api/models` | GET / POST | ✅ |
| `/api/logs` | GET | ✅ |
| `/api/search` | POST | ✅ |
| `/api/chat` | POST SSE | ✅ |
| `/api/agent/outline` | POST SSE | ✅ |
| `/api/agent/run` | POST SSE | ✅ |
| `/api/agent/apply` | POST | ✅ |
| `/api/articles/:id` | GET | ✅ |
| `/api/articles/parse` | POST | ✅ |
| `/api/articles/save` | POST | ✅ |
| `/api/conversations` | GET / POST | ✅ | 已支持按 `kind + file_id/draft_key` 过滤最近会话列表；知识库页当前默认只按 `kind=knowledge` 读取全局历史 |
| `/api/conversations/:id` | GET / DELETE | ✅ | 已供知识库页与创作页恢复旧会话消息 |
| `/api/settings` | GET / PUT | ✅ |
| `/api/settings/test` | POST | ✅ |

### 尚未实现 / 待验证

- 完整 CommandPalette（cmdk 命令面板）仍未实现；当前是全局文章搜索弹层。
- 登录页仍是演示跳转，尚未接真实 Lazycat/OIDC 认证。
- sqlite-vec x86_64 / aarch64 与 `.lpk` 实机打包部署仍待验证；当前已切到 Linux amd64 + Node 20 的构建链路，仍需真实懒猫环境确认运行时兼容性。

---

## 后续实现优先级

### P0 已完成：核心可用性闭环

1. **`/setup` 三步引导接真实流程** — 已完成真实导入、索引进度与入口守卫。
2. **`/indexing` 页面接真实进度** — 已完成状态统计、SSE 重建进度、当前文件与失败项展示。
3. **设置页索引维护** — 已完成真实重建与清除索引。

### P1 已完成：知识库主链路补全

1. **手动参考来源过滤** — 已完成 `/api/chat` + `hybridSearch(fileIds)` 后端过滤。
2. **来源卡片跳转** — 已完成在知识库页内打开左侧编辑器并按引用内容/行号定位高亮，文件页可复用同一套来源定位状态。
3. **TOC 交互** — 已完成点击跳转与滚动联动高亮。
4. **单索引问答成本护栏** — 已完成澄清直返、条件改写/重排、helper 缓存、回答模式 meta 和知识库回归测试。

### P2 已完成：创作画布闭环

1. **画布保存为 Markdown** — 已完成新主题保存、文件树刷新与自动索引。
2. **事实补充 / 风格来源链路** — 已完成后台事实补充、风格样本过滤，以及当前文档优先参与大纲与改写。
3. **大纲生成增强** — 已完成 LLM 大纲生成，保留降级。
4. **块拖拽排序** — 已完成 dnd-kit 拖拽排序。

### P3 待完成：体验与部署

1. **完整 CommandPalette** — 从文章搜索弹层扩展为命令面板。
2. **真实登录/OIDC** — 替换当前演示登录逻辑。
3. **多模态向量实测** — 用真实阿里 / 豆包 / 自定义兼容接口验证图片向量请求体。
4. **懒猫实机验证** — `sqlite-vec` aarch64 预编译、`lzc-cli project build`、`.lpk` 安装与部署联调。

---

## 已知技术风险

| 风险项 | 说明 | 应对 |
|--------|------|------|
| sqlite-vec aarch64 兼容性 | Lazycat 可能是 ARM，sqlite-vec 需要对应预编译 .so | 提前找 aarch64 build 或从源码编译 |
| jieba-wasm 在 Next.js API Route 的加载时机 | WASM 初始化耗时，首次请求慢 | 在 `lib/db.js` 初始化时预热 |
| 中文分词回退效果 | `jieba-wasm` 初始化失败时只能走简化分词（单字 / 双字 gram） | 仍可检索，但中文召回率和排序会下降 |
| chokidar 在容器内 polling 性能 | 3000ms 轮询在大量文件时 CPU 偏高 | 文件数 < 10k 可接受，极端情况考虑 inotify |
| Node / Next 构建环境不一致 | 若误用 Node 23，Next 15 可能生成异常 `.next` 产物 | 已固定 Node 20.19.x，并补 `.nvmrc` + `engines.node` |
