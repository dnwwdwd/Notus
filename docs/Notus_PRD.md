# Notus 产品需求文档（PRD）

> v3.0 · 更新时间：2026-07-14

## 1. 技术约束

- Next.js 15 Pages Router、React 19、纯 JavaScript、npm。
- 样式使用 CSS token；交互组件使用 `@radix-ui/*`。
- 富文本编辑器为 Tiptap，必须通过 `dynamic(..., { ssr: false })` 加载。
- 数据层使用 `better-sqlite3 + sqlite-vec + FTS5`；文件监听固定 `chokidar` polling，间隔 3000ms。
- 运行平台差异经 `lib/platform/` 处理，业务组件不直接判断 Electron、懒猫或系统路径。

## 2. 路由与页面

| 路由 | 实现 | 说明 |
|---|---|---|
| `/files` | `pages/files/index.js` | 唯一主工作区 |
| `/knowledge` | `pages/knowledge.js` | `getServerSideProps` 临时跳转 `/files` |
| `/canvas` | `pages/canvas.js` | `getServerSideProps` 临时跳转 `/files` |
| `/settings/[section]` | 设置页面 | 保留模型、搜索、个性化、图床等配置 |

`TopBar` 不再渲染产品页面 tab。文件搜索固定跳转 `/files?fileId=<id>`，搜索 icon 的 tooltip 固定为“搜索文件”。

## 3. 文件工作区实现

### 3.1 组件组成

```text
Shell
├── TopBar
│   ├── 文档保存状态
│   ├── 全局文件搜索
│   ├── 富文本编辑器开关
│   ├── AI 面板开关
│   └── 设置
├── Sidebar
└── FilesPage
    ├── EditorToolbar + WysiwygEditor
    └── FileAgentWorkspace
```

`FilesPage` 同时维护编辑器内容和 AI 工作台。两个面板都展开时使用 `ResizableLayout`；左栏宽度约束为 38%～70%，并保证编辑器至少 560px、AI 面板至少 456px。

### 3.2 面板状态

- `notus-files-workspace-panels`：保存 `editorOpen` 与 `agentOpen`。
- `notus-files-workspace-layout`：保存 `editorWidthPercent` 与 `agentWidthPercent` 两个双栏宽度百分比；读取时兼容旧版单一左栏百分比。
- `GET /api/settings` 的 `editor.default_editor_open`、`editor.default_agent_open` 为从无文件状态打开文件时的默认值。
- `PUT /api/settings` 支持保存这两个字段，数据库设置键分别为 `editor_default_open` 和 `editor_default_agent_open`。
- 用户手动开关或切换已打开文件不会回读默认值。侧边栏再次点击当前文件会清空 `activeFileId` 和当前文件，并移除 `/files?fileId=...` 路由状态；编辑器显示未选择文件空态，AI 面板保持当前状态。
- `ResizableLayout` 初始化使用本地存储的编辑器宽度，拖动提交时同步保存编辑器与 AI 面板宽度。
- `TopBar` 的编辑器和 AI 面板开关复用 32px 图标按钮；默认快捷键分别为 `Mod+B` 和 `Mod+U`，命中时调用对应开关并阻止浏览器默认行为。

### 3.3 编辑器和复制

- `FilesPage` 将文件可见 Markdown 拆为独立标题和正文：标题输入区读写 Markdown 一级标题，`WysiwygEditor` 只接收正文；保存时再合并标题、正文和隐藏的系统 Frontmatter。
- `splitEditorVisibleMarkdown()` 隐藏仅由 Notus 维护的 `id / created_by / title` Frontmatter 组合；含其他用户属性的 Frontmatter 保持可见，避免误删用户数据。
- Agent 可能写入文件时，文件页清除当前文件缓存、刷新文件树并重新加载编辑器内容。
- 发送 Agent 任务前，若当前编辑器为 dirty，先调用文件保存接口。
- `copyEditorContentToClipboard` 仅调用 `navigator.clipboard.writeText` 或 `execCommand('copy')` 写入 Markdown 源文本；不再生成带 data URL 图片的 HTML ClipboardItem。
- 编辑器粘贴和工具栏选图继续调用 `POST /api/files/:id/images`。本地模式返回相对资源路径；对象存储模式返回公开 URL，前端不感知云厂商 SDK 或密钥。
- 工具栏提供“插入表格”入口。弹窗接收 1～20 行和 1～20 列，调用 Tiptap `insertTable({ rows, cols, withHeaderRow: true })`，表格继续由 Markdown 双向转换链路读写。
- AI 输入框默认保持 5 行文字高度，输入容器宽度固定为父容器的 95%；聊天滚动容器使用足以避开输入区的底部 padding，确保 AI 消息的复制和重试操作可见、可点击。
- 回底按钮使用独立于输入框的上方偏移，默认 5 行输入区下不与输入框重叠。完成态 assistant message 不携带或渲染工具步骤；运行态流式消息仍显示工具进度。

### 3.4 图片对象存储

- `GET /api/settings` 返回 `images.storage_mode` 与脱敏的 `images.object_storage` 配置；只返回 Access Key、Secret 是否已保存。
- `PUT /api/settings` 支持 `local | object_storage`、COS/OSS/R2 的连接字段和显式清除密钥字段。对象存储模式必须通过配置完整性校验后才保存。
- `SettingsScreen` 的 `image-storage` section 使用本地、COS、OSS、R2 四个选项直接驱动图片存储模式和 provider；个性化 section 不渲染图床字段。
- `lib/objectStorage.js` 统一生成对象键、公开 URL 和错误码；COS 用 `cos-nodejs-sdk-v5`，OSS 用 `ali-oss`，R2 用 `@aws-sdk/client-s3`。
- 云对象键为 `<prefix>/<YYYY>/<MM>/<sha256>.<ext>`，上传携带图片 MIME 类型与 `Cache-Control: public, max-age=31536000, immutable`。
- `/api/files/:id/images` 在 `formidable` 校验后选择本地写入或云端上传。云端上传失败返回错误，临时文件在成功和失败路径均删除，不回退本地。
- `ImagePreviewOverlay` 通过 React portal 挂载到 `document.body`，使用高于顶栏的覆盖层级，避免工作区局部堆叠上下文遮挡预览控件。

## 4. AI Agent 工作台

### 4.1 前端

`components/AgentWorkspace/FileAgentWorkspace.js` 复用：

- `AgentWorkspace` 消息、流式输出、工具步骤、附件、diff、消息复制/改写/重试。
- `ConversationDrawer` 历史读取、删除、导出和日志入口。
- `ClarifyDrawer` 提问卡片。
- `useAgentLoopController` 处理 SSE、session、预览应用和回滚。

会话沿用 `kind=canvas` 数据格式，以便读取旧 Agent 会话、操作预览和附件记录。该值是存储兼容层，不代表存在创作页面。

AI 面板顶栏只保留历史和新建对话操作，不显示左侧品牌 icon 或“Notus Agent”标题。无消息空态只显示“你今天在想些什么？”。

`AgentInput` 在通过发送前置校验后立即清空文本；流式任务异常时，`useAgentLoopController` 将现有 session 标记为 `failed` 并结束 loading，`FileAgentWorkspace` 不再因过期的 `running` 状态持续禁用输入。`ClarifyDrawer` 的上一题、下一题使用带 `aria-label` 的箭头 icon；答题阶段且焦点不在文本输入控件时，ArrowLeft/ArrowRight 分别切换前后题，前进仍要求当前题已回答。

### 4.2 新任务请求

文件工作区发起 `/api/agent/loop/start` 时传递：

```json
{
  "goal": "用户任务：<用户原文>",
  "user_query": "<用户原文>",
  "display_query": "<用户原文>",
  "kind": "canvas",
  "authorized_paths": [""],
  "authorized_ops": ["modify", "create"]
}
```

请求不传 `active_file_id`，`goal` 不包含当前文件名、当前路径或画布块快照。`authorized_paths: ['']` 表示 Agent 的非删除写入可覆盖工作区根目录。

### 4.3 Agent Prompt 和工具

系统 Prompt 约束：

- `@{relative/path.md}` 为明确 Mention 文件；使用文件正文前调用 `read_file`。
- 未 Mention 文件时，不假定当前 UI 打开的文件是任务目标。
- 任务明确需要定位文件、目录或材料时，模型可自行使用 `analyze_folder`、`search_knowledge`、`read_file`；普通聊天无需调用这些工具。
- 文件系统任务先使用 `analyze_folder` 获取实时目录结构。
- 当前可注册工具不包含 `preview_canvas_blocks`。

`agentTools.buildToolDefinitions()` 只向模型提供文件、检索、预览、目录、提问卡片和联网工具。旧画布块预览执行代码不再注册为工具，也不会通过前端入口调用。

## 5. 文件 Mention

### 5.1 候选数据

前端从 `AppContext.allFiles` 生成：

```js
{
  value: file.id,
  token: '@{folder/note.md}',
  label: '文件标题或文件名',
  preview: 'folder/note.md',
  searchText: '标题 文件名 路径'
}
```

### 5.2 输入规则

- 输入 `@` 后显示候选。
- 支持未闭合 `@{...` 和普通 `@keyword` 两种检索状态。
- 匹配对 `token / label / preview / searchText` 做不区分大小写的包含匹配。
- 支持 ArrowUp、ArrowDown、Enter、Esc 和中文输入法组合态。
- 选中后插入完整 `@{相对路径}`，路径中可以包含空格。

## 6. API 与数据边界

- API Route 先调用 `ensureRuntime()`。
- 数据库统一经 `getDb()` 访问。
- `/api/files/:id` 读取和保存 Markdown；保存后增量索引。
- `/api/files/:id/images` 处理本地资源或对象存储图片上传；云端 URL 保持为 Markdown 原值，现有远程图片缓存与索引按需读取。
- `/api/conversations` 与 `/api/conversations/:id` 负责 Agent 历史、操作预览和附件恢复。
- `/api/agent/loop/start`、`/api/agent/loop/apply`、`/api/interactions/:id/respond` 负责 Agent Loop、预览和提问卡片续跑。
- SSE 格式维持 `data: JSON\n\n`。

## 7. 兼容与不再使用的链路

- `/api/chat`、知识库检索、风格画像、旧画布解析与块操作数据继续保留，供历史会话、索引和后续迁移使用。
- `/knowledge`、`/canvas` 页面代码不再承担 UI 状态和输入逻辑。
- 新功能不再引用画布 Block、`@bN` 或“当前文章”隐式上下文。

## 8. 验收与验证

1. `npm run lint:web` 通过。
2. `npm run build:web` 通过。
3. 无文件状态下可以打开 AI 面板、发送 Agent 任务、创建或检索工作区文件。
4. 有文件状态下编辑器和 AI 面板可拖拽分栏，用户切换文件后面板状态保持。
5. Mention 面板能匹配文件名和路径；Agent 对 Mention 文件按需读取内容。
6. `preview_canvas_blocks` 不出现在 Agent 工具定义或工具步骤中。
