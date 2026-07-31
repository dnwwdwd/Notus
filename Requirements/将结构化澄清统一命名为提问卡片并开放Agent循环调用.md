# 将结构化澄清统一命名为提问卡片并开放Agent循环调用

## 类型

功能优化

## 背景

项目中已有 `clarify_card` / `ClarifyDrawer` 结构化确认能力，但产品口径上应统一称为“提问卡片”。同时，当前创作页主入口已经切到 Agentic Loop，旧 `/api/agent/run` 的结构化澄清不能覆盖 Loop 主流程，需要让 Agent Loop 自己能生成提问卡片，并允许用户通过 prompt 明确要求 Agent 生成提问卡片。

## 需求

1. 对外统一使用“提问卡片”命名；内部数据库 kind 可继续沿用 `clarify_card`，避免迁移历史数据。
2. Agent Loop 新增提问卡片工具，Agent 在关键信息不足时可以主动调用。
3. 用户在 prompt 中明确要求“生成提问卡片 / 先问我几个问题 / 出几道问题”时，Agent 可以调用同一个工具生成卡片。
4. 提问卡片回答后，应恢复同一个 Agent Loop，不得绕回旧块级 Agent 链路。
5. 提问卡片最多包含 3 个问题，支持单选和文本输入，回答摘要需要写入会话历史，供后续 Loop 继续使用。

## 实现结果

1. `notus/lib/agentTools.js` 新增 `ask_question_card` 工具，创建 `source='agent_loop'` 的 `clarify_card` interaction。
2. `notus/lib/agentLoop.js` 在 `ask_question_card` 返回后保存 checkpoint，将 session 置为 `waiting_confirm`，并通过 SSE 输出 `interaction_request`；恢复时把已回答的提问卡片作为 tool result 继续送回模型。
3. `notus/hooks/useAgentLoopController.js` 支持 `interaction_request` 事件和 `interaction_id` resume 参数。
4. `notus/pages/canvas.js` 与 `notus/pages/knowledge.js` 在 `source='agent_loop'` 时恢复同一个 Agent Loop；旧知识库澄清和旧创作澄清保持原行为。
5. `notus/lib/conversationInteractions.js` 的回答摘要支持通用问题槽位，并将用户可见文案改为“提问卡片”。

## 验收

- Agent 自主判断信息不足时可以调用 `ask_question_card`。
- 用户明确要求生成提问卡片时，Agent 可生成 1 到 3 个结构化问题。
- 用户回答后继续同一个 Agent Loop，并能把答案作为后续上下文使用。
- 历史 `clarify_card` 数据无需迁移。
