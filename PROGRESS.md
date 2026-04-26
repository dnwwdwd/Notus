# Notus 项目进度

> 最后更新：2026-04-25
> 对应文档版本：PDD v2.0 / PRD v2.1 / UI Guide v1.0

---

## 总体状态

| 阶段 | 说明 | 状态 |
|------|------|------|
| 前端 UI（完整交互） | 所有页面、组件、样式 + 完整前端交互逻辑 | ✅ 完成 |
| 后端核心库 | 数据库、运行时、索引、检索、Agent、设置 | ✅ 核心链路完成 |
| 真实后端接口 | 接入真实文件系统 + SQLite + SSE + LLM / Embedding | ✅ 已切到真实后端，批量导入/导出、图片代理与图片向量检索已补齐 |
| 可观测性 | 结构化日志 + 请求 ID + 日志查询接口 + 设置页日志查看 | ✅ 已完成 |
| 懒猫微服部署 | manifest / build / run 脚本 | ✅ 完成（未验证打包） |

---

## M1 基础骨架

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M1-01 项目初始化 + CSS Token 系统 | `notus/package.json` `notus/next.config.js` `styles/globals.css` | ✅ | 含 light/dark 双主题，所有设计 token |
| M1-02 `lib/db.js` SQLite + sqlite-vec 初始化 | `lib/db.js` | ✅ | 已补齐 `files/chunks/chunks_vec/chunks_fts/images/conversations/messages/settings`、FTS5 触发器与运行时设置读写 |
| M1-03 `lib/indexer.js` 分块 + 索引 | `lib/indexer.js` | ✅ | 已改为 AST 分块；Embedding 失败时保留 FTS 检索并标记待重试 |
| M1-04 `lib/embeddings.js` | `lib/embeddings.js` | ⚠️ 部分 | 已接真实文本 / 多模态 Embedding API；图片向量支持已补；设置页与引导页已添加厂商选择器（千问/豆包/OpenAI/自定义），选中厂商后自动填充默认 Base URL 与模型列表；仍需用真实 API Key 做多提供商实测 |
| M1-05 `lib/watcher.js` chokidar | `lib/watcher.js` | ✅ | 已接入运行时初始化，监听 `add/change/unlink` 并触发索引 |
| M1-06 env.local.example + _app.js + globals.css | `.env.local.example` `pages/_app.js` | ✅ | |

---

## M2 文件管理 & 编辑器

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M2-01 App Shell（TopBar + Sidebar + Shell） | `components/Layout/` | ✅ | |
| M2-02 FileTree 组件（前端交互） | `components/Layout/Sidebar.js` `contexts/AppContext.js` `pages/api/files/` | ✅ | 已接真实文件系统与 SQLite；新建文件无需输入 `.md` 后缀，索引告警不再阻断文件创建；搜索已加 `useDeferredValue` 防抖；已添加右键上下文菜单（重命名/删除） |
| M2-03 WYSIWYG Markdown 编辑器 | `components/Editor/WysiwygEditor.js` `components/Editor/EditorToolbar.js` | ✅ | Tiptap + Markdown 双向转换；支持标题、链接、加粗、斜体、下划线、列表、任务列表、引用、代码块、分隔线、图片；代码块已接入 lowlight 语法高亮与语言选择；工具栏底部添加橙色脉冲条以指示未保存状态 |
| M2-04 MarkdownRenderer | `components/Editor/MarkdownPreview.js` | ✅ | remark-gfm，待接入 rehype-katex |
| M2-05 TocTree | `components/Layout/Sidebar.js` `pages/files/index.js` | ✅ | TOC 从 markdown heading 提取并渲染；已支持点击跳转与滚动联动高亮 |
| M2-06 URL hash 来源跳转 + 高亮淡出 | `pages/files/index.js` `components/ui/SourceCard.js` | ✅ | 来源卡片已支持按 fileId + lineStart/lineEnd 跳转并高亮淡出；已补充 `#L24-L28` hash 格式解析（mount 时读 `window.location.hash`，清理后注入现有滚动流程）与 Tiptap 光标定位（`posAtDOM` + `setTextSelection`） |
| M2-07 批量导入/导出 + SSE 进度 | `pages/api/files/` `components/Layout/Sidebar.js` | ✅ | 已完成 `/api/files/import` `/api/files/export`；导入支持 50MB 请求体、保存/索引阶段进度、逐文件告警与请求 ID |
| M2-08 `/indexing` 页面 | `pages/indexing.js` | ✅ | 已接 `/api/index/status` 与 `/api/index/rebuild` SSE，支持真实进度、当前文件、失败项与重新构建；顶部已常驻显示"已索引 N / 总数"统计与失败数警示 |

---

## M3 知识库问答

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M3-01 `lib/retrieval.js` hybridSearch 七步 | `lib/retrieval.js` | ✅ | 已实现文本向量召回 + `search_text` FTS + RRF + 图片向量召回 + 降级来源标记 |
| M3-02 jieba-wasm 集成 + FTS 分词 | `lib/tokenizer.js` | ✅ | 已改为应用层分词，不再依赖 SQLite 自定义 tokenizer |
| M3-03 `lib/prompt.js` 知识库 Prompt | `lib/prompt.js` | ✅ | 含 RAG QA / Agent / Draft / Polish 四套模板 |
| M3-04 `/api/chat` SSE 流式 | `pages/api/chat.js` | ✅ | 已接真实检索、对话存储与 LLM 流式输出 |
| M3-05 ChatArea + SourceCard 组件 | `components/ChatArea/` `components/ui/SourceCard.js` | ✅ | 知识库页已支持”无文件时仅问答，选中文件后显示左侧编辑器”的分屏模式；已添加无命中上下文提示（AI 气泡底部淡色注释）、停止生成 Toast 反馈、LLM 未配置内联 Banner（含”前往设置”跳转按钮） |
| M3-06 多模型切换 Select | `components/ChatArea/InputBar.js` | ✅ | UI 与 `/api/chat` 的 `model` 参数已打通；模型选择框在底部输入栏改为上拉展开 |
| M3-07 知识库参考来源手动指定 | `pages/knowledge.js` `pages/api/chat.js` `lib/retrieval.js` | ✅ | 前端选择与后端 file id 过滤已打通，来源卡片可跳转到文件页定位 |

---

## M4 AI 创作画布

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M4-01 `lib/diff.js` str_replace 引擎 | `lib/diff.js` | ✅ | 已支持 `replace/insert/delete`，返回 `BLOCK_NOT_FOUND` / `OLD_MISMATCH` |
| M4-02 `/api/articles/parse` + `/api/articles/save` | `pages/api/articles/` `utils/markdownBlocks.js` | ✅ | 已接本地 Markdown 文章解析与保存，不再走网页抓取 |
| M4-03 `lib/agent.js` 9 个工具 + runAgent | `lib/agent.js` | ✅ | 已接 Chat Completions 风格工具调用循环 |
| M4-04 意图识别 `/api/agent/intent` | `pages/api/agent/intent.js` | ✅ | 已接真实 LLM，失败时回退到规则判断 |
| M4-05 大纲生成 `/api/agent/outline` SSE | `pages/api/agent/outline.js` `lib/prompt.js` | ✅ | 已接 LLM 大纲生成，保留检索增强与固定模板降级 |
| M4-06 Agent 运行 `/api/agent/run` SSE | `pages/api/agent/run.js` | ✅ | 已接真实 Agent，输出 `thinking/tool_call/tool_result/operation/done` |
| M4-07 CanvasBlock 组件 | `components/Canvas/CanvasBlock.js` `pages/canvas.js` | ✅ | 6 状态完整；双击进入 textarea 内联编辑；已接 dnd-kit 拖拽排序；快捷键提示已从界面隐藏，配置移入设置页；已添加 30s 自动保存（dirty 状态下计时，保存中/保存成功时重置） |
| M4-08 AIPanel + OperationPreview | `components/AIPanel/OperationPreview.js` `pages/canvas.js` | ✅ | diff 展示 + apply/cancel 逻辑 |
| M4-09 新建创作入口页 | `pages/canvas.js` CanvasEntry | ✅ | 话题输入 + 最近列表全部可点击，"从空白开始"按钮可用；侧边栏选中文件后会在当前页基于该文章进入创作；新主题内容可保存为 Markdown 并索引 |
| M4-10 编辑器"AI 创作"按钮 | `components/Editor/EditorToolbar.js` | ✅ | 点击跳转 /canvas |
| M4-11 图片延迟处理后台任务 | `lib/images.js` `pages/api/files/[id]/content-image.js` | ✅ | 已实现远程图片缓存代理、失败降级外链、图片向量写入与重试不阻塞文本索引 |

---

## M5 体验打磨 & 部署

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M5-01 设置页（模型/存储/日志/关于） | `pages/settings/[section].js` `components/Settings/SettingsScreen.js` | ✅ | 模型配置支持远端 `/api/models` 获取、内置回退与手动输入；存储页已接真实重建/清除索引；日志页可查询服务端 JSONL 日志；Embedding 配置新增厂商 pill 选择器（千问/豆包/OpenAI/自定义），选中后自动填充 Base URL 与默认模型下拉 |
| M5-02 CommandPalette（cmdk） | `components/Layout/TopBar.js` | ⚠️ 部分 | 已提供全局文章搜索弹层和 ⌘K 快捷键；空输入时不再展示文章；完整命令面板仍未实现 |
| M5-03 快捷键绑定 | `contexts/ShortcutsContext.js` `components/Editor/WysiwygEditor.js` `components/Layout/TopBar.js` `components/ChatArea/InputBar.js` `components/Canvas/CanvasBlock.js` | ✅ | 常用快捷键已集中到 `/settings/shortcuts` 维护，并接入搜索、发送、保存文档、保存块编辑、取消块编辑 |
| M5-04 Toast 全局错误降级 | `components/ui/Toast.js` `lib/errors.js` | ✅ | `lib/errors.js` 已补充 `HTTP_ERROR_MESSAGES` 映射表（400/401/403/429/500/502/503）与 `httpErrorMessage()` 工具函数，供所有 API 路由与前端错误分支调用 |
| M5-05 主题样式基础 | `styles/globals.css` | ✅ | 保留亮/暗色 token 结构，但当前设置页不再暴露外观配置 |
| M5-06 `/setup` 三步引导 | `pages/setup.js` `contexts/AppStatusContext.js` | ✅ | Step 1 支持模型获取、内置回退与手动输入；Step 2 支持真实 Markdown 文件/目录导入；Step 3 已接真实导入、索引进度与告警展示；入口守卫已接入 |
| M5-07 404 / 错误页 | `pages/404.js` `pages/error.js` | ✅ | |
| M5-08 懒猫打包 | `lzc-manifest.yml` `lzc-build.yml` `lzc/` | ✅ | 脚本已写并修正运行目录，**实机打包未验证** |
| M5-09 sqlite-vec 双平台预编译验证 | — | ❌ | x86_64 + aarch64 (Lazycat) 均需验证 |
| M5-10 健康检查 + 启动延迟调优 | `pages/api/health.js` | ✅ | 已接运行时初始化、sqlite-vec 状态与目录检查 |
| M5-11 可观测日志系统 | `lib/logger.js` `pages/api/logs.js` `components/Settings/SettingsScreen.js` | ✅ | JSONL 落盘、`x-request-id`、日志查询 API、设置页日志查看；核心导入/索引/模型/设置链路已接入 |

---

## API 接口完成度

## 当前需求口径

- 知识库页以问答为主；未选中文件时不显示文章编辑器。
- 知识库页和创作页都支持手动指定参考来源，但目前只是前端交互层完成。
- 创作页点击侧边栏文件时，保持在 `/canvas`，并基于对应文章进入创作。
- 创作页文章分块已从按文本规则切分改为基于 remark AST 的结构化分块，列表、引用、代码块会尽量保持整体。
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
| `/api/agent/intent` | POST | ✅ |
| `/api/agent/outline` | POST SSE | ✅ |
| `/api/agent/run` | POST SSE | ✅ |
| `/api/agent/apply` | POST | ✅ |
| `/api/articles/:id` | GET | ✅ |
| `/api/articles/parse` | POST | ✅ |
| `/api/articles/save` | POST | ✅ |
| `/api/conversations` | GET / POST | ✅ |
| `/api/conversations/:id` | GET / DELETE | ✅ |
| `/api/settings` | GET / PUT | ✅ |
| `/api/settings/test` | POST | ✅ |

### 尚未实现 / 待验证

- 完整 CommandPalette（cmdk 命令面板）仍未实现；当前是全局文章搜索弹层。
- 登录页仍是演示跳转，尚未接真实 Lazycat/OIDC 认证。
- sqlite-vec x86_64 / aarch64 与 `.lpk` 实机打包部署仍待验证。

---

## 后续实现优先级

### P0 已完成：核心可用性闭环

1. **`/setup` 三步引导接真实流程** — 已完成真实导入、索引进度与入口守卫。
2. **`/indexing` 页面接真实进度** — 已完成状态统计、SSE 重建进度、当前文件与失败项展示。
3. **设置页索引维护** — 已完成真实重建与清除索引。

### P1 已完成：知识库主链路补全

1. **手动参考来源过滤** — 已完成 `/api/chat` + `hybridSearch(fileIds)` 后端过滤。
2. **来源卡片跳转** — 已完成从来源卡片跳转文件页并按引用内容/行号高亮。
3. **TOC 交互** — 已完成点击跳转与滚动联动高亮。

### P2 已完成：创作画布闭环

1. **画布保存为 Markdown** — 已完成新主题保存、文件树刷新与自动索引。
2. **手动风格来源过滤** — 已完成 Agent 风格样本按 file id 过滤。
3. **大纲生成增强** — 已完成 LLM 大纲生成，保留降级。
4. **块拖拽排序** — 已完成 dnd-kit 拖拽排序。

### P3 待完成：体验与部署

1. **完整 CommandPalette** — 从文章搜索弹层扩展为命令面板。
2. **真实登录/OIDC** — 替换当前演示登录逻辑。
3. **多模态向量实测** — 用真实阿里 / 豆包 / 自定义兼容接口验证图片向量请求体。
4. **懒猫实机验证** — `sqlite-vec` aarch64 预编译、`.lpk` 打包与部署联调。

---

## 已知技术风险

| 风险项 | 说明 | 应对 |
|--------|------|------|
| sqlite-vec aarch64 兼容性 | Lazycat 可能是 ARM，sqlite-vec 需要对应预编译 .so | 提前找 aarch64 build 或从源码编译 |
| jieba-wasm 在 Next.js API Route 的加载时机 | WASM 初始化耗时，首次请求慢 | 在 `lib/db.js` 初始化时预热 |
| 中文分词回退效果 | `jieba-wasm` 初始化失败时只能走简化分词（单字 / 双字 gram） | 仍可检索，但中文召回率和排序会下降 |
| chokidar 在容器内 polling 性能 | 3000ms 轮询在大量文件时 CPU 偏高 | 文件数 < 10k 可接受，极端情况考虑 inotify |
| Node / Next 构建环境不一致 | 若误用 Node 23，Next 15 可能生成异常 `.next` 产物 | 已固定 Node 20.19.x，并补 `.nvmrc` + `engines.node` |
