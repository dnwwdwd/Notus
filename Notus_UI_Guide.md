# Notus UI Guide v2.1

> 面向 Google Stitch 的 UI 生成指南。定义所有页面布局、组件规范、样式 Token。

---

## 1. Design Tokens

### 1.1 颜色

```
/* ===== Light (Claude 风格 — 暖 cream 底 + terracotta 强调) ===== */

/* 背景 */
--bg-primary: #FAF9F5;
--bg-secondary: #F0EDE6;
--bg-elevated: #FFFFFF;
--bg-hover: #EAE7E0;
--bg-active: #E2DED6;
--bg-sidebar: #EEEBE4;
--bg-input: #FFFFFF;

/* Diff / 状态背景 */
--bg-diff-add: #DAFBE1;
--bg-diff-remove: #FFE2E0;
--bg-diff-modified: #FFF8C5;

/* 消息气泡 */
--bg-ai-bubble: #FAF9F5;
--bg-user-bubble: #F0EDE6;

/* 边框 */
--border-primary: #D8D4CB;
--border-subtle: #E8E5DE;

/* 文字 */
--text-primary: #1A1311;
--text-secondary: #6B6158;
--text-tertiary: #9C9489;
--text-on-accent: #FFFFFF;

/* 强调色 — Terracotta */
--accent: #C15F3C;
--accent-hover: #A8502F;
--accent-subtle: #FBEEE8;
--accent-muted: #D4896E;

/* 语义色 */
--danger: #D93025;
--danger-subtle: #FDE7E7;
--warning: #E09A1A;
--warning-subtle: #FFF8E1;
--success: #1E8E3E;
--success-subtle: #E6F4EA;

/* 阴影 */
--shadow-sm: 0 1px 2px rgba(26,19,17,0.06);
--shadow-md: 0 4px 12px rgba(26,19,17,0.08);
--shadow-lg: 0 8px 24px rgba(26,19,17,0.12);

/* ===== Dark (Claude 风格 — 保持暖调) ===== */

--bg-primary: #1C1917;
--bg-secondary: #252220;
--bg-elevated: #2E2A27;
--bg-hover: #38332F;
--bg-active: #443E39;
--bg-sidebar: #211E1C;
--bg-input: #2E2A27;
--bg-diff-add: #1A3326;
--bg-diff-remove: #3D2020;
--bg-diff-modified: #3D3520;
--bg-ai-bubble: #1C1917;
--bg-user-bubble: #2E2A27;
--border-primary: #3D3835;
--border-subtle: #332F2C;
--text-primary: #EDE8E3;
--text-secondary: #A69E95;
--text-tertiary: #7A7269;
--text-on-accent: #FFFFFF;
--accent: #D4896E;
--accent-hover: #C15F3C;
--accent-subtle: #3D2E27;
--accent-muted: #A8502F;
--danger: #F87171;
--danger-subtle: #3D2020;
--warning: #FBBF24;
--warning-subtle: #3D3520;
--success: #4ADE80;
--success-subtle: #1A3326;
--shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
--shadow-md: 0 4px 12px rgba(0,0,0,0.4);
--shadow-lg: 0 8px 24px rgba(0,0,0,0.5);
```

### 1.2 字体

```
--font-ui: 'PingFang SC', 'Noto Sans SC', -apple-system, sans-serif;
--font-editor: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', Georgia, serif;
--font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;

--text-xs: 11px;
--text-sm: 13px;
--text-base: 15px;
--text-lg: 18px;
--text-xl: 22px;
--text-2xl: 28px;
--text-3xl: 36px;
```

**字体加载策略：**
- `Noto Serif SC` 通过 Google Fonts CDN（`font-display: swap`），fallback `Songti SC`(macOS) → `Georgia`
- `JetBrains Mono` 通过 Google Fonts CDN，fallback `SF Mono` → `Consolas`
- UI 字体使用系统字体栈，无需额外加载

### 1.3 间距 & 圆角

```
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;

--radius-sm: 4px;
--radius-md: 6px;
--radius-lg: 8px;
--radius-xl: 12px;
--radius-full: 9999px;
```

### 1.4 动画

```
--transition-fast: 120ms ease;
--transition-normal: 200ms ease;
--transition-slow: 300ms ease;
```

---

## 2. 全局 Shell 布局

```
┌─────────────────────────────────────────────────┐
│  TopBar (h:48px, fixed)                         │
├──────────┬──────────────────────────────────────┤
│ Sidebar  │  Main Content                        │
│ w:240px  │  (flex:1, overflow-y:auto)           │
│ 可折叠   │                                      │
│ 到 0px   │                                      │
└──────────┴──────────────────────────────────────┘
```

- TopBar + Sidebar + Main 构成 App Shell，所有页面共享（登录页和初始化引导页除外）
- Sidebar 折叠动画 300ms ease
- Main Content 区域由路由决定内容

---

## 3. TopBar 组件

高度 48px，背景 `--bg-elevated`，底部 1px `--border-subtle`。

```
┌─────────────────────────────────────────────────────┐
│ [Logo] Notus    [文件] [知识库] [创作]    [⚙ 设置]  │
└─────────────────────────────────────────────────────┘
```

| 区域 | 说明 |
|------|------|
| Logo | 24x24 SVG icon + "Notus" 文字，font-weight:600，font-size:--text-base，gap:8px |
| Nav Tabs | 三个 tab：文件、知识库、创作。激活态底部 2px accent 下划线 + 文字 accent 色。未激活 text-secondary，hover 时 text-primary |
| 设置按钮 | 齿轮 icon 20x20，hover 旋转 90° 动画 |

**索引 mini indicator（全局）：**
- 当后台索引运行时，紧贴 TopBar 底部出现 h:2px bg:--accent 进度条
- width 按百分比动态变化，完成后 2s fadeOut

---

## 4. Sidebar 组件

宽 240px，背景 `--bg-sidebar`，右边框 1px `--border-subtle`。

### 4.1 Sidebar 顶部 Tab 栏

```
┌────────────────────────┐
│  [📁]  [≡]             │
├────────────────────────┤
│  搜索框（可选显示）     │
├────────────────────────┤
│  内容区域               │
└────────────────────────┘
```

- 两个 icon tab：文件树(📁) / 目录树(≡)
- Tab 激活态：icon 加深 + 底部 2px accent 短线
- TOC tab 在非编辑器页面 disabled（icon 置灰 text-tertiary，不可点击）

### 4.2 FileTree 文件树

每行高度 32px，左侧缩进 16px/层。

```
▸ 技术文章/
  ▸ 缓存系列/
    性能优化实践.md
    Redis 深入.md
▸ 随笔/
README.md
```

| 元素 | 样式 |
|------|------|
| 文件夹 icon | 📁 16x16，折叠时 ▸、展开时 ▾ |
| 文件 icon | 📄 16x16 |
| 文件名 | font-size:--text-sm, color:--text-primary, truncate 单行省略 |
| hover | 整行 bg:--bg-hover, radius:--radius-sm |
| 选中 | bg:--accent-subtle, color:--accent, font-weight:500 |
| 右键菜单 | ContextMenu 组件（§11.3） |
| 索引状态角标 | 文件名右侧: ⏳(--warning) / ⚠️(--danger) |

**文件树顶部操作栏：**
```
[🔍] [＋📄] [＋📁]
```
三个 icon button，24x24，hover bg:--bg-hover

**文件树空态：**
EmptyState：icon 📁, "还没有笔记", "导入 Markdown 文件开始使用", [导入文件] 按钮

**搜索无结果：**
"没有匹配的文件", --text-sm --text-tertiary, 居中, padding:--space-8

### 4.3 TOC 目录树

仅当编辑器打开文件时可用。

| 元素 | 样式 |
|------|------|
| 每行 | h:28px, font-size:--text-sm, color:--text-secondary |
| hover | color:--text-primary |
| 当前章节 | color:--accent, font-weight:500, 左侧 2px accent 竖线 |
| 层级缩进 | h1:0, h2:16px, h3:32px, h4:48px |

**TOC 空态：** "当前文档没有标题", --text-sm --text-tertiary, 居中

---

## 5. 页面：文件管理（编辑器）

路由 `/files`，默认页面。

### 5.1 布局

```
┌──────────┬──────────────────────────────────────┐
│ Sidebar  │  EditorToolbar (h:40px)              │
│          ├──────────────────────────────────────┤
│          │  Editor Area                         │
│          │  max-width:780px, mx:auto            │
│          │  padding:40px 60px                   │
│          │  font: --font-editor, --text-lg      │
│          │  line-height: 1.8                    │
└──────────┴──────────────────────────────────────┘
```

### 5.2 EditorToolbar

高度 40px，bg:--bg-elevated，底部 1px --border-subtle。

```
[ B | I | S ] | [H▾] | [🔗 🖼] | [</> ❝ —] | [UL OL] |  ←→  | [分栏预览] [AI 创作]
 文字格式组    标题    插入组     块级格式组    列表组   弹性间距     右侧操作
```

| 区域 | 说明 |
|------|------|
| 按钮通用 | 32x32, icon 18x18, radius:--radius-sm, hover bg:--bg-hover, 激活态 bg:--accent-subtle color:--accent |
| 分组分隔线 | w:1px h:20px bg:--border-subtle, mx:--space-1 |
| H 下拉 | Select 组件，H1–H6 + 正文，各级带字号预览 |
| 分栏预览 | toggle 按钮，激活后 Editor Area 左右 50/50 |
| AI 创作 | primary Button(sm)，跳转画布携带当前文章 |
| 宽度 < 640px | 列表组 + 块级格式组收入 `···` 溢出菜单（ContextMenu 样式下拉） |

### 5.3 Editor Area

- CodeMirror 6，居中 max-width:780px，padding:60px
- 正文 font:--font-editor --text-lg，行高 1.8
- H1 --text-3xl/700, H2 --text-2xl/600, H3 --text-xl/600
- 代码块：bg:--bg-secondary, radius:--radius-md, padding:--space-4, font:--font-mono --text-sm
- 引用块：左边框 3px --accent, pl:--space-4, color:--text-secondary
- 图片：max-width:100%, radius:--radius-md, shadow:--shadow-sm
- 来源高亮：URL hash `#L24-L28` → 目标行 bg:--bg-diff-modified, 3s fadeOut

### 5.4 分栏预览模式

```
┌──────────────────┬──────────────────┐
│   编辑区 (50%)   │   预览区 (50%)   │
│   CodeMirror     │   react-markdown │
└──────────────────┴──────────────────┘
```

中间竖线 1px --border-primary，可拖拽（min:30%, max:70%）。

### 5.5 页面状态

| 状态 | 表现 |
|------|------|
| 空态（未选中文件） | EmptyState：icon 📝, "选择一篇文章开始编辑", "从左侧文件树中选择文件" |
| 加载中 | Skeleton：标题行 1 条(w:60% h:36px) + 正文行 8 条(w:100%/90%/85% h:18px) |
| 加载失败 | EmptyState：icon ⚠️, "文件加载失败", [重试] 按钮 |
| 保存中 | TopBar 文件名旁 Spinner(sm)，完成后 ✓ 短暂闪现 |

---

## 6. 页面：知识库问答

路由 `/knowledge`。

### 6.1 布局

```
┌──────────┬──────────────────────────────────────┐
│ Sidebar  │  Reference Bar                       │
│          ├──────────────────────────────────────┤
│          │  ChatArea (flex:1, max-width:720px)  │
│          ├──────────────────────────────────────┤
│          │  InputBar (sticky bottom)            │
└──────────┴──────────────────────────────────────┘

选中文件后，左侧会额外展开文章编辑区；未选中文件时不展示编辑器。
```

### 6.2 ChatArea

**用户消息：** 右对齐, bg:--bg-user-bubble, radius:--radius-lg, padding:--space-3 --space-4, max-width:80%

**AI 回复：** 左对齐, 无背景, padding:--space-3 0, 头部 ✨+Notus label(--text-sm --text-secondary), 正文 markdown 渲染 + StreamingText 组件, 底部 SourceCard 列表

### 6.3 InputBar

Sticky 底部，bg:--bg-elevated, padding:--space-3 --space-4, border-top:1px --border-subtle。

| 元素 | 样式 |
|------|------|
| 模型选择 | Select(sm) |
| 输入框 | TextArea, flex:1 |
| 发送 | 40x40, bg:--accent, color:--text-on-accent, radius:--radius-full, disabled opacity:0.4 |

### 6.4 页面状态

| 状态 | 表现 |
|------|------|
| 空态（无对话） | EmptyState：✨(48x48 opacity:0.3), "输入问题，从你的知识库中获取答案", 下方 3 个 suggestion chip(ghost Button sm, 如 "我最近写了什么?") |
| 索引未完成 | EmptyState：⏳, "知识库正在建立索引", ProgressBar |
| AI 回复中 | StreamingText + 底部 "停止生成" ghost 按钮 |
| 检索无结果 | AI 文字提示换个问法或检查文章导入 |
| API 错误 | InlineError 组件：错误信息 + [重试] |

---

## 7. 页面：AI 创作画布

路由 `/canvas`。

### 7.1 布局

```
┌──────────┬────────────────────────┬──────────────────┐
│ Sidebar  │  Canvas Area (65%)     │  AI Panel (35%)  │
│          │  文章标题              │  风格来源选择器   │
│          │  [Block 1~N]           │  对话消息列表     │
│          │  [+ 新建块]            │  输入栏           │
└──────────┴────────────────────────┴──────────────────┘
```

侧边栏点击文件时，在当前页面直接载入对应文章进入创作，不跳转回 `/files`。

### 7.2 AI Panel

**风格来源选择器（顶部）：** Select 组件，"自动匹配"(默认) / "手动指定文件"(触发 FilePickerDialog)。手动模式下展示 tag 列表(Badge accent + ✕)

**对话区域：** 同知识库 ChatArea 样式，AI 回复中嵌套 OperationPreview 组件

**输入栏：** 同知识库 InputBar，支持 `@b2` 引用块号（`@` 触发 autocomplete popup）

### 7.3 Canvas Area

**标题：** font:--font-editor --text-3xl/700, padding:--space-8 --space-6 --space-4

**Block 列表：** CanvasBlock 组件，gap:--space-1

**AddBlockButton：** border:1px dashed --border-primary, radius:--radius-md, padding:--space-4, "+ 新建块" --text-tertiary, hover accent 色

### 7.4 新建创作入口页

Canvas 无文章时显示，居中 max-width:480px mt:20vh：
- 主题输入框 Input(h:48px --text-lg) + [生成大纲并开始] primary Button
- 最近创作列表（每行 h:40px hover bg:--bg-hover）

### 7.5 页面状态

| 状态 | 表现 |
|------|------|
| 加载中 | Skeleton：标题(w:50% h:36px) + Block 骨架 4 条(h:80px) |
| AI 处理中 | 目标 Block 左边框 --accent 脉冲(opacity 0.4↔1), AI Panel 显示 StreamingText |
| 大纲生成中 | Block 骨架依次渐入(300ms 延迟), 内容流式填充 |

---

## 8. 页面：设置

路由 `/settings`。

### 8.1 布局

```
┌──────────┬──────────────────────────────────────┐
│ Settings │  设置内容区                           │
│ Nav      │  max-width:640px, mx:auto            │
│ w:200px  │  padding:--space-8                   │
└──────────┴──────────────────────────────────────┘
```

### 8.2 Settings Nav

四项：模型配置、外观、存储、关于。每行 h:36px --text-sm，激活态 bg:--accent-subtle color:--accent font-weight:500。

### 8.3 模型配置

Embedding 模型（提供商 Select + 模型 Select + API Key Input + 维度只读）+ LLM 模型（提供商 + 模型 + API Key）+ [测试连接] + [保存]

**API Key 字段状态：**

| 状态 | 表现 |
|------|------|
| 默认 | Input, placeholder "sk-..." |
| 已填写 | 密码遮罩 ••••, 右侧 👁 toggle |
| 校验通过 | 内嵌 ✓(--success), border-color:--success |
| 校验失败 | 内嵌 ✕(--danger), border-color:--danger, 下方错误文字 |

**测试连接按钮：** 默认 secondary → 测试中 loading → 成功 Toast + 按钮闪绿 → 失败 Toast + 按钮闪红

**模型列表：** 提供商切换后模型 Select 动态更新（预设列表），维度自动填充 disabled

### 8.4 外观

主题 RadioGroup(浅色/深色/跟随系统) + 编辑器字号 Select + 编辑器行高 Select。即时生效。

### 8.5 存储

笔记目录只读 + 索引状态(Badge) + [重建索引](ConfirmDialog 确认后 loading + ProgressBar) + [清除索引](danger ConfirmDialog)

---

## 9. 页面：登录 / 初始化

### 9.1 登录页 `/login`

全屏居中，无 Shell。

- Logo 64x64 + "Notus" --text-2xl/700 + 副标题 --text-sm --text-secondary
- Spinner(md) + "正在登录..."
- 5s 超时后 fadeIn [重新登录] ghost Button
- 失败态：Spinner → ✕(--danger) + 错误文字 + [重新登录]

### 9.2 初始化引导页 `/setup`

全屏居中 max-width:560px，无 Shell。三步流程：

| Step | 内容 | 可跳过 |
|------|------|--------|
| 1 | 配置 AI 模型（复用设置页表单） | 是 |
| 2 | 导入笔记（拖拽上传区 + "使用空目录" 选项） | 是 |
| 3 | 完成（"一切就绪!" + 索引进度 + [开始使用]） | 否 |

**步骤指示器：** 圆点 12x12(当前/已完成 bg:--accent, 未到达 bg:--bg-active) + 连接线 2px --border-primary

**拖拽上传区：** border:2px dashed --border-primary, radius:--radius-xl, h:200px, 居中 icon+文字, dragover 时 border-color:--accent bg:--accent-subtle

---

## 10. 页面：索引进度 & 错误

### 10.1 索引进度 `/indexing`

有 Shell。居中 max-width:640px。

- ProgressBar + 文件计数 (82/128)
- 当前文件名 --text-sm --text-secondary + 预计剩余时间
- 已完成列表：每行 ✓(--success) / ⚠(--warning) + 文件名 + 块数
- 可后台运行（TopBar mini indicator 保持显示）

### 10.2 404 页 `/*`

有 Shell。EmptyState 变体：404 大字(--text-3xl opacity:0.15) + "页面不存在" + [返回首页]

### 10.3 错误页（不可恢复）

无 Shell。全屏居中：⚠️(64x64 --danger) + "出了点问题" + 错误描述 + [重新加载] [前往设置]

---

## 11. 通用组件库

### 11.1 Button

**变体：** primary(bg:--accent), secondary(bg:--bg-secondary border), ghost(transparent), danger(bg:--danger)

**尺寸：** sm(h:28px --text-xs), md(h:36px --text-sm), lg(h:44px --text-base)

通用 radius:--radius-md font-weight:500。disabled opacity:0.4。loading 态 Spinner(sm) + "加载中..."

### 11.2 Dialog

遮罩 rgba(0,0,0,0.4) blur(4px)。容器 bg:--bg-elevated radius:--radius-xl shadow:--shadow-lg max-width:480px。标题栏 / 内容区 / 底部操作栏三段式。入场 scale(0.95)→1 opacity:0→1 200ms。Esc 关闭。

### 11.3 ContextMenu

bg:--bg-elevated border shadow:--shadow-md, min-width:180px。每项 h:32px --text-sm icon+text。hover bg:--bg-hover。删除项 color:--danger。分隔线 h:1px --border-subtle。点击外部/Esc 关闭。

### 11.4 Input

h:40px, border:1px --border-primary, radius:--radius-md, bg:--bg-input。focus ring --accent。error ring --danger。success border --success。disabled bg:--bg-secondary opacity:0.6。

### 11.5 SourceCard 来源卡片

```
┌──────────────────────────────────────┐
│ 📄 性能优化实践 › 缓存策略     [→]  │
│    "Redis 的过期策略应当优先..."      │
└──────────────────────────────────────┘
```

bg:--bg-elevated, border:1px --border-primary, radius:--radius-md, padding:--space-3。hover border-color:--accent shadow:--shadow-sm。文件名 --text-sm/500, heading path --text-xs --text-tertiary(" › "分隔), 摘要 --text-xs --text-tertiary truncate。多卡片垂直 gap:--space-2。

点击跳转编辑器对应文件+行，触发来源高亮。

### 11.6 OperationPreview 操作预览

```
┌──────────────────────────────────────┐
│  🤖 操作预览 · 块 #2                 │
│  - 旧内容（红底删除线）              │
│  + 新内容（绿底）                    │
│  ───────────────────                 │
│  [取消]  [应用修改]                   │
└──────────────────────────────────────┘
```

bg:--bg-ai-bubble, border:1px --accent-subtle, radius:--radius-lg, padding:--space-4。标题 🤖 + "操作预览" + Badge(accent)块号。diff 区 font:--font-mono --text-sm, 删除行 bg:--bg-diff-remove line-through --danger, 新增行 bg:--bg-diff-add --success。底部 [取消]ghost + [应用]primary。

### 11.7 CanvasBlock 画布块

```
┌─────────────────────────────────────────┐
│ [⠿] [✏️] [🤖]  Block markdown 内容      │
└─────────────────────────────────────────┘
```

| 状态 | 样式 |
|------|------|
| 默认 | padding:--space-3 --space-4, border-left:3px transparent |
| hover | border-left:3px --border-primary, 操作栏浮现(opacity:0→1 translateX(-4px)→0) |
| 编辑中 | border-left:3px --accent, 内容切为 CodeMirror inline |
| AI 已修改 | bg:--bg-diff-modified, border-left:3px --warning, Badge(warning)"已修改" |
| AI 处理中 | border-left:3px --accent 脉冲(opacity 0.4↔1, 1.5s infinite) |
| 已应用 | flash bg:--success-subtle 300ms fadeOut |

操作栏：bg:--bg-elevated shadow:--shadow-sm radius:--radius-md，三 icon(⠿拖拽/✏️编辑/🤖AI)

### 11.8 StreamingText 流式文字

逐 token 追加渲染，末尾闪烁光标 w:2px h:1em bg:--accent, animation:blink 1s step-end infinite(0%,100% opacity:1, 50% opacity:0)。完成后光标 300ms fadeOut。markdown 实时渲染。

### 11.9 Skeleton 骨架屏

bg:--bg-secondary radius:--radius-sm, shimmer 动画(gradient 扫过 1.5s infinite)。变体：text(h:16px), title(h:24px), avatar(32x32 radius-full), block(h:80px)。行间 gap:--space-2。

### 11.10 TextArea

min-h:40px max-h:120px auto-resize。样式同 Input。`@` 触发 autocomplete popup(bg:--bg-elevated shadow:--shadow-md, 每项 h:32px hover bg:--bg-hover, 键盘↑↓+Enter)。

### 11.11 Select

Trigger 同 Input 外观 + chevron-down。Dropdown bg:--bg-elevated border shadow:--shadow-md, 选项 h:32px hover bg:--bg-hover, 选中 color:--accent + check icon。入场 scaleY(0.95)→1 opacity:0→1。

### 11.12 SearchInput

同 Input，左侧 🔍 icon 16x16(--text-tertiary), 右侧快捷键 badge(--text-xs bg:--bg-secondary radius:--radius-sm)。

### 11.13 CommandPalette（⌘K）

遮罩 + 居中容器(max-width:560px mt:20vh radius:--radius-xl shadow:--shadow-lg)。搜索框 h:48px --text-base 无外边框。分组标题 --text-xs --text-tertiary uppercase。结果项 h:36px hover bg:--bg-hover。入场 translateY(-8px)→0。

**键盘：** ↑↓移动高亮, Enter 执行, Esc 关闭, 无匹配 "没有找到结果" 居中

### 11.14 SearchResults

每项 padding:--space-3 border-bottom:--border-subtle。文件名 --text-sm/500 关键词高亮(bg:--accent-subtle color:--accent)。路径+时间 --text-xs --text-tertiary。无结果 "没有找到匹配的文件"。

### 11.15 Spinner

圆环 border:2px --border-primary border-top:2px --accent, rotate 0.8s infinite。sm(16), md(24), lg(32)。

### 11.16 Badge

default(--bg-secondary), accent(--accent-subtle), warning(--warning-subtle), danger(--danger-subtle), success(--success-subtle)。--text-xs padding:2px 8px radius-full font-weight:500。

### 11.17 Tooltip

bg:--text-primary color:--bg-primary --text-xs, padding:4px 8px radius:--radius-sm。入场 opacity+translateY 150ms。延迟 500ms。

### 11.18 Toast

固定右上角。bg:--bg-elevated border radius:--radius-lg shadow:--shadow-md。icon(✓绿/✕红/ℹ蓝/⚠黄) + 文字。入场 translateX(100%)→0, 3s 后 fadeOut。多条堆叠 gap:--space-2。

### 11.19 Toggle

w:40 h:22 radius-full。OFF bg:--bg-active 圆点左, ON bg:--accent 圆点右。圆点 18x18 white shadow。

### 11.20 Tabs

每 tab padding:--space-2 --space-4 --text-sm。激活 color:--accent font-weight:500 底部 2px accent 线(animate width)。

### 11.21 ConfirmDialog

Dialog 语义封装。danger 操作用 danger Button + ⚠️ icon。

### 11.22 FilePickerDialog

Dialog + FileTree + 搜索。max-height:60vh overflow-y:auto。复选框 16x16 checked bg:--accent。已选计数 --text-xs。

### 11.23 ProgressBar

h:6px bg:--bg-active radius-full, 已完成 bg:--accent transition width 300ms。不确定态：gradient 左右滑动。标签 --text-xs --text-secondary。

### 11.24 EmptyState

居中 padding:--space-8。icon(48x48 opacity:0.3) + 主标题(--text-base/500) + 副标题(--text-sm --text-tertiary max-width:360px) + 可选 secondary Button。

### 11.25 InlineError

bg:--danger-subtle radius:--radius-md padding:--space-2 --space-3。✕(--danger) + 文字 --text-sm + [重试] ghost(sm)。

---

## 12. 响应式规则

| 断点 | Shell | 页面适配 |
|------|-------|---------|
| ≥1280px | Sidebar 展开 | 画布三栏正常 |
| 1024–1279px | Sidebar 默认折叠, overlay 展开 | AI Panel 收窄 min:25% |
| 768–1023px | Sidebar 为 drawer(☰触发), w:280px + 遮罩 | 画布 AI Panel → 底部抽屉(h:50vh 上滑); 编辑器 padding→20px |
| <768px | 同上 | 仅文件管理+知识库; 画布提示"请在更大屏幕上使用"; 设置 Nav→顶部 Tabs |

**Drawer 关闭：** 点击遮罩 / Esc / 左滑手势

**AI Panel 底部抽屉（768–1023px）：** 收起态 h:48px 显示摘要+[展开], 展开态 h:50vh 含对话区+InputBar, 上滑展开下滑收起

---

## 13. 快捷键

| 快捷键 | 操作 |
|--------|------|
| ⌘K | CommandPalette |
| ⌘S | 保存文件 |
| ⌘B | 加粗 |
| ⌘I | 斜体 |
| ⌘\ | 折叠/展开 Sidebar |
| ⌘Enter | 发送消息 |
| Esc | 关闭浮层 |

---

## 14. 页面总览

| # | 路由 | 名称 | Shell | 说明 |
|---|------|------|-------|------|
| 1 | `/login` | 登录 | 无 | OIDC 中间态 |
| 2 | `/setup` | 初始化引导 | 无 | 首次三步配置 |
| 3 | `/files` | 文件管理 | 有 | 默认页，编辑器 |
| 4 | `/knowledge` | 知识库问答 | 有 | AI 对话 |
| 5 | `/canvas` | AI 创作画布 | 有 | 左右分栏 |
| 6 | `/settings` | 设置 | 有 | 模型/外观/存储/关于 |
| 7 | `/indexing` | 索引进度 | 有 | 批量索引可视化 |
| 8 | `/*` | 404 | 有 | 未匹配路由 |
| 9 | — | 错误页 | 无 | 不可恢复错误 |
