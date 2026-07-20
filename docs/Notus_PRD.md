# Notus 产品需求文档（PRD）

> v3.1 · 更新时间：2026-07-19

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
| `/settings/[section]` | 设置兼容入口 | 显示模型、搜索、个性化、图床等设置弹窗 |

`TopBar` 不再渲染产品页面 tab。文件搜索固定跳转 `/files?fileId=<id>`，搜索 icon 的 tooltip 固定为“搜索文件”。设置由 `SettingsDialogProvider` 在当前工作区上方展示，遮罩不能关闭弹窗，仍可用关闭按钮或 Esc 退出。设置标题栏不重复显示“设置”；各 section 复用仅渲染标题名称的 `SettingsPageHeader`，并由 `SETTINGS_CONTENT_MAX_WIDTH = 860` 统一内容列最大宽度。Skill 与 MCP section 复用暖白资源卡，操作栏在窄宽度可换行；个性化页复用搜索配置的全宽设置区表面样式。

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

`FilesPage` 同时维护编辑器内容和 AI 工作台。两个面板都展开时使用 `ResizableLayout`；在宽屏中左栏宽度约束为 38%～70%，编辑器至少 560px、AI 面板至少 456px。`1200px` 以下侧栏收缩为 196px、两面板的视觉下限降为 300px；`900px` 以下改为编辑器在上、AI 面板在下的纵向布局并暂停横向拖拽；`700px` 以下侧栏改为临时抽屉，主内容为抽屉预留 40px，不覆盖正文。

### 3.2 面板状态

- `notus-files-workspace-panels`：保存 `editorOpen` 与 `agentOpen`。
- `notus-files-workspace-layout`：保存 `editorWidthPercent` 与 `agentWidthPercent` 两个双栏宽度百分比；读取时兼容旧版单一左栏百分比。
- `notus-files-active-conversation`：保存文件工作区当前有效 Agent 对话 ID。历史列表加载成功后仅在 ID 仍存在时请求详情并恢复；新建、删除当前会话、找不到记录或请求失败都会删除该值。
- `GET /api/settings` 的 `editor.default_editor_open`、`editor.default_agent_open` 为已运行工作区从无文件状态打开文件时的默认值；启动时从浏览器恢复的当前文件必须保留已保存的面板组合。
- `PUT /api/settings` 支持保存这两个字段，数据库设置键分别为 `editor_default_open` 和 `editor_default_agent_open`。
- 用户手动开关或切换已打开文件不会回读默认值。侧边栏再次点击当前文件会清空 `activeFileId` 和当前文件，并移除 `/files?fileId=...` 路由状态；编辑器显示未选择文件空态，AI 面板保持当前状态。
- `AppContext` 完成 `notus-workspace-state` 恢复后公开 `workspaceHydrated` 和启动时的 `restoredActiveFileId`。`FilesPage` 识别到该文件后跳过默认面板初始化，避免在窗口重开时把 `notus-files-workspace-panels` 覆盖为设置默认值。
- `ResizableLayout` 初始化使用本地存储的编辑器宽度，拖动提交时同步保存编辑器与 AI 面板宽度。
- `TopBar` 的编辑器和 AI 面板开关复用 32px 图标按钮；默认快捷键分别为 `Mod+B` 和 `Mod+U`，命中时调用对应开关并阻止浏览器默认行为。
- `html`、`body`、`#__next` 与 `Shell` 不再设置固定 1360px 最小宽度。桌面 `BrowserWindow` 的最小窗口调整为 `390 × 640`；共享 CSS 负责在实际视口内收缩页面，不通过外层横向滚动保留旧画布尺寸。
- 通用 `Dialog`、文档查找栏、Toast、图片预览和设置弹窗均使用视口宽高限制。设置页在 700px 以下把左侧导航改为横向可滚动栏，内容区改为单列可滚动区域；表格、代码块和 diff 保留内容区自身的横向滚动。

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

- `GET /api/settings` 返回 `images.storage_mode`、当前运行时的脱敏 `images.object_storage`，以及按 COS/OSS/R2 分别返回的 `images.provider_configs`；只返回 Access Key、Secret 是否已保存。
- `PUT /api/settings` 支持 `local | object_storage`、`active_provider` 上传位置切换、各图床的 `provider_config` 连接字段和显式清除密钥字段。切换为对象存储前必须校验目标配置完整。
- `SettingsScreen` 的 `image-storage` section 分别编辑 COS、OSS、R2 三套服务端参数；个性化 section 使用共享 `SegmentedTabs` 选择本地、COS、OSS 或 R2。未配置的云服务不会禁用，点击后切换至对应 tab 并提示前往图床配置；图床保存不改变上传位置。
- 当前上传图床的密钥不能直接清除，避免留下不完整的运行时对象存储配置；需要先在个性化页切换到本地或另一套完整配置。
- `lib/objectStorage.js` 统一生成对象键、公开 URL 和错误码；COS 用 `cos-nodejs-sdk-v5`，OSS 用 `ali-oss`，R2 用 `@aws-sdk/client-s3`。
- 云对象键为 `<prefix>/<YYYY>/<MM>/<sha256>.<ext>`，上传携带图片 MIME 类型与 `Cache-Control: public, max-age=31536000, immutable`。
- `/api/files/:id/images` 在 `formidable` 校验后选择本地写入或云端上传。云端上传失败返回错误，临时文件在成功和失败路径均删除，不回退本地。
- `components/ui/ImagePreviewOverlay` 通过 React portal 挂载到 `document.body`，使用高于顶栏的覆盖层级，避免工作区局部堆叠上下文遮挡预览控件；编辑器文档图片和 Agent 待发送图片共用该组件。

## 4. AI Agent 工作台

### 4.1 前端

`components/AgentWorkspace/FileAgentWorkspace.js` 复用：

- `AgentWorkspace` 消息、流式输出、工具步骤、附件、diff、消息复制/改写/重试。
- `ConversationDrawer` 历史读取、删除、导出和日志入口。
- `ClarifyDrawer` 提问卡片。
- `useAgentLoopController` 处理 SSE、session、预览应用和回滚。

会话沿用 `kind=canvas` 数据格式，以便读取旧 Agent 会话、操作预览和附件记录。该值是存储兼容层，不代表存在创作页面。

AI 面板顶栏只保留历史和新建对话操作，不显示左侧品牌 icon 或“Notus Agent”标题。无消息空态只显示“你今天在想些什么？”。

`AgentInput` 在通过发送前置校验后立即清空文本；流式任务异常时，`useAgentLoopController` 将现有 session 标记为 `failed` 并结束 loading，`FileAgentWorkspace` 不再因过期的 `running` 状态持续禁用输入。用户消息只在服务端发出 `session_created` SSE 事件后追加到前端，配额校验失败不会留下本地幻影消息。`ClarifyDrawer` 的上一题、下一题使用带 `aria-label` 的箭头 icon；答题阶段且焦点不在文本输入控件时，ArrowLeft/ArrowRight 分别切换前后题，前进仍要求当前题已回答。单选题选中后自动切到下一道可见题；全部可见题已回答时切换到同一 `ClarifyDrawer` 的复核列表，点击任一行可回到该题修改，提交答案不再打开独立页面或组件。

`AgentInput` 的发送条件接受普通文本、待发送图片、解析附件或 Mention 中的任一有效输入。Mention 仅用于提供显式文件和目录上下文，不能成为普通任务发送的前置条件。`contentEditable` 序列化递归读取文本节点、换行节点和 mention 节点；删除 mention 时恢复有效的文本节点、焦点和选区，确保用户可继续输入。

`AgentInput` 维护统一 `upload_order`。解析附件和图片分别上传，再按这个序号合并到用户消息和历史消息。图片 chip 显示缩略图，附件 chip 保留文件类型图标；图片不进入附件解析链路。待发送图片 chip 可打开 `ImagePreviewOverlay`，预览只包含当前上传队列的图片并按 `upload_order` 切换；移除当前预览图片或清空队列时关闭预览。

`AgentInput` 使用 `utils/agentComposerDraft.js` 将未发送草稿保存到 IndexedDB。记录包括可见文本、结构化 `segments`、Mention 元数据，以及待发送图片和解析附件的文件元数据、Blob、`media_kind` 和 `upload_order`。初始化时恢复 DOM mention 卡片和浏览器 `File` 对象，图片重新生成本地对象 URL；保存不设置过期时间。服务端发出 `session_created` SSE、确认用户消息已入库后立即清空文本、媒体队列和草稿；在此之前上传或建会失败时恢复发送前输入，后续流式任务失败不恢复已接收的媒体。

### 4.2 新任务请求

文件工作区发起 `/api/agent/loop/start` 时传递：

```json
{
  "goal": "用户任务：<用户原文>",
  "user_query": "<用户原文>",
  "display_query": "<用户原文>",
  "kind": "canvas",
  "authorized_paths": [""],
  "authorized_ops": ["modify", "create"],
  "attachments": [{ "name": "brief.pdf", "stored_name": "...", "upload_order": 1 }],
  "images": [{ "name": "screen.png", "stored_name": "...", "upload_order": 0 }]
}
```

请求不传 `active_file_id`，`goal` 不包含当前文件名、当前路径或画布块快照。`authorized_paths: ['']` 表示 Agent 的非删除写入可覆盖工作区根目录。

新 session 会额外从同一 `conversation_id` 的最近文件 operation set 推导承接目标：当本轮文本表达重写、改写、润色、修订、更新或续写，且没有明确另建文件时，向模型传入最多 3 个最近创建文件的 `file_path / operation_set_id / status`。首个目标必须先经 `read_file` 读取，并只允许使用 `preview_file_revision` 修订；本轮工具表移除 `create_note`。文件仍为未应用预览时，Agent 只能提示用户先应用，不能新建替代文件。

`lib/conversationImages.js` 统一校验和规范化媒体元数据：单条消息最多 30 张图片、10 个解析附件；同一对话分别最多 50 张图片、20 个解析附件。图片可为 PNG、JPG、JPEG、WEBP、GIF，单张临时文件最多 5MB，文件存放于 `<sessionDir>/images`。`/api/agent/images/upload` 负责接收图片，`/api/agent/images/:name` 仅向会话 UI 提供缩略图。

Agent 会话图片采用保留策略：成功上传的文件与会话消息元数据长期关联，当前没有按会话结束、交互过期、应用完成或删除会话自动清理的任务。删除 Markdown 引用、回滚笔记或写入永久图床都不会删除会话临时源文件；上传失败时产生的中间文件会立即清理。

图片只进入本轮 `runAgentLoop()` 的首条 user content。内部 block 使用 `{ type: 'image', source: { type: 'base64', media_type, data } }`：

- OpenAI Chat Completions 适配为 `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }`。
- Anthropic Messages 保持 `{ type: 'image', source: { type: 'base64', media_type, data } }`。

Anthropic 直接 Messages API 的请求体限制为 32MB。服务端将该协议的原始图片总大小收紧到 20MB，给 base64 和消息 JSON 预留空间；OpenAI 路径继续受官方单请求图片输入上限约束。`llmBudget.estimateMessagesTokens()` 不对 base64 字符串做文本 token 估算，避免把图片字节误判成海量文本。

会话图片引用格式为 `notus-conversation-image://<message-id>/<image-id>`。`lib/conversationImages.js` 从所属会话的用户消息元数据解析引用，拒绝客户端传入临时路径、未知图片 ID 和跨会话图片。`/api/agent/images/:name?conversation_id=:id` 同样按会话元数据验证后才提供临时预览文件。

历史图片不自动重发。`list_conversation_images` 返回消息、上传顺序和受控引用；`read_conversation_images({ image_refs })` 最多读取 30 张，并把选中的视觉 block 接在工具结果后。OpenAI 转换为 `tool` 结果消息后再发送新的 `user` 图片消息；Anthropic 在同一个 `user` content 中保留 `tool_result` 和图片 block。Anthropic 路径再次校验选中图片的原始文件总量不超过 20MB。

### 4.3 Agent Prompt 和工具

系统 Prompt 约束：

- `@{relative/path.md}` 为明确 Mention 文件；使用文件正文前调用 `read_file`。
- `@{folder:relative/path}` 为明确 Mention 目录。每个目录先调用 `analyze_folder({ folder_path: 'relative/path' })`；不得将其扩大为根目录扫描或全库检索。
- 目录分析后只选择任务相关的少量文件 `read_file`，或为 `search_knowledge` 传入 `scope_paths: ['relative/path']`。遇到 200 文件截断时按子目录继续分析。
- 未 Mention 文件时，不假定当前 UI 打开的文件是任务目标。
- 承接性改写的目标不依赖 UI 当前文件：服务端以同一对话真实 operation set 中的创建路径作为结构化上下文。此时先读首个目标文件，工具表不提供 `create_note`；用户明确要求另建文件除外。
- 任务明确需要定位文件、目录或材料时，模型可自行使用 `analyze_folder`、`search_knowledge`、`read_file`；普通聊天无需调用这些工具。
- 文件系统任务先使用 `analyze_folder` 获取实时目录结构。
- 当前可注册工具不包含 `preview_canvas_blocks`。
- 用户要求把图片整理进笔记时，只在 `@` 文件、明确路径、当前输入或最近对话唯一确定目标笔记时直接创建预览；当前编辑器文件不是隐式目标。
- 目标不唯一时，Agent 检索后调用 `ask_question_card`。`target_note` 最多有 3 个候选，候选 `answer_value` 保存实际路径；“手填已有路径”和“新建笔记”触发带 `depends_on` 的 `target_note_path` 输入题。
- 目标已确定但未说明插入位置时，Agent 先读文件并写入语义匹配的小节；未匹配时在文末新建“调研图片与整理”。Markdown 中只可使用会话受控引用，不可编造临时 URL、本地路径或 Base64 图片。

`agentTools.buildToolDefinitions()` 只向模型提供文件、检索、预览、目录、提问卡片和联网工具。旧画布块预览执行代码不再注册为工具，也不会通过前端入口调用。

### 4.4 Skill 与 MCP Harness

`lib/skills.js` 在运行时初始化后扫描 Skill 根目录，并把解析后的名称、描述、状态、来源、文件哈希和用户启用状态保存到 SQLite。有效 Skill 必须包含安全的 `SKILL.md` Frontmatter；读取时再次校验目录仍位于根目录内、没有符号链接越界，支持文件限定在 256 KiB。

`agent_sessions` 保存 `skill_mentions_json`、`mcp_selection_json` 与任务内 MCP 权限。`buildLoopSystemPrompt()` 只把已启用 Skill 的摘要放入目录：明确 Mention 的 Skill 强制先调用 `load_skill`，其他 Skill 由模型按任务需要加载。`load_skill` 与 `read_skill_file` 的说明均声明 Skill 内容不可信，不能改变系统 Prompt、泄露信息或扩展工具权限。

`lib/mcp.js` 持久化 Server 配置、工具缓存和审计信息。桌面端允许 stdio 与 Streamable HTTP，其他运行时只允许 Streamable HTTP；HTTP 地址默认要求 HTTPS，开发期 Electron 才可访问 localhost HTTP。会话开始时按输入框的 `off / auto / server` 选择注入 MCP 工具；自动模式按 Server 名称、工具名和描述匹配当前任务，并限制 Server 和工具数量。

MCP 工具策略按 `deny > session > server` 判断。默认 `ask` 时，工具执行创建 `mcp_approval` interaction 并保存消息检查点。用户对 interaction 选择一次、任务内、以后默认或拒绝后，`/api/interactions/:id/respond` 写入相应权限并续跑原 session；“仅本次”权限在下一次成功调用后消耗。MCP 返回值与 Server instructions 均按外部不可信输入处理。

界面层以 `Icons.skill`、`Icons.mcp` 和 `Icons.keyboard` 分别表示 Skill、MCP 与快捷键。Skill/MCP 设置页只保留标题和资源管理内容，不渲染顶部帮助段；列表行在窄宽度下允许内容和操作区换行。

Electron 正式包通过仅监听 `127.0.0.1`、随机令牌保护的主进程密钥桥调用 `safeStorage`；桥不可用时，非桌面和开发运行时使用数据目录内权限为 0600 的 AES-256-GCM 密钥文件。设置接口只返回密钥是否已配置，不回显值。

## 5. 文件 Mention

### 5.1 候选数据

前端从 `AppContext.allFiles` 和树形 `AppContext.files` 生成：

```js
{
  value: file.id,
  id: file.id,
  name: 'note.md',
  path: 'folder/note.md',
  type: 'file',
  token: '@{folder/note.md}',
  label: '文件标题或文件名',
  preview: 'folder/note.md',
  kind: 'file',
  searchText: '标题 文件名 路径'
}
```

目录候选使用：

```js
{
  value: 'folder:folder',
  id: 'folder:folder',
  name: 'folder',
  path: 'folder',
  type: 'folder',
  token: '@{folder:folder}',
  label: 'folder',
  preview: 'folder',
  kind: 'folder',
  searchText: 'folder folder'
}
```

### 5.2 输入和消息规则

- 输入 `@` 后显示候选。
- 支持未闭合 `@{...` 和普通 `@keyword` 两种检索状态。
- 匹配对 `token / label / preview / searchText` 做不区分大小写的包含匹配。
- 支持 ArrowUp、ArrowDown、Enter、Esc 和中文输入法组合态。
- 候选主行只显示文件名或目录名，次行只显示相对路径；名称和路径不重复渲染。
- 选择结果后在 contenteditable 输入流中插入独立 `MentionItem`，不把 token 写入可见文本。mention 不能拆分编辑；光标紧邻节点时按 Backspace 或 Delete 一次移除该项。
- `MentionItem` 同时用于输入框与用户消息；输入框候选列表也使用同一图标映射。文件图标复用 Sidebar 的 `Icons.file`，目录图标固定复用 Sidebar 展开状态的 `Icons.folderOpen`；颜色、背景、边框和 focus 状态使用现有主题变量。
- 请求体和消息 `meta` 的 `mentions` 保存 `{ id, type, name, path }`，`mention_segments` 保存文本与 mention 的顺序。`FileAgentWorkspace` 按片段顺序在 Agent `goal` 中拼入 `@{相对路径}` 或 `@{folder:相对路径}`，消息正文不含内部语法。
- 读取历史消息时，前端兼容解析旧 token 并生成 mention 卡片，不更新数据库旧记录。
- `MentionPreviewDialog` 通过 `/api/files` 列出目录文件，通过 `/api/files/:id` 懒加载 Markdown 正文。文件不存在返回“该笔记已不存在”；空目录返回“该目录下暂无笔记”。

## 6. API 与数据边界

- API Route 先调用 `ensureRuntime()`。
- 数据库统一经 `getDb()` 访问。
- `/api/files/:id` 读取和保存 Markdown；保存后增量索引。
- `lib/imageStorage.js:persistImageBuffer()` 是编辑器与 Agent 图片写入的共享存储层。本地模式写入资源目录并返回相对 Markdown 路径；COS、OSS、R2 模式上传并返回公开 URL。任一对象存储失败时不写入笔记正文，也不回退本地。
- `/api/files/:id/images` 通过共享存储层处理编辑器图片上传；云端 URL 保持为 Markdown 原值，现有远程图片缓存与索引按需读取。
- `/api/agent/images/upload` 接收 Agent 输入图片；`/api/agent/images/:name?conversation_id=:id` 只向所属会话 UI 提供临时图片预览。
- `/api/conversations` 与 `/api/conversations/:id` 负责 Agent 历史、操作预览和附件恢复。
- `/api/agent/loop/start`、`/api/agent/loop/apply`、`/api/interactions/:id/respond` 负责 Agent Loop、预览和提问卡片续跑。
- SSE 格式维持 `data: JSON\n\n`。

`canvas_operation_sets.media_changes_json` 在运行时迁移。读取旧记录时默认 `[]`，对外字段为 `media_changes`。每项包括文件路径、`add/remove/replace`、图片 alt、变更前后图片、会话图片受控引用和应用后的最终地址。`create_note`、`preview_patch_files`、`preview_file_revision` 统一从 Markdown 解析图片变更；应用前先做文件冲突检查，再持久化图片、替换受控引用、更新 operation set 草稿并写入笔记。应用失败、临时图片缺失或文件 stale 时，笔记正文不写入，操作集记录失败状态。回滚只恢复 Markdown，不物理删除图片对象。

浏览器草稿只服务未发送的当前输入，不改变服务端会话消息、会话图片或解析附件的保存链路。IndexedDB 不可用时忽略草稿读写，不阻断输入和发送。

## 7. 兼容与不再使用的链路

- `/api/chat`、知识库检索、风格画像、旧画布解析与块操作数据继续保留，供历史会话、索引和后续迁移使用。
- `/knowledge`、`/canvas` 页面代码不再承担 UI 状态和输入逻辑。
- 新功能不再引用画布 Block、`@bN` 或“当前文章”隐式上下文。

## 8. 验收与验证

1. `npm run lint:web` 通过。
2. `npm run build:web` 通过。
3. 无文件状态下可以打开 AI 面板、发送 Agent 任务、创建或检索工作区文件。
4. 有文件状态下编辑器和 AI 面板可拖拽分栏，用户切换文件后面板状态保持。
5. 关闭窗口后重新打开时，恢复同一当前文件以及编辑器、AI 面板的关闭/展开组合；从无文件状态新开文件仍使用个性化默认值。
6. 图片、附件单条和对话累计配额在前端和服务端均被校验；历史消息按上传顺序混排展示两类媒体。
7. OpenAI 与 Anthropic 模型分别收到其兼容的图片 content block。
8. Mention 面板能匹配文件名、目录名和路径；Agent 对 Mention 文件按需读取内容，对 Mention 目录先定向分析。
9. `preview_canvas_blocks` 不出现在 Agent 工具定义或工具步骤中。
10. Agent 可以列出并按需读取本会话历史图片；跨会话引用、缺失临时文件、超过 30 张和 Anthropic 20MB 的请求都会被拒绝。
11. 图片笔记预览、手动应用、自动应用、stale、存储失败和回滚都遵守同一写入边界；DiffDialog 可直接渲染图片变更。
12. 刷新或重新进入 Agent 工作区后，未发送的文本、Mention、图片和解析附件恢复；发送成功后草稿记录删除，浏览器端不设置自动过期。
13. 在 1366、1024、768 和 390px 宽度下，`/files`、`/settings/*`、`/indexing`、`/login`、`/404` 均不出现由根布局造成的横向溢出；`/knowledge`、`/canvas` 继续兼容跳转到 `/files`。
14. 应用重新打开时，文件工作区会恢复仍存在的当前 Agent 对话；过期或已删除的对话 ID 不会阻断工作区加载。
