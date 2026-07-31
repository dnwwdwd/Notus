# Agent文件与目录提及组件化、历史兼容与笔记预览

## 分类

功能优化 / 用户体验优化。

## 交付

- 输入 `@` 后继续搜索工作区文件和目录。选中结果在当前位置插入不可拆分的结构化 mention 节点，不写入可见文本 token。
- 输入框与用户历史消息共用 `MentionItem`。候选列表、输入框与用户历史消息中的文件使用 Sidebar 文件图标，目录统一使用 Sidebar 展开状态的 `Icons.folderOpen`，采用 Notus 主题强调色、紧凑的 24px 内联高度、6px 圆角和自适应宽度，不再呈现为附件队列。
- mention 可整体移除；光标紧邻节点时按 Backspace 或 Delete 一次移除该节点。点击卡片会打开只读预览。
- 新消息在 `meta.mentions` 保存 `{ id, type, name, path }`，并在 `meta.mention_segments` 按输入顺序保存文本与 mention 片段。内部 Agent `goal` 按同一顺序保留等价 token，保持 `read_file` 与 `analyze_folder` 的已有语义；消息正文不显示 token。
- 历史消息读取时兼容解析 `@{file}` 与 `@{folder:path}`，只在前端转换为 mention 卡片，不改写数据库记录。
- 文件预览通过既有 `/api/files` 和 `/api/files/:id` 按需读取 Markdown；目录预览先列出目录内文件，选择文件后再读取正文。

## 验证

- `npm --prefix notus run lint`
- `npm run lint:web`
- `npm run build:web`

## 状态

已完成。
