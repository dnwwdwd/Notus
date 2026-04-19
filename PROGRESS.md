# Notus 项目进度

> 最后更新：2026-04-19
> 对应文档版本：PDD v2.0 / PRD v2.1 / UI Guide v1.0

---

## 总体状态

| 阶段 | 说明 | 状态 |
|------|------|------|
| 前端 UI（完整交互） | 所有页面、组件、样式 + 完整前端交互逻辑 | ✅ 完成 |
| 后端核心库 | 数据库、运行时、索引、检索、Agent、设置 | ✅ 核心链路完成 |
| 真实后端接口 | 接入真实文件系统 + SQLite + SSE + LLM / Embedding | ✅ 已切到真实后端，批量导入/导出、图片代理与图片向量检索已补齐 |
| 懒猫微服部署 | manifest / build / run 脚本 | ✅ 完成（未验证打包） |

---

## M1 基础骨架

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M1-01 项目初始化 + CSS Token 系统 | `notus/package.json` `notus/next.config.js` `styles/globals.css` | ✅ | 含 light/dark 双主题，所有设计 token |
| M1-02 `lib/db.js` SQLite + sqlite-vec 初始化 | `lib/db.js` | ✅ | 已补齐 `files/chunks/chunks_vec/chunks_fts/images/conversations/messages/settings`、FTS5 触发器与运行时设置读写 |
| M1-03 `lib/indexer.js` 分块 + 索引 | `lib/indexer.js` | ✅ | 已改为 AST 分块；Embedding 失败时保留 FTS 检索并标记待重试 |
| M1-04 `lib/embeddings.js` | `lib/embeddings.js` | ⚠️ 部分 | 已接真实文本 / 多模态 Embedding API；图片向量支持已补，仍需用真实 API Key 做多提供商实测 |
| M1-05 `lib/watcher.js` chokidar | `lib/watcher.js` | ✅ | 已接入运行时初始化，监听 `add/change/unlink` 并触发索引 |
| M1-06 env.local.example + _app.js + globals.css | `.env.local.example` `pages/_app.js` | ✅ | |

---

## M2 文件管理 & 编辑器

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M2-01 App Shell（TopBar + Sidebar + Shell） | `components/Layout/` | ✅ | |
| M2-02 FileTree 组件（前端交互） | `components/Layout/Sidebar.js` `contexts/AppContext.js` `pages/api/files/` | ✅ | 已接真实文件系统与 SQLite，保留原有树结构和交互 |
| M2-03 WYSIWYG Markdown 编辑器 | `components/Editor/WysiwygEditor.js` `components/Editor/EditorToolbar.js` | ✅ | Tiptap + Markdown 双向转换；支持标题、链接、加粗、斜体、下划线、列表、任务列表、引用、代码块、分隔线、图片；代码块已接入 lowlight 语法高亮与语言选择 |
| M2-04 MarkdownRenderer | `components/Editor/MarkdownPreview.js` | ✅ | remark-gfm，待接入 rehype-katex |
| M2-05 TocTree | `components/Layout/Sidebar.js` `pages/files/index.js` | ✅ | TOC 从 markdown heading 正则提取并渲染；滚动联动高亮**未实现** |
| M2-06 URL hash 来源跳转 + 高亮淡出 | — | ❌ | 未实现 |
| M2-07 批量导入/导出 + SSE 进度 | `pages/api/files/` `components/Layout/Sidebar.js` | ✅ | 已完成 `/api/files/import` `/api/files/export`，侧边栏已接导入 `.md` 与多选导出入口 |
| M2-08 `/indexing` 页面 | `pages/indexing.js` | ⚠️ 部分 | 页面仍是示意数据；底层 `/api/index/status` `/api/index/rebuild` 已接真实后端 |

---

## M3 知识库问答

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M3-01 `lib/retrieval.js` hybridSearch 七步 | `lib/retrieval.js` | ✅ | 已实现文本向量召回 + `search_text` FTS + RRF + 图片向量召回 + 降级来源标记 |
| M3-02 jieba-wasm 集成 + FTS 分词 | `lib/tokenizer.js` | ✅ | 已改为应用层分词，不再依赖 SQLite 自定义 tokenizer |
| M3-03 `lib/prompt.js` 知识库 Prompt | `lib/prompt.js` | ✅ | 含 RAG QA / Agent / Draft / Polish 四套模板 |
| M3-04 `/api/chat` SSE 流式 | `pages/api/chat.js` | ✅ | 已接真实检索、对话存储与 LLM 流式输出 |
| M3-05 ChatArea + SourceCard 组件 | `components/ChatArea/` `components/ui/SourceCard.js` | ✅ | 知识库页已支持“无文件时仅问答，选中文件后显示左侧编辑器”的分屏模式 |
| M3-06 多模型切换 Select | `components/ChatArea/InputBar.js` | ✅ | UI 与 `/api/chat` 的 `model` 参数已打通；模型选择框在底部输入栏改为上拉展开 |
| M3-07 知识库参考来源手动指定 | `pages/knowledge.js` | ⚠️ 部分 | 已切到真实 `/api/chat` SSE；手动来源选择 UI 保留，后端暂未按 file id 过滤检索 |

---

## M4 AI 创作画布

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M4-01 `lib/diff.js` str_replace 引擎 | `lib/diff.js` | ✅ | 已支持 `replace/insert/delete`，返回 `BLOCK_NOT_FOUND` / `OLD_MISMATCH` |
| M4-02 `/api/articles/parse` + `/api/articles/save` | `pages/api/articles/` `utils/markdownBlocks.js` | ✅ | 已接本地 Markdown 文章解析与保存，不再走网页抓取 |
| M4-03 `lib/agent.js` 9 个工具 + runAgent | `lib/agent.js` | ✅ | 已接 Chat Completions 风格工具调用循环 |
| M4-04 意图识别 `/api/agent/intent` | `pages/api/agent/intent.js` | ✅ | 已接真实 LLM，失败时回退到规则判断 |
| M4-05 大纲生成 `/api/agent/outline` SSE | `pages/api/agent/outline.js` | ⚠️ 部分 | 已接真实 SSE 与检索增强模板；当前仍不是完整 LLM 大纲生成 |
| M4-06 Agent 运行 `/api/agent/run` SSE | `pages/api/agent/run.js` | ✅ | 已接真实 Agent，输出 `thinking/tool_call/tool_result/operation/done` |
| M4-07 CanvasBlock 组件 | `components/Canvas/CanvasBlock.js` `pages/canvas.js` | ✅ | 6 状态完整；双击进入 textarea 内联编辑；快捷键提示已从界面隐藏，配置移入设置页 |
| M4-08 AIPanel + OperationPreview | `components/AIPanel/OperationPreview.js` `pages/canvas.js` | ✅ | diff 展示 + apply/cancel 逻辑 |
| M4-09 新建创作入口页 | `pages/canvas.js` CanvasEntry | ✅ | 话题输入 + 最近列表全部可点击，"从空白开始"按钮可用；侧边栏选中文件后会在当前页基于该文章进入创作 |
| M4-10 编辑器"AI 创作"按钮 | `components/Editor/EditorToolbar.js` | ✅ | 点击跳转 /canvas |
| M4-11 图片延迟处理后台任务 | `lib/images.js` `pages/api/files/[id]/content-image.js` | ✅ | 已实现远程图片缓存代理、失败降级外链、图片向量写入与重试不阻塞文本索引 |

---

## M5 体验打磨 & 部署

| 子任务 | 文件 | 状态 | 备注 |
|--------|------|------|------|
| M5-01 设置页（模型/存储/关于） | `pages/settings/[section].js` `components/Settings/SettingsScreen.js` | ✅ | 已拆为独立路径；Embedding 配置增加多模态开关与提示，外观项已移除 |
| M5-02 CommandPalette（cmdk） | `components/Layout/TopBar.js` | ⚠️ 部分 | 已提供全局文章搜索弹层和 ⌘K 快捷键；空输入时不再展示文章；完整命令面板仍未实现 |
| M5-03 快捷键绑定 | `contexts/ShortcutsContext.js` `components/Editor/WysiwygEditor.js` `components/Layout/TopBar.js` `components/ChatArea/InputBar.js` `components/Canvas/CanvasBlock.js` | ✅ | 常用快捷键已集中到 `/settings/shortcuts` 维护，并接入搜索、发送、保存文档、保存块编辑、取消块编辑 |
| M5-04 Toast 全局错误降级 | `components/ui/Toast.js` | ✅ | |
| M5-05 主题样式基础 | `styles/globals.css` | ✅ | 保留亮/暗色 token 结构，但当前设置页不再暴露外观配置 |
| M5-06 `/setup` 三步引导 | `pages/setup.js` | ⚠️ 部分 | Step 1 已接真实设置读取 / 保存，并增加多模态开关；目录选择与索引进度仍是示意 UI |
| M5-07 404 / 错误页 | `pages/404.js` `pages/error.js` | ✅ | |
| M5-08 懒猫打包 | `lzc-manifest.yml` `lzc-build.yml` `lzc/` | ✅ | 脚本已写，**实机打包未验证** |
| M5-09 sqlite-vec 双平台预编译验证 | — | ❌ | x86_64 + aarch64 (Lazycat) 均需验证 |
| M5-10 健康检查 + 启动延迟调优 | `pages/api/health.js` | ✅ | 已接运行时初始化、sqlite-vec 状态与目录检查 |

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

### 尚未实现

- 本轮计划内的核心后端接口已补齐。
- 仍待补的主要是 `/indexing` 页面接真实进度、`agent/outline` 进一步增强，以及懒猫实机打包验证。

---

## 后续实现优先级

1. **`/indexing` 页面接真实进度** — 页面改为消费 `/api/index/status` 与 `/api/index/rebuild` SSE
2. **大纲生成增强** — `agent/outline` 从检索增强模板升级为完整 LLM 大纲
3. **多模态向量实测** — 用真实阿里 / 豆包 / 自定义兼容接口验证图片向量请求体
4. **懒猫实机验证** — `sqlite-vec` aarch64 预编译、`.lpk` 打包与部署联调

---

## 已知技术风险

| 风险项 | 说明 | 应对 |
|--------|------|------|
| sqlite-vec aarch64 兼容性 | Lazycat 可能是 ARM，sqlite-vec 需要对应预编译 .so | 提前找 aarch64 build 或从源码编译 |
| jieba-wasm 在 Next.js API Route 的加载时机 | WASM 初始化耗时，首次请求慢 | 在 `lib/db.js` 初始化时预热 |
| 中文分词回退效果 | `jieba-wasm` 初始化失败时只能走简化分词（单字 / 双字 gram） | 仍可检索，但中文召回率和排序会下降 |
| chokidar 在容器内 polling 性能 | 3000ms 轮询在大量文件时 CPU 偏高 | 文件数 < 10k 可接受，极端情况考虑 inotify |
| Node / Next 构建环境不一致 | 若误用 Node 23，Next 15 可能生成异常 `.next` 产物 | 已固定 Node 20.19.x，并补 `.nvmrc` + `engines.node` |
