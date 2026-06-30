# Agent Loop 输入边界修复实施文档

## 目标

修复 Agent Loop 中“用户本轮输入”和“执行上下文”混用导致的副作用误触发问题。

当前问题表现为：

1. 用户本轮没有输入 URL，但当前打开文档里有 URL，Agent Loop 仍触发网页解析。
2. 用户只上传 PDF，没有明确说明用途，Agent 过早把附件关联到上一轮写作任务。
3. `ask_question_card` 在本轮意图不明确时被过早触发。
4. `goal` 同时承担用户输入、执行目标、工作区上下文、历史上下文、输入源解析文本，职责混乱。

本次改造重点在 Harness 层，Prompt 只做补充限制。

------

## 核心原则

所有会触发副作用的预处理，只能基于用户本轮显式输入和本轮附件。

副作用包括：

- URL 自动提取
- URL 正文解析
- 附件解析
- 自动写入当前文档
- 自动关联上一轮任务
- 结构化提问卡片触发

不得从以下内容中提取 URL 或推断附件用途：

- 当前打开文档内容
- 当前块快照
- 当前文章路径
- 历史任务
- 历史对话
- Agent 内部拼装后的完整 `goal`

------

## 一、前端请求结构改造

### 需要检查的文件

先搜索以下关键词定位代码：

```bash
rg "agent/loop/start"
rg "display_query"
rg "goal"
rg "当前打开文档"
rg "当前创作页文本块快照"
rg "attachments"
```

重点检查：

- 创作页 Agent Loop 启动入口
- 构造 `goal` 的函数
- 发送 `/api/agent/loop/start` 的请求体
- 附件上传后进入 Agent Loop 的逻辑

### 修改请求体

前端调用 `/api/agent/loop/start` 时，请求体至少包含以下字段：

```ts
{
  goal: string
  user_query: string
  display_query?: string
  attachments?: AgentAttachment[]
  workspace_context?: {
    current_doc_title?: string
    current_doc_path?: string
    current_blocks_snapshot?: string
    selected_block_ids?: string[]
  }
}
```

字段含义：

```ts
goal
```

Agent 执行目标，可以继续包含当前文档、路径、块快照等上下文。

```ts
user_query
```

用户本轮输入框里的原始文本。只包含用户本轮真实提交的文字。不要拼接当前文档、历史记录、块快照、路径、附件解析结果。

```ts
display_query
```

展示给用户看的文本。若已有该字段，可保留。

```ts
attachments
```

仅包含本轮上传、拖入、粘贴、长文本转出的附件。

```ts
workspace_context
```

工作区上下文，只给 Agent 推理和执行参考，不能给输入源解析器使用。

### 前端构造要求

如果用户输入：

```text
根据我的笔记生成一个文档介绍我自己
```

当前文档中有 URL，请求体应类似：

```json
{
  "user_query": "根据我的笔记生成一个文档介绍我自己",
  "display_query": "根据我的笔记生成一个文档介绍我自己",
  "goal": "用户任务：根据我的笔记生成一个文档介绍我自己\n\n当前打开文档：...\n当前创作页文本块快照：...",
  "attachments": [],
  "workspace_context": {
    "current_doc_path": "...",
    "current_blocks_snapshot": "..."
  }
}
```

`user_query` 中不能出现当前文档里的 URL，除非 URL 是用户本轮输入的。

------

## 二、后端 `/api/agent/loop/start` 改造

### 需要检查的文件

先搜索：

```bash
rg "parseAgentInputSources"
rg "loop/start"
rg "body.goal"
rg "display_query"
rg "conversationId"
```

重点检查：

- Agent Loop start 接口
- Session 创建逻辑
- 输入源解析逻辑
- 附件解析逻辑

### 当前错误写法

如果存在类似代码：

```js
parseAgentInputSources({
  conversationId,
  attachments: body.attachments || [],
  text: goal,
})
```

需要修改。

### 正确写法

```js
const userInputText =
  body.user_query ??
  body.input_text ??
  body.display_query ??
  ''

const parsedSources = await parseAgentInputSources({
  conversationId,
  attachments: body.attachments || [],
  text: userInputText,
})
```

要求：

1. `parseAgentInputSources()` 只能接收用户本轮输入文本。
2. 禁止传入完整 `goal`。
3. 禁止传入当前文档快照。
4. 禁止传入历史对话拼接文本。
5. 附件仍然使用 `body.attachments`，但必须确认只包含本轮附件。

### 兼容旧客户端

如果旧前端暂时没有传 `user_query`，后端按以下顺序兼容：

```js
body.user_query
body.input_text
body.display_query
''
```

不要 fallback 到 `goal`。

如果没有 `user_query`，且只有 `goal`，URL 解析应跳过。

------

## 三、URL 解析边界

### 修改目标

URL 解析只扫描用户本轮输入。

### 需要调整的行为

场景一：

```json
{
  "user_query": "根据我的笔记生成一个文档介绍我自己",
  "goal": "当前文档内容包含 https://example.com"
}
```

结果：

```text
不解析 https://example.com
```

场景二：

```json
{
  "user_query": "总结这个链接 https://example.com",
  "goal": "用户任务：总结这个链接 https://example.com ..."
}
```

结果：

```text
解析 https://example.com
```

### 建议增加保护

在 `parseAgentInputSources()` 内部增加参数名约束，避免后续误传：

```ts
type ParseAgentInputSourcesParams = {
  conversationId: string
  attachments: AgentAttachment[]
  userInputText: string
}
```

把原来的 `text` 改名为 `userInputText`。

如果改动范围太大，可以暂时保留 `text`，但在调用处加注释：

```js
// 注意：这里只能传用户本轮原始输入，不能传 goal、文档快照或历史上下文。
```

------

## 四、附件意图路由

### 需要新增的判断

当本轮有附件时，先判断用户是否明确表达写入或改写意图。

建议新增函数：

```ts
function hasExplicitDocumentWriteIntent(text: string): boolean {
  const normalized = (text || '').trim()

  if (!normalized) return false

  const patterns = [
    /加入.*文档/,
    /加到.*文档/,
    /写入.*文档/,
    /更新.*文档/,
    /修改.*文档/,
    /改写.*文档/,
    /补充.*文档/,
    /根据.*附件.*写/,
    /根据.*PDF.*写/,
    /参考.*附件.*改/,
    /参考.*PDF.*改/,
    /用.*附件.*更新/,
    /用.*PDF.*更新/,
    /把.*PDF.*加/,
    /把.*附件.*加/,
    /合并.*文档/,
    /整理进.*文档/
  ]

  return patterns.some((pattern) => pattern.test(normalized))
}
```

如果项目里已有 intent classifier，优先接入已有分类器，但必须保证规则结果可测试。

### 本轮只有附件且没有文字

请求类似：

```json
{
  "user_query": "",
  "attachments": [
    {
      "name": "xxx.pdf"
    }
  ]
}
```

默认行为：

```text
解析并总结附件内容
```

禁止行为：

```text
不要直接问：要把 PDF 写到自我介绍文档哪里？
不要直接弹 ask_question_card 让用户选择写入位置。
不要直接继承上一轮写作任务。
```

### 本轮有附件，但没有明确写入意图

请求类似：

```json
{
  "user_query": "这个看一下",
  "attachments": [
    {
      "name": "xxx.pdf"
    }
  ]
}
```

默认行为：

```text
解析并总结附件内容，或普通询问用户希望如何处理。
```

允许普通澄清：

```text
你要我总结这份文件，还是用它修改当前文档？
```

不允许直接触发写入位置提问卡片。

### 本轮明确写入

请求类似：

```json
{
  "user_query": "把这个 PDF 加入当前自我介绍文档",
  "attachments": [
    {
      "name": "xxx.pdf"
    }
  ]
}
```

允许行为：

```text
解析附件
结合当前文档
必要时使用 ask_question_card 询问写入位置
执行文档修改
```

------

## 五、Agent Session 上下文结构调整

### 建议内部结构

在创建 Agent Session 时，把上下文拆成明确字段：

```ts
type AgentLoopSessionInput = {
  goal: string
  userQuery: string
  displayQuery: string
  attachments: AgentAttachment[]
  parsedSources: ParsedInputSource[]
  workspaceContext?: WorkspaceContext
  historyContext?: ConversationHistory[]
}
```

要求：

```ts
userQuery
```

只表示用户本轮输入。

```ts
parsedSources
```

只来自 `userQuery + attachments`。

```ts
workspaceContext
```

只作为参考，不触发预处理副作用。

```ts
historyContext
```

只辅助理解，不主动变成本轮任务。

------

## 六、Prompt 补充限制

找到 Agent Loop system prompt 或 planner prompt，搜索：

```bash
rg "ask_question_card"
rg "附件"
rg "历史"
rg "当前文档"
rg "信息不足"
```

增加以下约束：

```text
用户本轮输入优先于历史任务。历史上下文只能辅助理解，不能替代本轮明确指令。

如果本轮只有附件，且用户没有明确要求写入、更新、修改、合并当前文档，应默认读取并总结附件，或用普通文本询问用户用途。

只有当用户明确要求写入、更新、修改、合并当前文档，且缺少必要写入位置或结构选择时，才允许使用 ask_question_card。

不得因为历史任务中存在写作目标，就自动把本轮附件关联到历史写作任务。
```

不要只依赖 Prompt。Prompt 只是保险，主要修复必须在请求结构、解析入口和意图判断中完成。

------

## 七、`ask_question_card` 触发规则

新增或修改工具触发前置判断。

### 允许触发

满足以下条件之一才允许：

```ts
taskIsExplicit === true
missingRequiredStructuredFields === true
```

或：

```ts
userAskedToBeQuestionedFirst === true
```

或：

```ts
explicitDocumentWriteIntent === true
needWriteLocation === true
```

### 禁止触发

以下情况禁止直接触发：

```ts
onlyAttachmentNoText === true
hasAttachment === true && explicitDocumentWriteIntent === false
currentIntentUnknown === true
questionIsBasedOnlyOnHistoryTask === true
```

这种情况用普通文本澄清，或默认总结附件。

------

## 八、回归测试

需要新增测试或补充现有测试。

### 测试一：`goal` 包含 URL，`user_query` 不包含 URL

输入：

```json
{
  "user_query": "根据我的笔记生成一个文档介绍我自己",
  "goal": "用户任务：根据我的笔记生成一个文档介绍我自己\n当前文档：https://example.com",
  "attachments": []
}
```

期望：

```text
parseAgentInputSources 不调用 URL 解析
parsedSources 中没有 https://example.com
```

### 测试二：`user_query` 包含 URL

输入：

```json
{
  "user_query": "总结这个链接 https://example.com",
  "goal": "用户任务：总结这个链接 https://example.com\n当前文档：...",
  "attachments": []
}
```

期望：

```text
parseAgentInputSources 调用 URL 解析
parsedSources 中包含 https://example.com
```

### 测试三：当前块快照包含多个 URL

输入：

```json
{
  "user_query": "帮我整理当前文章",
  "goal": "当前创作页文本块快照：@b1 https://a.com @b2 https://b.com",
  "attachments": []
}
```

期望：

```text
不解析 https://a.com
不解析 https://b.com
```

### 测试四：本轮只上传 PDF，无文字

输入：

```json
{
  "user_query": "",
  "attachments": [
    {
      "name": "test.pdf",
      "type": "application/pdf"
    }
  ],
  "goal": "上一轮任务：写自我介绍文档"
}
```

期望：

```text
默认解析或总结 PDF
不触发 ask_question_card 询问写入位置
不自动关联上一轮自我介绍文档
```

### 测试五：上传 PDF 并明确加入当前文档

输入：

```json
{
  "user_query": "把这个 PDF 加入当前文档",
  "attachments": [
    {
      "name": "test.pdf",
      "type": "application/pdf"
    }
  ]
}
```

期望：

```text
允许解析 PDF
允许结合当前文档
缺少写入位置时允许触发 ask_question_card
```

### 测试六：旧客户端没有 `user_query`

输入：

```json
{
  "goal": "用户任务：整理文章\n当前文档：https://example.com",
  "attachments": []
}
```

期望：

```text
不从 goal 中解析 URL
不报错
Agent Loop 可以继续执行
```

------

## 九、验收标准

完成后必须满足：

1. 当前打开文档包含 URL，但用户本轮没有输入 URL 时，不触发网页解析。
2. 用户本轮明确输入 URL 时，仍正常解析网页正文。
3. 用户只上传 PDF 且没有文字指令时，默认总结或说明附件内容。
4. 用户只上传 PDF 时，不直接询问写入上一轮文档的位置。
5. 用户明确要求“加入当前文档”时，可以使用提问卡片确认写入位置。
6. 历史对话可以作为参考，但不得覆盖本轮输入。
7. 知识库页原有附件解析边界保持不变。
8. 旧客户端没有传 `user_query` 时，不得 fallback 到 `goal` 进行 URL 解析。

------

## 十、建议提交拆分

建议分成以下几个提交：

1. 前端请求体增加 `user_query`，保留 `goal`。
2. 后端 `parseAgentInputSources()` 改为只使用 `user_query/display_query`。
3. 增加附件意图判断，限制无指令附件默认行为。
4. 收紧 `ask_question_card` 触发条件。
5. 增加回归测试。
6. 补充 Agent Loop Prompt 约束。

------

## 十一、完成后自检命令

执行项目现有测试：

```bash
npm test
```

或：

```bash
pnpm test
```

再运行类型检查和构建：

```bash
pnpm typecheck
pnpm build
```

如果项目没有这些命令，检查 `package.json` 后选择对应命令。

最后用 `rg` 确认没有继续把完整 `goal` 传给输入源解析器：

```bash
rg "parseAgentInputSources"
rg "text:\s*goal"
rg "body\.goal"
```

必须确认 `parseAgentInputSources()` 的文本来源只来自：

```text
body.user_query
body.input_text
body.display_query
''
```

不得来自：

```text
goal
body.goal
workspace_context
current_blocks_snapshot
history
```