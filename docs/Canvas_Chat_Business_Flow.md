# 创作页 Chat 全流程业务文档

> 更新时间：2026-05-02  
> 适用范围：`/canvas` 当前真实实现的大纲生成、创作对话、风格仿写、批量预览恢复与全文分批改写链路

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

- 创作页仍然是“围绕当前文章做协作编辑”的工作台，不是开放式通用聊天页。
- 大纲可以先生成，但必须保存为正式文档后，才能继续稳定对话和应用 AI 改写。
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
- [run.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/run.js)
- [apply.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/agent/apply.js)
- [[id].js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/pages/api/conversations/[id].js)

### 核心库

- [style.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/style.js)
- [canvasRequestPlanner.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/canvasRequestPlanner.js)
- [canvasAgent.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/canvasAgent.js)
- [canvasOperationSets.js](/Users/hejiajun/Documents/lzc_projects/Notus/notus/lib/canvasOperationSets.js)
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
- `status`
- `expires_at`

### 7.3 状态

- `pending`
- `applied`
- `cancelled`
- `stale`

### 7.4 应用

前端点击“应用全部修改”时：

1. 调用 `/api/agent/apply`
2. 后端执行 `applyOperations()`
3. 任一操作出现 `OLD_MISMATCH`、`BLOCK_NOT_FOUND` 或 `NO_CHANGES`，整组回滚
4. 只有 `changed_count > 0` 且最终文章内容确实变化时，才将 operation set 标记为 `applied`
5. 如果没有实际修改，前端保留预览并提示用户重新生成，不显示应用成功

### 7.5 取消与过期

- 取消会标记为 `cancelled`
- 默认 `7` 天后自动过期
- 当前文章 hash 变化后自动转为 `stale`

---

## 8. 会话恢复

会话详情接口现在除了消息外，还会返回：

- `pending_operation_sets`
- `pending_interactions`

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

### 8.2 创作块区浏览位置

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
5. 如果答案已经足够，前端再调用 `/api/agent/run`
6. 系统继续只生成 `operation_set` 预览，不会自动把修改写回文档

### 9.4 回答失败或文章变化

- 如果文章 hash 已变化，抽屉会转为 `stale`，不能直接继续执行
- 如果回答已经记录，但自动续跑失败，抽屉只保留“重试生成预览”入口；点击重试后前端会再次发起续跑。若续跑时发现原目标块失效，则会把同一张抽屉重置为 `pending`，并只要求重新确认位置
- 结构化澄清始终保持提问抽屉形态，不能降级为没有按钮和输入框的纯文本追问。
- 澄清后续跑生成预览时，即使同一条消息同时带有“当前理解”摘要，也必须展示批量预览和应用按钮。
- `pending / stale / failed` 三种状态都会在刷新后恢复显示；`answered / cancelled` 不再显示为可操作态
- 抽屉收起后，输入栏恢复普通提问；如果用户此时直接发送新请求，旧 interaction 会先标记为 `cancelled`

---

## 10. SSE 协议

### `/api/agent/run`

当前会返回：

- `thinking`
- `token`
- `batch_start`
- `batch_progress`
- `batch_done`
- `assistant_meta`
- `interaction_request`
- `operation`
- `done`
- `error`

其中：

- `assistant_meta` 负责把 `operation_set_id`、`scope_mode`、`target_block_ids`、`last_focus_summary`、`fallback_reason`，以及 `primary_intent / risk_level / decision_summary / ai_arbitration_mode / source_content_type / target_anchor / position_relation / write_action / correction_state / show_decision_summary` 回给前端
- `interaction_request` 负责把结构化提问抽屉完整下发给前端
- `done` 负责回传最终 assistant message、citations 和 budget/usage

### `/api/agent/apply`

当前兼容：

- `{ operation }`
- `{ operations }`
- `{ action: "cancel" }`

返回补充字段：

- `applied_count`
- `failed_at`
- `operation_set_status`

---

## 11. 当前边界

1. 旧的 `/api/agent/intent` 和 legacy Canvas agent 已移除，当前只保留请求规划器 + 执行器主链路。
2. 首版不做风格别名表、术语映射和自动学习同义词。
3. 全文改写不会自动无限放宽范围，超过硬上限时必须要求用户缩小范围。
4. 主动提问抽屉现在同时存在于创作页和知识库页，但知识库页只收集检索必要信息，不接入创作规划器的主意图与写入槽位。
5. 回答卡片后仍只生成预览，不会自动把内容直接写回文档。
6. 轻量纠偏入口只在系统已经形成较明确判断时出现，不是常驻模式切换器，也不替代正常意图识别。
# 2026-06-19 Agent Workspace 更新

- 创作页整页改为 Notus Agent Workspace，不再常驻旧块画布和右侧聊天分栏。
- 当前文档内容会在前端转换为 article blocks 后提交给 /api/agent/run；无当前文档时会先创建一篇 AI 创作草稿。
- thinking / batch_start / batch_progress / batch_done / assistant_meta / done 会映射为工具过程和文件变更卡片。
- 变更详情弹窗展示 operation old/new 内容；应用修改后通过 /api/agent/apply 生成新 article，再保存回当前 Markdown 文件。
- 输入框会随请求携带当前模型、联网搜索状态、搜索服务商和附件元数据；联网搜索当前只记录配置状态，不参与真实外部搜索。
