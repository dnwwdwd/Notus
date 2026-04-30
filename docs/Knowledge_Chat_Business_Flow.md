# 知识库页 Chat 全流程业务文档

> 更新时间：2026-04-30
> 适用范围：`/knowledge` 页面当前已实现的问答、历史会话、RAG 检索、来源定位与落库链路

---

## 1. 文档目标

本文只描述知识库页当前真实实现的 chat 全流程，不讨论理想方案。重点回答 5 个问题：

1. 用户在知识库页发起一次提问时，前端和服务端分别做了什么。
2. 当前轮回答使用了哪些上下文。
3. RAG 检索是如何触发、如何组织证据、如何返回给前端的。
4. 历史会话如何读取、续写、恢复与持久化。
5. 来源卡片点击后，为什么能留在知识库页完成原文定位。

---

## 2. 页面定位

知识库页承担的是“基于个人知识库问答”的工作流，而不是通用聊天页。

当前产品口径如下：

- 右侧是问答区，支持多轮对话、历史恢复和新建对话。
- 左侧是可选的文章编辑区，只有选中文档后才展开。
- 当前打开文档只影响优先检索和手动参考范围，不切换右侧聊天历史。
- 回答必须建立在知识库证据之上；证据不足时要保守回答。
- 来源卡片点击后留在知识库页完成原文定位，不跳文件页。

---

## 3. 参与模块

### 3.1 前端页面

- [knowledge.js](/home/burger/Documents/projects/Notus/notus/pages/knowledge.js)

负责：

- 页面状态维护
- 历史会话加载与切换
- 用户问题提交
- SSE 事件消费
- 左侧文档编辑区展示
- 来源点击后的引用定位状态下发

### 3.2 后端 API

- [chat.js](/home/burger/Documents/projects/Notus/notus/pages/api/chat.js)
- [conversations/index.js](/home/burger/Documents/projects/Notus/notus/pages/api/conversations/index.js)
- [[id].js](/home/burger/Documents/projects/Notus/notus/pages/api/conversations/[id].js)

负责：

- 新增或续写知识库会话
- 读取历史消息
- 组织 RAG 检索
- 构造 Prompt
- 流式返回 token 与来源

### 3.3 核心库

- [conversations.js](/home/burger/Documents/projects/Notus/notus/lib/conversations.js)
- [retrieval.js](/home/burger/Documents/projects/Notus/notus/lib/retrieval.js)
- [prompt.js](/home/burger/Documents/projects/Notus/notus/lib/prompt.js)
- [documentNavigation.js](/home/burger/Documents/projects/Notus/notus/utils/documentNavigation.js)

---

## 4. 页面入口与前置条件

### 4.1 页面初始化

用户进入 `/knowledge` 后，前端会先完成 3 组初始化：

1. 读取 AI readiness，决定页面是否可发送问题。
2. 读取知识库历史会话列表。
3. 如果当前工作区已有 `activeFile`，则同时加载左侧文档内容。

对应实现：

- [knowledge.js](/home/burger/Documents/projects/Notus/notus/pages/knowledge.js)

### 4.2 历史会话初始化口径

知识库页历史只按 `kind=knowledge` 读取，不再按 `file_id` 分桶。

这意味着：

- 打开 A 文档提问
- 再切到 B 文档继续提问
- 仍然处于同一类知识库历史空间

当前文档只影响检索优先级，不影响会话列表归属。

---

## 5. 会话列表与历史恢复流程

### 5.1 会话列表读取

前端初始化时调用：

- `GET /api/conversations?kind=knowledge&limit=20`

服务端通过 [conversations/index.js](/home/burger/Documents/projects/Notus/notus/pages/api/conversations/index.js) 转到 [conversations.js](/home/burger/Documents/projects/Notus/notus/lib/conversations.js) 的 `listConversations()`。

当前返回的数据包含：

- `id`
- `kind`
- `title`
- `message_count`
- 最近一条消息的 `preview`
- `updated_at`

### 5.2 默认恢复逻辑

如果历史列表非空，知识库页会自动读取最新一条会话详情：

- `GET /api/conversations/:id`

然后把完整 `messages` 映射到页面消息列表中。

### 5.3 用户主动切换旧会话

用户打开右侧 `ConversationDrawer` 后，点击某条旧会话时：

1. 前端先中止当前正在流式输出的请求。
2. 读取该会话详情。
3. 用历史消息覆盖当前消息区。
4. 将 `activeConversationId` 切换到目标会话。

---

## 6. 用户发送问题的完整流程

### 6.1 前端发起前的校验

用户在底部 `InputBar` 提交问题时，前端先检查：

1. 是否存在已测试通过的 LLM 配置。
2. 页面当前是否处于可发送状态。
3. 如果有旧请求在进行，先 `abort`。

随后前端立即做本地状态更新：

- `loading = true`
- `retrievalStage = 'searching'`
- 本地先插入一条用户消息
- 清空当前流式文本缓存 `streamText`

### 6.2 实际发送的请求

前端调用：

- `POST /api/chat`

请求体当前包含：

- `conversation_id`
- `query`
- `llm_config_id`
- `active_file_id`
- `reference_mode`
- `reference_file_ids`

说明：

- `conversation_id` 为空时，代表从“新对话”开始。
- `active_file_id` 仅用于“当前文档优先检索”。
- `reference_mode=manual` 时，后端只在指定文档范围内检索。

对应实现：

- [knowledge.js](/home/burger/Documents/projects/Notus/notus/pages/knowledge.js)

---

## 7. 服务端收到问题后的编排顺序

### 7.1 运行时检查

`/api/chat` 首先调用 `ensureRuntime()`，确保数据库、配置和运行环境可用。

对应实现：

- [chat.js](/home/burger/Documents/projects/Notus/notus/pages/api/chat.js)

### 7.2 会话创建或续写

服务端会先调用 `ensureConversation(...)`：

- 如果带了已有 `conversation_id`，则续写这条会话
- 否则新建一条 `kind=knowledge` 的会话

注意：

- 当前知识库新会话不会绑定 `file_id`
- 也不会因为当前选中了某篇文档就把历史切桶

### 7.3 历史消息读取

服务端随后会取最近 `12` 条历史消息：

- 通过 `getConversationHistory(conversation.id, { limit: 12 })`

这里要注意两层口径：

- `12` 条是“原始读取上限”
- 不是“必然原样全量发给模型”

真正入模前，系统还会根据当前模型预算决定是否压缩更早历史。

在未触发 compact 时，回灌给模型的历史只有：

- `role`
- `content`

不会把 `citations`、检索分数、来源元数据整段重新塞回模型。

### 7.4 当前用户消息落库

在真正检索前，当前轮用户问题会先写入 `messages` 表：

- `role = user`
- `content = query`

这是普通文本落库，不会把问题写进知识库向量表。

---

## 8. 当前轮 RAG 检索链路

### 8.1 “每轮现算”的真实含义

知识库页的 RAG 是当前轮检索，不是把整段历史会话持久化成向量记忆。

每次用户发问时，系统都会重新做一遍：

1. 生成当前 query 的临时 embedding
2. 查已有知识库索引
3. 组织本轮证据
4. 把这轮证据喂给 LLM

问题与回答本身不会被写入 `chunks_vec`。

### 8.2 追问扩展

如果当前问题像：

- `继续`
- `为什么`
- `那这个呢`

后端会先基于最近几条用户问题拼一个 `effectiveQuery`，再拿它去检索。

这意味着：

- 检索会受当前对话上下文影响
- 但本质仍然是“本轮重新检索”

### 8.3 检索入口

后端调用：

- `retrieveKnowledgeContext(effectiveQuery, ...)`

对应实现：

- [retrieval.js](/home/burger/Documents/projects/Notus/notus/lib/retrieval.js)

### 8.4 检索内部步骤

当前混合检索流程可以概括为：

1. 对 query 临时调用 `getEmbedding(query)` 生成查询向量。
2. 用查询向量查 `chunks_vec` 向量表。
3. 用 query 文本查 `chunks_fts` 全文索引。
4. 必要时查 `images_vec` 图片向量。
5. 用 RRF 融合不同召回结果。
6. 对当前打开文档做额外优先加权。
7. 生成最终 `chunks` 列表。
8. 基于 `chunks` 聚合 `sections` 章节证据组。
9. 计算 `stats` 与 `sufficiency`。

### 8.5 当前文档的作用

如果前端传了 `active_file_id`，检索会优先做一轮“当前文档内召回”，并给这些结果附加优先分。

因此：

- 当前文档会更容易成为回答证据
- 但它不是唯一范围
- 除非用户显式切换到了手动参考模式

### 8.6 手动参考模式

当 `reference_mode=manual` 时：

- 检索只在 `reference_file_ids` 指定文档范围内进行

这是知识库页目前唯一的“强约束检索范围”入口。

---

## 9. Prompt 组装逻辑

### 9.1 Prompt 输入组成

知识库问答的 Prompt 当前由 3 到 4 部分组成：

1. `system`
2. 最近若干条原始 `user/assistant` 历史
3. 必要时附带一段“更早对话摘要”
4. 当前轮带证据的 `user` 消息

对应实现：

- [prompt.js](/home/burger/Documents/projects/Notus/notus/lib/prompt.js)

### 9.2 System 约束

当前 system prompt 明确要求：

- 只能根据提供证据回答
- 证据不足时直接说不知道或说明依据不足
- 回答风格自然、直接、克制、务实
- 不固定套用“结论 / 整理 / 证据”模板
- 如果给出了“更早对话摘要”，它只能当会话记忆，不能压过当前证据

### 9.3 当前轮用户消息中携带的信息

除了原始问题，当前轮用户消息还会注入：

- 扩展后的 `effectiveQuery`
- `sufficiency`
- `stats`
- `sections`
- `chunks`

也就是说，模型看到的并不是“裸问题”，而是“问题 + 当前轮完整检索证据包”。

### 9.4 上下文预算与自动 compact

从 2026-04-30 起，知识库页发送前会先读取当前 LLM 配置中的：

- `context_window_tokens`
- `max_output_tokens`

再决定是否触发自动 compact。

当前自动裁剪顺序是：

1. 先压掉原始 `chunks`
2. 再缩减 `sections`
3. 再把更早历史压成请求内摘要
4. 最后只保留更少的最近原始历史

注意：

- 这里的摘要只存在于当前请求
- 不会回写 `messages`
- 不会生成新的知识库索引

---

## 10. SSE 事件流

### 10.1 服务端事件类型

知识库页当前使用统一 SSE 输出，核心事件有：

- `chunks`
- `token`
- `usage`
- `citations`
- `done`
- `error`

### 10.2 前端对应的消费方式

前端当前把这些事件映射成以下状态机：

#### `chunks`

- 更新 `retrievalStage`
- 如果 `sufficiency=false`，前端会显示“证据不足”的检索状态

#### `token`

- 把流式文本拼接到 `streamText`
- 关闭检索阶段提示

#### `citations`

- 缓存本轮来源卡片数据

#### `usage`

- 返回本轮 `usage / budget / compacted`
- 供前端或日志系统感知当前是否触发了自动压缩

#### `done`

- 组装最终 assistant 消息
- 将消息推入消息列表
- 刷新历史会话列表
- 清理 loading 状态

#### `error`

- 结束当前 loading
- 在必要时仍保留 `conversation_id`
- 让前端后续还能恢复这条出错会话

---

## 11. 回答生成与落库

### 11.1 证据不足兜底

如果：

- `chunks.length === 0`
- 或 `sufficiency === false`

后端不会调用 LLM 自由发挥，而是直接走保守兜底回答。

### 11.2 正常生成

如果证据足够：

1. 服务端根据 `llm_config_id` 解析出当前 LLM 运行配置。
2. 根据该配置的上下文预算组装 Prompt。
3. 如有必要，先自动 compact 历史和证据包。
4. 调用 `streamChat(...)` 开始流式生成。

### 11.3 assistant 消息落库

本轮完成后，服务端会把 assistant 消息写入 `messages` 表：

- `role = assistant`
- `content = answer`
- `citations = 本轮来源列表`

这里的 `citations` 会持久化，后续用户恢复旧会话时，可以直接重新看到当时的来源卡片。

---

## 12. 来源卡片点击后的链路

### 12.1 前端动作

用户点击来源卡片后，知识库页不会跳转到 `/files`，而是：

1. 根据 `citation.file_id` 找到目标文件
2. 组装 `pendingCitation`
3. 打开或保持左侧编辑区
4. 调用 `selectFile(targetFile, { pendingCitation })`

### 12.2 工作区共享状态

`pendingCitation` 会进入全局工作区状态，因此：

- 知识库页可以消费它
- 文件页也可以消费同样的引用定位目标

### 12.3 编辑器 ready 后消费定位

知识库页当前修正后的逻辑是：

1. 等目标文档内容加载完成
2. 等目标编辑器 ready
3. 再消费 `pendingCitation`
4. 调用 `focusCitationTarget(...)`
5. 保持高亮直到用户手动关闭

这也是当前知识库来源点击能稳定完成“打开文档 + 首次定位 + 持续高亮”的原因。

---

## 13. 数据持久化范围

### 13.1 会写入数据库的内容

知识库 chat 当前会写库的内容只有：

- `conversations`
- `messages`
- `messages.citations`

### 13.2 不会写入知识库向量库的内容

以下内容不会被当作知识库 chunk 再次索引：

- 用户问题
- AI 回复
- 历史会话文本

知识库向量库里的数据仍然来自 Markdown 文档索引结果，而不是对话消息。

---

## 14. 当前上下文口径

知识库页当前一轮问答使用的上下文可以概括为：

- 最多最近 12 条原始历史的读取窗口
- 入模时保留的最近若干条原始历史
- 必要时附带的更早对话摘要
- 当前用户问题
- 扩展后的 `effectiveQuery`
- 当前轮 RAG 的 `sections`
- 在预算允许时附带的 `chunks`
- 当前文档优先权重

因此它不是“纯聊天”，也不是“纯检索问答”，而是“有限历史 + 请求内摘要 + 当前轮检索证据”的混合链路。

---

## 15. 当前边界与限制

### 15.1 当前已实现边界

- 历史会话支持恢复，但“最近 12 条”只是原始读取上限，真正入模会受预算控制。
- 来源卡片支持持久高亮，但高亮是页内行为，不会跨刷新恢复。
- 当前文档只做优先召回，不控制历史归属。
- 手动参考模式只影响检索范围，不改变会话结构。
- 当前 LLM 配置会持久化上下文窗口和默认输出上限。

### 15.2 当前未实现内容

- 不会把历史问答自动沉淀成新的知识库索引。
- 不会把请求内摘要回写成长期记忆。
- 不会把整条历史会话再次向量化后参与下一轮检索。
- 不提供跨会话共享的自动总结压缩机制。

---

## 16. 关键结论

知识库页 chat 当前真实业务流可以收束成一句话：

用户在右侧发问后，系统会基于最近有限历史和当前轮即时 RAG 检索组织答案，并把结果连同来源卡片写回全局知识库会话；当用户点击来源时，页面留在知识库页内部直接展开左侧文档并完成原文定位与持续高亮。
