# 创作页 Chat 全流程业务文档

> 更新时间：2026-06-24
> 适用范围：`/canvas` 当前真实实现的大纲生成、Agentic Loop 创作任务、风格仿写、文件级预览、自动确认、逐文件应用/回滚与废弃链路

---

## 1. 文档目标

本文只描述创作页当前真实实现，重点回答 6 个问题：

1. 创作页如何从主题新建和现有文档两种入口进入。
2. 风格仿写现在如何建模，而不是只靠运行时临时样本。
3. 用户输入是如何被判断为改单块、多块、全文、纯对话或文章分析的。
4. 编辑结果为什么不再是单条预览，而是一组可恢复的操作集合。
5. 全文改写如何在效果、准确性和 LLM 调用成本之间做约束。
6. 哪些数据会落库，刷新后哪些状态可以恢复。

---

## 2. 当前产品口径

- 创作页仍然是“围绕当前文章做协作编辑”的工作台；右侧主输入入口默认使用 Agentic Loop 自动确认模式，发送后直接调用 `/api/agent/loop/start`，不再把创作页主输入发送到旧的 `/api/agent/run`。
- 输入框左下角提供“自动确认 / 手动确认”选择器，仅在创作页展示，选择值持久化到浏览器本机。两种模式都不显示前置任务确认卡；差异只发生在文件级 diff 生成后的应用策略。
- 当前文章改写、整篇生成/重写、新建笔记、文件夹分析、链接检查等任务都通过 Agentic Loop 执行；默认授权路径优先使用当前文章所在目录，检索次数使用当前前端配置。
- 大纲可以先生成，但必须保存为正式文档后，才能继续稳定对话和应用 AI 改写。
- 从文件页或知识库页携带 `?fileId=` 进入创作页时，目标文章加载完成前显示“正在打开文档…”骨架态，不再短暂显示新建创作入口。
- 事实参考继续走后台自动补充，前台不单独展示事实来源配置。
- 风格来源前台只保留：
  - 自动匹配
  - 手动指定文章
- 全文改写始终保持块级结构和用户确认，不做整篇 raw text 覆盖。

---

## 3. 关键模块

### 前端

- [canvas.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/canvas.js)
- [BatchOperationCard.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/components/AIPanel/BatchOperationCard.js)
- [InputBar.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/components/ChatArea/InputBar.js)

### 后端 API

- [outline.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/outline.js)
- [run.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/run.js)（历史兼容，不作为创作页主输入入口）
- [apply.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/apply.js)（历史兼容，不作为 Agentic Loop 应用入口）
- [loop/start.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/loop/start.js)
- [loop/apply.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/loop/apply.js)
- [sessions/[id].js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/sessions/[id].js)
- [sessions/[id]/rollback.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/sessions/[id]/rollback.js)
- [[id].js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/conversations/[id].js)

### 核心库

- [style.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/style.js)
- [canvasRequestPlanner.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/canvasRequestPlanner.js)
- [canvasAgent.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/canvasAgent.js)
- [canvasOperationSets.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/canvasOperationSets.js)
- [agentSession.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/agentSession.js)
- [agentTools.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/agentTools.js)
- [agentLoop.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/agentLoop.js)
- [agentLoopPrompt.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/agentLoopPrompt.js)
- [diff.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/diff.js)

---

## 4. 风格仿写链路

### 4.1 离线风格提取

索引成功后，系统会尝试为文章建立风格指纹：

- 只处理满足以下条件的文章：
  - 至少 `3` 个可写文字块
  - 正文总长度至少 `600` 字
- 写入 `style_fingerprints`
- 定期合并成一份最新 `style_profile`

风格提取失败不会阻断知识库索引完成状态。

### 4.2 旧文回填

- 后台串行回填
- 每批 `5` 篇
- 单篇最多重试 `3` 次
- 显式重建索引时暂停

### 4.3 运行时风格上下文

创作时不再只取几条临时样本，而是通过 `getStyleContext()` 组织：

- 全局风格画像
- 相关文章的风格指纹
- 少量相关原文摘录

模式区别：

- `auto`
  - 全局画像
  - 最相关 `1-2` 篇文章
- `manual`
  - 全局画像仍保留为总语气基线
  - 指纹和原文摘录只来自手动指定文章

---

## 5. 请求规划链路

### 5.1 固定输出

`resolveCanvasRequest()` 固定输出：

- `intent`
- `scope_mode`
- `target_block_ids`
- `operation_kind`
- `needs_style`
- `needs_knowledge`
- `clarify_needed`
- `clarify_question`

### 5.2 LLM 主规划

每次请求都调用一次 `canvas_query_plan` LLM 调用（`target_resolver` 模式），由 LLM 决定：

- `primary_intent`：edit / text / analyze
- `operation_kind`：rewrite / polish / expand / shrink / merge / reorder / delete / insert
- `target_refs`：目标块列表
- `scope_mode`：single / multiple / global / none
- `clarify_needed`：是否需要继续澄清

调用结果命中 3 分钟内存缓存（articleHash + historyDigest + userInput 三元组），重复提交不会产生额外开销。

规划器的 Prompt 现在按更保守的编辑判定执行：没有明确修改动词时，不能仅因上下文里存在文章块就默认进入编辑；只有用户明确引用块、承接上一轮编辑建议，或使用写入、替换、生成到文档、应用到正文等表达时，才允许偏向 `edit`。普通“怎么样 / 是否清楚 / 有什么建议 / 怎么看”类讨论请求继续走 `text`。

### 5.3 无歧义预处理（词法层）

LLM 调用前，系统先做以下词法提取，结果作为 LLM 的候选上下文传入；对显式块、全文编辑、文章分析、继续讨论等无歧义话术，规划结果会做最小校正，避免坏 JSON 把请求带到错误模式：

- `@b2` / `@b2-b5` / `第 N 段` → 显式块引用（`parseExplicitMentionIds`）
- `全文 / 整篇` → 全局范围标记（`isGlobalPhrase`）
- `把 X 换为 Y` / `将 X 改成 Y` / `X 换为 Y` / `X 改为 Y` → 精准替换提取（`extractDeterministicRewrite`），支持把 `Bun 技术栈` 拆成 `field_name=技术栈 / source_text=Bun`

### 5.4 deterministic 精准替换优化

当用户输入命中 `把/将 X 改为/换成/换为/替换为/替换成 Y`，或者省略前缀的 `X 换为 Y / X 改为 Y` 句式，且目标块唯一时，走字符串直接替换路径（`buildDeterministicReplaceOperation`），不再调用 LLM 生成编辑内容，精准只替换匹配的词或字段值。字段值场景会优先在同一行内替换，例如 `技术栈：Bun` 或 `| 技术栈 | Bun |` 只把 `Bun` 改成目标值。

如果同一旧值命中多个块，系统会返回澄清卡片要求用户确认目标位置，不使用 LLM 返回的无关目标块。

---

## 6. 创作执行链路

### 6.1 执行模式

规划完成后，`runCanvasAgent()` 会进入 4 类模式之一：

1. `clarify`
2. `text`
3. `analysis`
4. `edit`

### 6.2 文本回复

如果用户是在讨论、追问或询问建议，而不是直接要改文章：

- 走 `streamChat()`
- SSE 返回 `token`
- 不生成任何操作

### 6.3 文章分析

如果用户要求分析结构、逻辑、风格一致性、可读性或完整性：

- 也走 `streamChat()`
- 只返回文本
- 不生成操作
- 当前默认受 `canvas_enable_article_analysis` 开关控制
- 本轮默认保持关闭，只保留后端配置入口

### 6.4 单块 / 多块改写

如果用户明确了改单块或多块：

- 先按需加载风格上下文
- 需要事实时再补知识库证据
- 再生成一组 `operations`
- 目标块必须完整进入编辑 Prompt；邻近块可以裁剪但只能作为上下文
- `replace.old` 和 `replace.new` 都必须是完整目标块全文；局部修改也不能只返回修改片段，无法保证完整时返回空 `operations`
- 如果编辑模型没有返回合法 JSON，执行器仍向前端返回“AI 返回格式异常，请重试。”并停止应用，但服务端会额外写入 `canvas.operation_json.invalid` warning 日志，保留原始返回摘要用于排查

简单操作优先走规则化，减少 LLM 调用：

- 删除
- 两段顺序互换

### 6.5 全文改写

全文改写只处理：

- `paragraph`
- `list`
- `blockquote`

固定护栏：

- 软上限 `12` 个正文块
- 硬上限 `20` 个正文块
- 单批最多 `4` 块
- 预计编辑型调用超过 `6` 次时直接拦截

SSE 过程会返回：

- `batch_start`
- `batch_progress`
- `batch_done`

### 6.6 主输入 Agentic Loop

创作页右侧主输入收到用户请求后，不直接进入旧块级执行器，而是先读取创作页输入框里的确认方式。

- 自动确认：默认模式。前端直接启动 Agentic Loop；`preview_patch_files` 生成后由后端自动应用所有文件，完成消息底部仍显示已自动应用的 diff 卡片。
- 手动确认：前端同样直接启动 Agentic Loop；`preview_patch_files` 生成后在对话底部显示常驻 diff 卡片，由用户逐文件应用或回滚。

启动后前端调用 `/api/agent/loop/start`，服务端会：

1. 创建 `agent_sessions`，保存目标、授权路径、授权操作和检索次数上限；`create_note` 新建文件按目录粒度校验，后端兼容旧任务只授权当前 `.md` 文件时在父目录新建，但不会扩大同目录其他文件的修改权限。
2. 在执行前写入 `agent_snapshots`。
3. 通过 Agent Loop 多轮调用 `search_knowledge / read_file / create_note / preview_patch_files / analyze_folder / check_links`。
4. `preview_patch_files` 生成文件级 patch，并写入 `canvas_operation_sets.pathes_json`。
5. 自动确认模式在服务端自动调用文件级应用逻辑，patch 状态标记为 `auto_applied`；手动确认模式保持 `pending`。
6. Loop 结束后，最终助手消息底部展示常驻 diff 卡片；应用、回滚或废弃只调用 `/api/agent/loop/apply`，不会再次请求 LLM。

---

## 7. 预览与应用链路

### 7.1 为什么改成操作集合

旧实现只能保留单条待应用修改，无法支持：

- 多块联合改写
- 全文分批预览
- 刷新恢复

现在后端会把一整组修改写入 `canvas_operation_sets`。

### 7.2 operation set 结构

核心字段：

- `conversation_id`
- `file_id`
- `message_id`
- `article_hash`
- `mode`
- `operations_json`
- `agent_session_id`：Agentic Loop 生成的预览关联任务会话，旧数据可为空
- `pathes_json`：Agentic Loop 文件级 patches，JS 内部仍使用 `patches` 命名
- `status`
- `expires_at`

### 7.3 状态

- `pending`
- `partial`
- `applied`
- `cancelled`
- `stale`

文件级 patch 另有独立状态：

- `pending`
- `applied`
- `auto_applied`
- `rolled_back`
- `discarded`
- `failed`

### 7.4 应用

Agentic Loop 生成文件级预览后，前端按确认方式处理：

- 自动确认：后端在 Loop 完成前自动应用所有文件，前端只展示“已自动应用”状态的 diff 卡片，用户仍可逐文件回滚。
- 手动确认：前端在对应助手消息底部保留 diff 卡片，用户逐文件点击“应用修改”或“回滚修改”，点击后立即生效，不弹二次确认。

应用时：

1. 调用 `/api/agent/loop/apply`，携带 `session_id`、`session_token`、`operation_set_id`、`patch_index` 和动作类型。
2. 后端按当前文件中的唯一 `old/new` 文本做冲突校验，通过后写入 Markdown 文件；生成预览前，`preview_patch_files` 会先把空白差异下的唯一近似 `old` 对齐到当前文件精确片段，无法唯一匹配时才返回明确错误。
3. 前端刷新当前文章内容和文件树状态。
4. 成功后只更新 diff 卡片状态；不会再次调用 `/api/agent/loop/start`，也不会触发模型生成总结。

### 7.5 取消与过期

- 取消会标记为 `cancelled`
- 默认 `7` 天后自动过期
- 当前文章 hash 变化后自动转为 `stale`

---

## 8. 会话恢复

会话详情接口现在除了消息外，还会返回：

- `pending_operation_sets`
- `pending_interactions`
- `agent_sessions`：用于导出 Agent Loop 运行记录，包含工具日志、思考文本、快照数量和修改预览集合，不包含 session token

会话列表会额外返回 `agent_session_count`。历史抽屉中包含 Agent Loop 的会话会显示日志入口，点击后进入设置页日志视图，并通过 `conversation_id` 只查看该会话的 Agent Loop 执行日志。

前端刷新后会：

1. 恢复消息
2. 恢复所有未应用预览
3. 恢复 `pending / stale / failed` 提问抽屉
4. 根据当前文章 hash 自动判断 operation set 或 interaction 是否需要转为 `stale`

### 8.1 删除历史会话

创作页历史抽屉中的每条会话都提供删除图标：

1. 点击删除图标只打开二次确认，不会切换到该会话。
2. 确认后调用 `DELETE /api/conversations/:id`。
3. 服务端确认会话存在后删除；消息、批量预览和提问抽屉记录由外键级联清理。
4. 如果删除的是当前会话，创作页清空右侧消息、待应用预览和待回答抽屉，回到当前文章的新对话空态。
5. 删除当前会话不会清空左侧文章块，也不会改变当前未保存状态。

### 8.2 导出历史会话

创作页历史抽屉中的每条会话都提供导出图标。点击后前端读取 `/api/conversations/:id`，生成 Markdown 文件，内容包括用户消息、AI 消息、引用、消息 meta、Agent session、工具调用日志、思考文本、快照数量和修改预览集合。导出不会修改对话状态，也不会触发会话切换。

### 8.3 创作块区浏览位置

创作页左侧块区会写入 `canvas:file:<id>` 页面级记录，并同步更新 `document:file:<id>` 文档级最近位置：

- 每个可排序块外层带有 `data-canvas-block-id`。
- 保存当前可见 block id、正文文本、视口内偏移和滚动进度。
- 从文件页或知识库页进入时，可以用正文文本匹配对应创作块；从创作页返回编辑器时也可用块正文匹配标题或段落。
- 普通滚动停止 `240ms` 后保存；切页开始、刷新或关闭页面时同步写入。恢复完成前不会写入初始化顶部位置。
- 普通跨页返回时优先按 block id 或正文锚点恢复，找不到锚点时回退到滚动进度。
- 右侧 AI 聊天区不保存滚动位置，继续自动滚到最新消息。

---

## 9. 主动提问抽屉

### 9.1 什么时候会出现

当前创作页不会把提问抽屉当作默认兜底。只有在以下场景之一出现时，才会走结构化抽屉：

- 主意图不稳，例如系统无法稳定判断这轮是继续讨论、文章分析，还是直接改文档
- 缺少写入位置，例如“把上面的内容写到文档中”
- 内容指代不稳定，例如“把上面的内容写进去”但无法稳定确认来源
- 候选块冲突明显，例如“改性能优化那一段”同时命中多个接近块
- 编辑动作冲突，例如一句话里同时要求“删除”和“写进去”
- 缺少写入方式，例如已知道来源和位置，但还不知道是“追加”还是“替换”
- 高风险修改在预算不足、helper 超时或候选证据不一致时，需要先保守确认
- 续跑前发现原目标块已经失效，需要重新确认写入位置

### 9.2 抽屉里保存什么

后端会把抽屉对应的 interaction 持久化到 `conversation_interactions`，并冻结：

- `primary_intent`
- `source_message_id`
- `source_kind`
- `source_content_snapshot`
- `source_content_digest`
- `source_content_type`
- `article_hash`
- `target_candidates`
- `candidate_block_ids`
- `decision_summary`
- `risk_level`
- `ai_arbitration_mode`
- `correction_state`
- `payload_json`
- `response_json`

这意味着“上一条回复”一旦被识别成来源内容，后续就不再依赖“最新上一条消息”。

### 9.3 回答后怎么继续

1. 用户直接在右侧 AI 面板底部列表抽屉里逐题回答；抽屉覆盖输入框，不再把抽屉或重试块内联到消息流
2. 最后一题答完后先进入回顾态，允许回到前题修改
3. 用户点击“开始生成预览”后，前端才调用 `POST /api/interactions/:id/respond`
4. 后端把结构化答案写入 `response_json`，并追加一条 `user` 摘要消息；摘要消息的 `meta` 同时会写入当前文章范围内的短时纠错状态
5. 如果答案已经足够，前端按当前创作页确认方式继续：自动确认和手动确认都直接调用 `/api/agent/loop/start`
6. 自动确认模式会在预览生成后自动写入；手动确认模式继续只生成预览，等待用户逐文件确认

### 9.4 回答失败或文章变化

- 如果文章 hash 已变化，抽屉会转为 `stale`，不能直接继续执行
- 如果回答已经记录，但自动续跑失败，抽屉只保留“重试生成预览”入口；点击重试后前端会再次发起续跑。若续跑时发现原目标块失效，则会把同一张抽屉重置为 `pending`，并只要求重新确认位置
- 结构化澄清始终保持提问抽屉形态，不能降级为没有按钮和输入框的纯文本追问。
- 澄清后续跑生成预览时，即使同一条消息同时带有“当前理解”摘要，也必须展示批量预览和应用按钮。
- `pending / stale / failed` 三种状态都会在刷新后恢复显示；`answered / cancelled` 不再显示为可操作态
- 抽屉收起后，输入栏恢复普通提问；如果用户此时直接发送新请求，旧 interaction 会先标记为 `cancelled`

---

## 10. SSE 协议

### `/api/agent/loop/start`

当前创作页主输入消费以下 SSE 事件：

- `session_created` / `session_resumed`
- `snapshot_done`
- `loop_start` / `soft_limit_notice`
- `thinking`
- `tool_start` / `tool_done`
- `loop_done`
- `cancelled` / `error`

这些事件会映射到 AgentWorkspace 的工具过程、流式思考文本和文件级 diff 卡；旧 `waiting_preview_confirm` 仅作为历史兼容事件处理，不再是新预览流程的暂停点。

### `/api/agent/loop/apply`

当前用于以下动作：

- `{ session_id, session_token, action: "apply_file", operation_set_id, patch_index }`：应用单个文件级 patch。
- `{ session_id, session_token, action: "rollback_file", operation_set_id, patch_index }`：回滚单个文件级 patch。
- `{ session_id, session_token, action: "discard_pending", operation_set_id }`：在下一条 prompt 前废弃未处理 patch。
- `{ session_id, session_token, action: "extend", extra_loops }`：硬上限暂停后继续执行。

---

## 11. 当前边界

1. 旧的 `/api/agent/run` 与 `/api/agent/apply` 文件仍保留用于历史兼容；创作页主输入不再调用它们。
2. 首版不做风格别名表、术语映射和自动学习同义词。
3. 全文改写不会自动无限放宽范围，超过硬上限时必须要求用户缩小范围。
4. 主动提问抽屉现在同时存在于创作页和知识库页，但知识库页只收集检索必要信息，不接入创作规划器的主意图与写入槽位。
5. 回答卡片后仍只生成预览，不会自动把内容直接写回文档。
6. 轻量纠偏入口只在系统已经形成较明确判断时出现，不是常驻模式切换器，也不替代正常意图识别。

# 2026-06-20 Agent 聊天 UI 修正

- 创作页继续保留旧的块画布、文章分片预览、块编辑和批量修改预览，不再整页替换为 Agent Workspace。
- 右侧聊天消息区、工具链和底部输入框按 Notus-design-draft/notus-agent.html 还原；聊天顶部不显示 Agent Workspace 标题，也不显示模型配置和搜索配置按钮。
- 当前文档所在目录会作为 Agentic Loop 默认授权路径；自动确认和手动确认都直接使用该授权范围启动。无当前文档时仍先创建一篇 AI 创作草稿。
- session_created / snapshot_done / loop_start / thinking / tool_start / tool_done / loop_done 会累计为设计稿工具过程和文件变更卡片；最终 assistant 消息保留完整工具步骤，历史会话中仍可展开查看每一步的说明、工具输入和结果。
- 批量修改预览、应用和取消能力继续保留；文件级 patch 的 old/new 内容直接在对话底部 diff 卡片中展示，应用或回滚通过 `/api/agent/loop/apply` 写回 Markdown 并更新 patch 状态，不再携带 session_id 续跑。
- 输入框会随请求携带当前模型、联网搜索状态、单选搜索服务商和附件元数据；联网搜索当前只记录配置状态，不参与真实外部搜索；输入框上方不展示预制问题列表。设置页联网搜索总开关实时保存，其他搜索配置仍手动保存。
