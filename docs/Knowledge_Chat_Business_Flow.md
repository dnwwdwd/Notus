# 知识库页 Chat 全流程业务文档

> 更新时间：2026-06-19
> 适用范围：`/knowledge` 页面当前已实现的问答、历史会话、单索引检索、条件改写/重排、回答模式、来源定位、写作类任务转 Agentic Loop 与落库链路

---

## 1. 文档目标

本文只描述知识库页当前真实实现的 chat 全流程，不讨论理想方案。重点回答 5 个问题：

1. 用户在知识库页发起一次提问时，前端和服务端分别做了什么。
2. 当前轮回答使用了哪些上下文。
3. RAG 检索是如何触发、如何组织证据、如何返回给前端的。
4. 历史会话如何读取、续写、恢复与持久化。
5. 来源卡片点击后，为什么能留在知识库页完成原文定位。

---

## 1.1 2026-05-02 单索引升级补充

本次升级保持“单索引 + 单次检索链路”的方向，不新增文档摘要索引、章节摘要索引和句级持久索引。新增的是请求级判断、辅助调用护栏和回答模式控制。

当前新增口径如下：

- 每次请求最多只允许 2 次业务级 LLM 调用：
  - `clarify_needed`：0 次
  - `no_evidence`：0 次
  - 普通回答：1 次
  - `rewrite + answer` 或 `rerank + answer`：2 次
- 同一轮不会同时触发 `rewrite` 和 `rerank`。
- 如果识别为需要澄清，系统会直接追问，不做检索，也不生成事实回答。
- 如果只找到弱证据，回答只能写“可确认部分 + 解释性补充”，不会补新的事实结论。
- 如果笔记里有冲突说法，回答会明确说明冲突，不再把多份笔记强行合成一个确定结论。
- `messages.meta` 会固定保存回答模式、清晰度、歧义标记、重排状态、冲突摘要、弱证据原因和检索统计。

---

## 2. 页面定位

知识库页承担的是“基于个人知识库问答”的工作流，而不是通用聊天页。

当前产品口径如下：

- 右侧是问答区，支持多轮对话、历史恢复和新建对话。
- 左侧是可选的文章编辑区，只有选中文档后才展开。
- 当前打开文档只影响优先检索和手动参考范围，不切换右侧聊天历史。
- 回答必须建立在知识库证据之上；证据不足时要保守回答。
- 来源卡片点击后留在知识库页完成原文定位，不跳文件页。
- 普通知识问答继续走 `/api/chat`；明确要求写入、新建笔记、整理成文章、跨文件整理或检查链接时，仍复用当前输入入口，但直接进入 Agentic Loop。
- Agentic Loop 会先创建任务快照，按授权路径执行工具调用，文件改动先生成 `preview_patch_files` 预览，并通过消息摘要卡打开 DiffDialog 逐文件应用或回滚。

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
- `agent_session_count`
- 最近一条消息的 `preview`
- `updated_at`

### 5.2 默认进入逻辑

知识库页初始化时只读取历史列表，不会自动恢复最新一条会话详情。

当前默认行为是：

- 首次进入页面时直接显示新对话空态
- `activeConversationId = null`
- 只有用户主动点击历史抽屉中的旧会话时，前端才会请求：
  - `GET /api/conversations/:id`
  - 然后把完整 `messages` 映射到页面消息列表中
  - 如果会话包含 Agent Loop，详情还会返回 `agent_sessions` 导出数据，用于记录工具日志、思考文本和修改预览集合

历史抽屉会根据 `agent_session_count` 为包含 Agent Loop 的会话显示日志入口。点击后进入设置页日志视图，并通过 `conversation_id` 过滤展示该会话的 `agent_run_logs`。

### 5.3 用户主动切换旧会话

用户打开右侧 `ConversationDrawer` 后，点击某条旧会话时：

1. 前端先中止当前正在流式输出的请求。
2. 读取该会话详情。
3. 用历史消息覆盖当前消息区。
4. 将 `activeConversationId` 切换到目标会话。

### 5.4 删除旧会话

用户在右侧 `ConversationDrawer` 中点击某条会话的删除图标时：

1. 前端只打开二次确认弹窗，不触发会话选择。
2. 确认后调用 `DELETE /api/conversations/:id`。
3. 服务端先确认会话存在；不存在返回 404，存在则删除 `conversations` 记录。
4. `messages` 和 `conversation_interactions` 由数据库外键级联删除。
5. 如果删除的是当前会话，知识库页会中止当前请求，清空消息、待回答抽屉和错误状态，回到新对话空态。
6. 删除完成后刷新历史列表并提示删除成功。

### 5.5 导出旧会话

用户在右侧 `ConversationDrawer` 中点击某条会话的导出图标时，前端读取 `/api/conversations/:id` 并生成 Markdown 文件。导出内容包括用户消息、AI 消息、引用、消息 meta、Agent session、工具调用日志、思考文本、快照数量和修改预览集合；导出不会切换当前会话，也不会修改会话状态。

### 5.6 左侧文档浏览位置

知识库页左侧文档区会写入 `knowledge:file:<id>` 页面级记录，并同步更新 `document:file:<id>` 文档级最近位置：

- 保存 Tiptap 滚动容器的 `scrollTop / scrollProgress`、当前可见文本锚点和视口内偏移。
- 普通滚动停止 `240ms` 后保存；切页开始、刷新或关闭页面时同步写入。
- 从文件页或创作页进入时读取同一文档的最新位置，优先按文本锚点恢复，找不到锚点再回退到滚动进度。
- 来源卡片点击、`pendingCitation` 和其他显式定位优先，不会被旧浏览位置覆盖。
- 侧边栏开放当前文章 H1-H6 大纲；AI 未就绪时只锁定问答区，不阻断大纲和文章查看。
- 右侧 AI 聊天区不保存滚动位置，继续自动滚到最新消息。

---

## 6. 用户发送问题的完整流程

### 6.1 前端发起前的校验

用户在底部 `InputBar` 提交问题时，前端先检查：

1. 是否存在可用的 LLM 配置。
2. 页面当前是否处于可发送状态。
3. 如果有旧请求在进行，先 `abort`。

随后前端先做任务类型判断：

- 普通问答：进入 `/api/chat`，设置 `loading = true`、`retrievalStage = 'searching'`，本地先插入用户消息并清空 `streamText`。
- 写作类任务：不先插入用户消息，不请求 `/api/chat`，而是直接创建 Agentic Loop 任务并启动。

写作类任务采用保守关键词规则：同时命中“写作动作”和“写作对象/文件对象”，或命中明确的新建/保存文件表达时进入 Loop；“是什么 / 为什么 / 如何 / 有哪些 / 解释 / 分析 / 查找 / 总结一下 / 对比”等普通问答表达在没有明确写作产物时继续走 `/api/chat`。

如果进入 Agentic Loop，前端会：

1. 使用当前文档所在目录作为默认授权路径，并插入用户消息。
2. 调用 `/api/agent/loop/start` 创建 session、快照并执行工具链。
3. 通过 SSE 展示 `snapshot_done / loop_start / tool_start / tool_done / loop_done`。
4. 如果生成文件级预览，在助手消息底部显示摘要卡。
5. 用户在 DiffDialog 中逐文件点击应用或回滚时调用 `/api/agent/loop/apply`，并携带当前对话 ID；成功后只更新文件、弹窗和摘要卡状态，不续跑 Loop。新建或切换对话后，旧预览只保留查看、导出和日志复盘，不再允许继续应用或回滚。

`create_note` 新建文件按目录粒度校验授权。为兼容旧任务，如果授权项是当前 `.md` 文件，后端只允许在该文件父目录中新建文件，不会因此允许修改同目录其他文件。

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

### 7.0 新增请求级护栏

`/api/chat` 现在会先读取知识库能力开关：

- `knowledge_enable_clarify`
- `knowledge_enable_conditional_rerank`
- `knowledge_enable_weak_evidence_supplement`
- `knowledge_enable_conflict_mode`

这四个开关默认开启，但都只在后端生效，不提供单独设置页 UI。

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

现在历史还会额外参与两件事：

1. 生成 `history_hash`，作为 `rewrite / rerank` helper 缓存键的一部分。
2. 辅助判断当前问题是否只是一个依赖上文的追问，决定是直接补全、改写，还是先追问。

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

### 7.5 查询理解与澄清分支

正式检索前，服务端会先构造 `queryPlan`。当前固定输出：

- `intent`
- `clarity_score`
- `ambiguity_flags`
- `clarify_needed`
- `clarify_question`
- `clarify_reason`
- `clarify_intro`
- `clarify_questions`
- `clarify_render_mode`
- `rewrite_strategy`

当前规则如下：

- `clarity_score >= 0.75`：直接进入检索。
- `0.45 <= clarity_score < 0.75`：如果能从历史补全，则允许进入 `rewrite`；否则直接追问。
- `clarity_score < 0.45`：直接追问。

如果命中 `clarify_needed`：

1. `/api/chat` 不会进入检索。
2. 不会调用主回答模型。
3. 会创建一条 `source='knowledge'` 的 `conversation_interactions` 记录，并把 `answer_mode` 标成 `clarify_needed`。
4. 助手消息只保留一条引导语，真正的问题定义放进底部提问卡片 `ClarifyDrawer`。
5. 提问卡片最多补问 3 个结构化条件，优先围绕对象、对比对象、时间范围和检索范围。
6. 用户答完最后一题后先进入回顾态；只有点击“开始检索”后，前端才会调用 `POST /api/interactions/:id/respond`，再带 `interaction_id` 调 `/api/chat` 续跑。

---

### 7.6 请求级 helper 预算

知识库问答现在新增两类 helper：

1. `rewrite`：只在中等歧义、可通过补全历史提高检索质量时触发。
2. `rerank`：只在 summary / comparison / follow_up 或候选证据不稳定时触发。

但 helper 会受 3 道限制：

1. 如果 prompt 估算已接近上下文压缩阈值，helper 不会触发。
2. 如果本轮已经做过一次 helper，就不会再做第二次 helper。
3. 如果 helper 超时、429、5xx 或 JSON 解析失败，会直接回退到规则链路，不会中断主回答。

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

### 8.2 当前检索与候选规模

保持单索引的前提下，当前链路固定包含：

1. query plan
2. 向量检索
3. FTS 检索
4. 标题 / 路径命中
5. 当前文档优先
6. section 聚合

当前内部规模如下：

- chunk 候选池：`max(20, topK * 4)`
- section seed：`max(8, topK * 2)`
- 主回答入模 section：默认压到 `4` 组，压缩时继续减少

### 8.3 条件 rerank

如果 query 本身不歧义，但首轮候选不够稳定，会进入条件 rerank。当前触发条件包括：

- `intent` 属于 `summary / comparison / follow_up`
- `top1 - top2 < 0.03`
- 前 5 个 section 涉及至少 3 个文件
- 首轮已经落在弱证据边缘态

rerank 只接收最多 8 个 section，并返回：

- `ranked_section_keys`
- `relevance_score`
- `evidence_strength`
- `conflict_group`
- `reason`

如果 rerank 失败，会继续使用首轮排序结果。

---

### 8.4 回答模式

当前知识库问答固定有 5 种回答模式：

- `clarify_needed`
- `grounded`
- `weak_evidence`
- `conflicting_evidence`
- `no_evidence`

其中：

- `clarify_needed`：只追问，不检索，不调主回答模型。
- `grounded`：正常基于证据回答。
- `weak_evidence`：只能输出可确认部分和解释性补充。
- `conflicting_evidence`：必须明确提示不同笔记之间存在冲突。
- `no_evidence`：直接返回证据不足，可附候选文档。

---

### 8.5 会话元数据与观测

当前轮回答结束后，助手消息会把以下信息写进 `messages.meta`：

- `answer_mode`
- `confidence`
- `clarity_score`
- `ambiguity_flags`
- `rerank_applied`
- `weak_evidence_reason`
- `conflict_summary`
- `retrieval_stats`
- `helper_call_type`
- `helper_call_triggered`
- `helper_call_cache_hit`
- `helper_call_latency_ms`
- `helper_call_failed`
- `fallback_reason`

知识库页前端现在优先读取这些元数据来展示回答状态，不再只看有没有 citations。

### 8.6 追问扩展

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

- `retrieveKnowledgeContext(queryPlan, ...)`

对应实现：

- [retrieval.js](/home/burger/Documents/projects/Notus/notus/lib/retrieval.js)

### 8.7 检索内部步骤

当前检索流程可以概括为：

1. 先根据当前问题与最近若干轮 `user + assistant` 历史生成 `queryPlan`。
2. 并行构造原始 query、独立 query、扩写 query 等多个 query variant。
3. 用标题线索检索 `files_fts`，先定位可能相关的文档标题或文件名。
4. 对每个 query variant 执行 chunk 级混合检索：`chunks_vec` 向量召回 + `chunks_fts` 全文召回 + 图片向量召回。
5. 对标题命中的文件再做一次限定范围的 chunk 召回。
6. 用 RRF 与变体权重合并候选结果，并对当前打开文档做额外加权。
7. 对命中的 heading chunk 做正文提升，避免短标题压过正文证据。
8. 生成最终 `chunks` 列表，并按章节扩展为带上下文的 `sections` 证据组。
9. 计算 `stats`、`matched_files`、`rewrite_queries` 与 `sufficiency`。

### 8.8 当前文档的作用

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
- 按章节整理后的证据包
- 必要时压缩后的更早对话摘要
- `sections`
- `chunks`

也就是说，模型看到的并不是“裸问题”，而是“问题 + 当前轮完整检索证据包”。

### 9.4 上下文预算与自动 compact

从 2026-04-30 起，知识库页发送前会先读取当前 LLM 配置中的：

- `api_protocol`
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
- 检索状态进入 AI loading 气泡内部，按“分析问题 / 检索笔记 / 找到证据 / 组织答案”等步骤动态切换，不再作为独立状态线固定展示

#### `token`

- 把流式文本拼接到 `streamText`
- 首个 token 到来后，loading 气泡切换为正文流式输出

#### `citations`

- 缓存本轮来源卡片数据
- 最终和 `source_count`、补充说明一起挂到同一个 assistant 回复容器里

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

1. 服务端根据 `llm_config_id` 解析出当前 LLM 运行配置，包括 OpenAI API / Anthropic 兼容协议。
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
# 2026-06-20 Agent 聊天 UI 修正

- 知识库页继续保留旧的左右分栏业务布局：左侧文档预览/编辑、来源定位和持续高亮能力不移除。
- 右侧聊天消息区、工具链和底部输入框按 Notus-design-draft/notus-agent.html 还原；聊天顶部不显示 Agent Workspace 标题，也不显示模型配置和搜索配置按钮。
- 工具链 UI 使用设计稿的顶部状态图标、可折叠步骤行和展开详情。知识库检索步骤展开后展示检索范围、候选来源数量和最终完成结果；收起时只保留单行摘要。
- 普通用户消息仍通过 /api/chat 进入知识库问答链路，继续使用查询规划、知识库检索、证据判断、SSE 流式回答和引用来源；写作类任务直接进入 Agentic Loop，完成后通过消息摘要卡打开 DiffDialog 逐文件确认。
- 前端将 chunks / assistant_meta / token / citations / done 映射为设计稿工具过程、Notus Agent 回复正文和来源展示；点击来源仍在知识库页内部展开左侧文档并定位原文。
- 输入框会随请求携带当前模型、联网搜索状态、单选搜索服务商和附件元数据；联网搜索打开时，知识库页普通联网问答改走只读 Agent Loop，并注入 `web_search` 工具供模型按需重复调用；关闭时不注入联网工具，也不加载历史联网上下文。设置页联网搜索总开关实时保存，其他搜索配置仍手动保存。
