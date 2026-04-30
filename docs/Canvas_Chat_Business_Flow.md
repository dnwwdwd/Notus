# 创作页 Chat 全流程业务文档

> 更新时间：2026-04-30
> 适用范围：`/canvas` 页面当前已实现的大纲生成、创作对话、历史恢复、Agent 工具调用、块级修改与保存链路

---

## 1. 文档目标

本文只描述创作页当前真实实现的 chat 全流程，聚焦 6 个问题：

1. 创作页从“空白主题”与“现有文档”两种入口进入后，chat 能力如何开启。
2. 大纲生成和后续 AI 改写分别走哪条链路。
3. 当前轮会把哪些上下文送给模型。
4. Agent 工具调用与块级修改是如何编排的。
5. 创作历史会话为什么必须绑定正式文档。
6. 哪些内容会落库，哪些只存在于当前内存态。

---

## 2. 页面定位

创作页不是通用聊天页，而是“围绕当前文章做块级创作协作”的工作台。

当前产品口径如下：

- 左侧是文章块画布。
- 右侧是 AI 协作区。
- 当前文章必须是正式文档，才能继续 AI 改写与历史续聊。
- 未保存的大纲草稿只允许生成大纲，不允许建立稳定对话历史。
- 风格来源保留前台可见控制；事实上下文由后台自动补充。
- AI 输出的修改不会直接落盘，而是先变成可应用的 `operation`。

---

## 3. 参与模块

### 3.1 前端页面

- [canvas.js](/home/burger/Documents/projects/Notus/notus/pages/canvas.js)

负责：

- 创作入口态与编辑态切换
- 当前文章装载
- 大纲生成请求
- 创作对话请求
- 历史会话列表
- `operation` 预览与应用

### 3.2 后端 API

- [agent/outline.js](/home/burger/Documents/projects/Notus/notus/pages/api/agent/outline.js)
- [agent/run.js](/home/burger/Documents/projects/Notus/notus/pages/api/agent/run.js)
- [agent/apply.js](/home/burger/Documents/projects/Notus/notus/pages/api/agent/apply.js)
- [articles/save.js](/home/burger/Documents/projects/Notus/notus/pages/api/articles/save.js)
- [conversations/index.js](/home/burger/Documents/projects/Notus/notus/pages/api/conversations/index.js)
- [[id].js](/home/burger/Documents/projects/Notus/notus/pages/api/conversations/[id].js)

### 3.3 核心库

- [agent.js](/home/burger/Documents/projects/Notus/notus/lib/agent.js)
- [prompt.js](/home/burger/Documents/projects/Notus/notus/lib/prompt.js)
- [retrieval.js](/home/burger/Documents/projects/Notus/notus/lib/retrieval.js)
- [conversations.js](/home/burger/Documents/projects/Notus/notus/lib/conversations.js)
- [diff.js](/home/burger/Documents/projects/Notus/notus/lib/diff.js)

---

## 4. 入口模式

创作页当前有两种进入方式。

### 4.1 从主题新建

用户直接进入 `/canvas`，看到 `CanvasEntry`：

- 输入主题
- 点击“生成大纲”
- 系统先生成文章块，再进入画布编辑态

这时初始文章只是内存态草稿，不是正式文档。

### 4.2 从现有文档进入

用户可以通过两条路径进入：

1. 文件页编辑器里的“AI 创作”按钮
2. 侧边栏在创作页直接点击某篇文档

进入后前端会加载该文档内容，服务端把 Markdown 转成文章块，随后进入画布编辑态。

---

## 5. 页面初始化与文章装载

### 5.1 空白进入

如果当前没有 `article`，创作页停留在入口态：

- 展示主题输入
- 展示最近创作入口
- 如果 AI readiness 未满足，则整页锁定

### 5.2 带文档进入

如果当前工作区存在 `activeFile`，前端会调用：

- `GET /api/articles/:id`

优先读取服务端结构化文章数据。

如果结构化失败，则回退到：

- `GET /api/files/:id`

再按原始段落生成 fallback blocks。

### 5.3 装载后的前端状态

一旦文章装载完成，前端会同步初始化：

- `article`
- `blocks`
- `messages`
- `activeConversationId`
- `pendingOp`
- `saveState`

如果这是一个已保存文档，还会继续触发对应历史会话加载。

---

## 6. AI 能力的两条链路

创作页的 chat 相关流程分成两条不同链路：

1. 大纲生成链路
2. 正式创作对话链路

它们共享一部分上下文，但目标和输出形式不同。

---

## 7. 大纲生成链路

### 7.1 触发时机

当用户在入口态输入主题并点击“生成大纲”时，前端调用：

- `POST /api/agent/outline`

### 7.2 前端发送的请求

当前请求体包含：

- `topic`
- `active_file_id`
- `style_mode`
- `style_file_ids`

当前版本不再从前台显式发送事实参考配置。

### 7.3 服务端编排顺序

`/api/agent/outline` 当前会依次做：

1. `ensureRuntime()`
2. 读取当前文档摘要 `summarizeCurrentDocument(getFileById(activeFileId))`
3. 调用 `retrieveKnowledgeContext(topic, ...)` 做当前轮事实检索
4. 调用 `loadStyleSamples(topic, ...)` 组织风格样本
5. 调用 `buildOutlinePrompt(...)`
6. 用 `completeChat(...)` 让 LLM 生成大纲 JSON
7. 如果 JSON 解析失败，则使用 fallback 大纲

### 7.4 SSE 事件

大纲生成返回的核心事件是：

- `block`
- `done`
- `error`

前端会边收 `block` 边把大纲块追加到左侧画布，因此用户能看到大纲逐块出现。

### 7.5 大纲生成后的状态

生成完成后：

- 左侧已经有 `blocks`
- `article` 仍可能只是内存态草稿
- 此时还不能继续稳定聊天历史

---

## 8. 为什么未保存草稿不能继续正式 chat

### 8.1 当前产品边界

创作页当前明确要求：

- 大纲可以先生成
- 但如果还没有正式 `file_id`
- 就不能继续 AI 改写和历史续聊

### 8.2 原因

当前实现中，创作历史会话是按：

- `kind=canvas`
- `file_id`

来稳定绑定的。

如果允许未保存草稿继续长期对话，会带来 3 个问题：

1. 草稿身份不稳定
2. 旧库兼容复杂
3. 保存后会话迁移逻辑更容易出错

因此现在的策略是：

- 先生成大纲
- 用户保存成正式文档
- 再开放正式创作 chat

对应实现：

- [canvas.js](/home/burger/Documents/projects/Notus/notus/pages/canvas.js)
- [agent/run.js](/home/burger/Documents/projects/Notus/notus/pages/api/agent/run.js)

---

## 9. 文章保存与正式会话绑定

### 9.1 保存动作

用户在创作页点击保存时，前端调用：

- `POST /api/articles/save`

提交内容包含：

- `article`
- `blocks`

### 9.2 保存结果

保存成功后，服务端会返回正式 `file_id`。

前端随后会：

- 更新 `article.fileId`
- 切换 `saveState`
- 刷新文件树
- 将当前文章绑定到正式文档

### 9.3 保存后的能力变化

只要拿到正式 `file_id`：

- 历史对话按钮可用
- 新建对话按钮可用
- `InputBar` 解锁
- 后续所有创作会话都稳定绑定到这篇文档

---

## 10. 创作页历史会话流程

### 10.1 会话列表口径

创作页会话列表默认按：

- `kind=canvas`
- `file_id = 当前文章 file_id`

读取。

前端调用：

- `GET /api/conversations?kind=canvas&file_id=...&limit=20`

如果当前文章还只是草稿，则不读取正式会话列表。

### 10.2 页面初始化时的恢复逻辑

当文章已保存后，创作页会：

1. 读取当前文章的会话列表
2. 若存在历史，则默认加载最新一条
3. 将其消息恢复到右侧消息区

### 10.3 用户切换旧会话

用户在 `ConversationDrawer` 中点击旧会话时，前端会：

1. 中止当前请求
2. 读取 `GET /api/conversations/:id`
3. 恢复消息列表
4. 清空当前 `pendingOp`
5. 切换 `activeConversationId`

### 10.4 新建对话

点击“新建对话”时，前端不会立刻建库，而是先把本地状态清空：

- `activeConversationId = null`
- `messages = []`
- `pendingOp = null`

真正的会话会在下一次发送创作指令时由后端 `ensureConversation(...)` 创建。

---

## 11. 正式创作 chat 请求流程

### 11.1 前端发送前的校验

用户在右侧输入框发送指令前，前端会先检查：

1. 当前文章是否已保存为正式文档。
2. 是否存在已测试通过的 LLM 配置。
3. 是否有旧请求需要先中止。

### 11.2 前端请求体

当前创作 chat 请求发送到：

- `POST /api/agent/run`

请求体包含：

- `conversation_id`
- `user_input`
- `llm_config_id`
- `active_file_id`
- `article`
- `style_mode`
- `style_file_ids`

其中最关键的是：

- `article` 会把当前整篇文章块直接传给后端
- 不只是传一个 `file_id`

---

## 12. 服务端收到创作请求后的编排顺序

### 12.1 基础检查

`/api/agent/run` 会先验证：

- `user_input` 必填
- `article.blocks` 必填
- `article.file_id` 必须存在

如果 `file_id` 不存在，会直接拒绝，提示先保存当前创作。

### 12.2 会话创建或续写

随后调用：

- `ensureConversation({ kind: 'canvas', fileId: articleFileId, ... })`

这意味着创作对话当前一定绑定正式文档。

### 12.3 历史读取与用户消息落库

和知识库页类似，服务端会先：

1. 读取最近 `12` 条 `user/assistant` 历史
2. 把当前用户指令先写入 `messages`

这里同样要区分两层：

- `12` 条是原始读取上限
- 不是最终一定原样发给模型的入模条数

注意：

- 写入的是普通文本消息
- 不是把对话本身向量化成知识库索引

---

## 13. 创作页当前轮上下文组成

创作页并不是简单的“12 条历史 + 当前问题 + RAG”，也不再是“整篇文章全量直传”，而是预算感知下的复合上下文。

当前一轮真正送给模型的主要内容有：

1. 最近少量原始 `user/assistant` 历史
2. 当前用户指令
3. 必要时附带的更早对话摘要
4. 当前文章的“相关块包”，而不是默认整篇文章
5. 当前轮事实检索结果
6. 当前轮风格样本
7. 如果模型再调用工具，还会追加工具返回结果

所以创作页本质上是：

- 有限历史
- 请求内摘要
- 相关块内联
- RAG 事实补充
- 风格样本补充
- 工具循环

---

## 14. 当前轮事实检索链路

### 14.1 事实检索入口

`runAgent(...)` 内部一开始就会调用：

- `retrieveKnowledgeContext(userInput, ...)`

这代表创作页也会在当前轮基于用户指令做一次事实检索。

### 14.2 当前文档的作用

如果存在 `activeFileId`，事实检索会优先提高当前文档相关 chunk 的召回优先级。

### 14.3 前台与后台边界

当前版本中：

- 前台不再展示事实参考配置
- 但后台仍然会自动做事实上下文补充

也就是说：

- 事实链路还在
- 只是从“用户手动配置事实范围”收口成“系统后台自动补充”

---

## 15. 风格来源链路

### 15.1 风格来源为什么保留前台配置

当前产品口径认为：

- 事实应该尽量低摩擦，后台自动补充
- 风格是更主观的表达控制，适合保留用户可见入口

### 15.2 风格来源当前两种模式

#### 自动模式

系统会：

1. 优先从当前文档相近内容中取样
2. 再补充全局相似样本

#### 手动模式

系统只在用户指定文章范围内检索风格样本。

### 15.3 风格样本如何进入 Prompt

风格样本最终会整理成 `styleSamplesText`，作为 system prompt 的“风格参考”输入。

约束是：

- 只能学习表达方式
- 不能把风格样本当事实来源

对应实现：

- [prompt.js](/home/burger/Documents/projects/Notus/notus/lib/prompt.js)
- [agent.js](/home/burger/Documents/projects/Notus/notus/lib/agent.js)

---

## 16. Agent Prompt 与工具循环

### 16.1 初始 Prompt 组成

创作 Agent 的初始消息由 4 到 5 部分组成：

1. system prompt
2. 最近少量历史
3. 必要时附带的更早对话摘要
4. 当前文章相关块列表
5. 当前轮用户指令 JSON

system prompt 中会明确写入：

- 当前相关块的真实 `block_id`
- `@bN -> block_id` 的引用关系
- 当前轮事实参考文本
- 当前轮风格参考文本
- 当前文章标题与相关标题路径
- 可调用工具清单
- 修改必须带 `old` 字段

### 16.2 可调用工具

当前工具链包括：

- `search_knowledge`
- `get_style_samples`
- `get_outline`
- `draft_block`
- `expand_block`
- `shrink_block`
- `polish_style`
- `insert_block`
- `delete_block`

### 16.3 工具循环

`runAgent(...)` 当前最多允许 4 轮工具循环。

每一轮里：

1. 先调用 `completeChat(...)`
2. 如果模型返回 `tool_calls`
3. 依次执行工具
4. 把工具结果以 `tool` 消息回填到对话历史
5. 再进入下一轮推理

### 16.4 工具结果对上下文的影响

工具执行后，服务端会把结果写回当前轮上下文：

- 新的事实 chunk 会追加到 `citations`
- 新的风格样本会刷新 `styleSamples`
- 新生成的修改会累积到 `operations`

所以创作页不是“只检索一次就结束”，而是允许模型在当前轮中继续搜、继续改。

---

## 17. 块级约束与 `@bN` 引用

### 17.1 当前块引用机制

前端会把当前文章块映射成：

- `@b1`
- `@b2`
- `@b3`

这种引用 token。

### 17.2 用户点名块后的约束

如果用户输入里明确写了 `@b2` 之类的块引用：

- 后端会解析出允许修改的 `block_id` 白名单
- Agent 只能修改这些块
- 不能顺带改其他块

这是创作页“定向改写”最关键的业务边界之一。

---

## 18. SSE 事件流

### 18.1 服务端输出事件

创作 chat 当前核心事件有：

- `thinking`
- `tool_call`
- `tool_result`
- `operation`
- `done`
- `error`

### 18.2 前端消费方式

#### `thinking`

- 右侧显示“正在分析你的创作请求…”

#### `tool_call`

- 右侧流式文本切换为“正在调用工具：...”

#### `tool_result`

- 右侧流式文本切换为“工具执行完成，正在生成修改…”

#### `operation`

- 把当前修改变成一个 `pendingOp`
- 同时在消息区插入一条 assistant 消息，告诉用户“已生成可应用的修改”

#### `done`

- 如果本轮没有 `operation`，则把最终自然语言回复写入消息区
- 如果有 `operation`，则主要依赖前面的预览消息
- 同时刷新会话列表与活动会话 id
- 同时返回 `usage / budget / compacted`

#### `error`

- 结束 loading
- 在必要时保留 `conversation_id`
- 确保用户还能恢复出错前后的这条会话

---

## 19. `operation` 预览与应用链路

### 19.1 为什么不直接改文章

创作页当前不允许模型直接把修改落盘到 Markdown 文件。

当前设计要求：

- 先产出结构化 `operation`
- 再交给用户决定是否应用

### 19.2 `operation` 的主要内容

每条修改至少会带：

- `op`
- `block_id`
- `old`
- `new`

其中 `old` 用于乐观锁校验，避免块内容已变时误改错误位置。

### 19.3 用户点击“应用”

当用户确认应用时，前端调用：

- `POST /api/agent/apply`

服务端会使用 diff 引擎校验并返回更新后的内存文章结构。

### 19.4 应用后的结果

应用成功后：

- 左侧 `blocks` 更新
- `pendingOp` 清空
- `saveState = dirty`

注意：

- 这一步仍然只是改内存中的文章结构
- 还没有落盘
- 真正写回 Markdown 文件仍然要走“保存文章”

---

## 20. 创作消息落库范围

### 20.1 会写入数据库的内容

创作 chat 当前会写库的内容包括：

- `conversations`
- `messages`
- assistant 消息附带的 `citations`

### 20.2 不会写入知识库向量库的内容

以下内容不会自动进入知识库向量索引：

- 用户创作指令
- AI 回复文本
- `operation` 预览消息

### 20.3 真正进入知识库向量库的时机

只有当用户把文章保存为正式 Markdown 文档后，后续索引流程才会把文章 chunk 写入：

- `chunks`
- `chunks_vec`
- `chunks_fts`

也就是说，创作 chat 本身不是知识库索引来源；保存后的文档内容才是。

---

## 21. 当前上下文口径

创作页当前一轮正式 chat 可概括为：

- 最多最近 12 条原始历史的读取窗口
- 入模时保留的最近少量原始历史
- 必要时附带的更早对话摘要
- 当前用户指令
- 当前文章的相关块包
- 当前轮事实检索
- 当前轮风格样本
- 工具调用增量结果

这也是为什么创作页对“当前文章存在且已保存”的依赖远比知识库页更强。

---

## 22. 当前边界与限制

### 22.1 当前已实现边界

- 未保存草稿可以生成大纲，但不能稳定续聊。
- 创作历史严格绑定正式文档。
- 模型可以多轮调用工具，但最多 4 轮。
- 用户可通过 `@bN` 将修改范围收束到特定块。
- 修改先预览、再应用、最后由用户手动保存落盘。

### 22.2 当前未实现内容

- 不会把请求内摘要回写为长期摘要记忆。
- 不会把创作 chat 消息自动向量化成知识库材料。
- 不会在未保存草稿阶段维护正式历史分桶。
- 不会自动替用户把 `operation` 直接写回文件系统。

---

## 23. 关键结论

创作页 chat 当前真实业务流可以收束成一句话：

用户先基于主题或现有文档进入块级画布，保存为正式文档后，系统再围绕“当前文章块 + 有限历史 + 当前轮事实补充 + 风格样本 + 工具循环”运行创作 Agent，把结果先产出为可审阅的块级修改，而不是直接替用户改写落盘。
