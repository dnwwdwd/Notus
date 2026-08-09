# Agent 错误信息组件与原消息重试

## 分类与状态

- 分类：功能优化 / 用户体验优化。
- 状态：已完成（2026-08-08，本地受控失败路径与页面回归通过）。

## 背景与目标

Agent 任务遇到 LLM API、网络、服务端或其他中断错误时，当前页面会在工作区底部直接输出错误字符串，错误与工具链层级不一致，也没有给用户明确的恢复操作。需要使用现有 Diff 详情组件的暖色、细边框、紧凑信息层级，增加统一的错误信息组件。

错误卡片必须提供“重试”按钮。重试沿用现有 AI 回复重试的会话截断和重新发送流程，重新发送触发失败任务对应的上一条用户消息，并保留该消息的文本、Mention 结构、解析附件、图片以及媒体选择顺序。卡片不重复展示重试载荷说明，不增加分隔线，两个操作按钮统一放在卡片右下角。

## 范围与非目标

- 范围：文件工作区 Agent 的请求级错误、持久化 `run_error` 事件、错误卡片视觉、重试入口和重试消息载荷。
- 范围：保留原有“继续任务”恢复入口；错误卡片的“重试”是重新发送原用户消息的新任务，不替代 checkpoint 续跑。
- 非目标：不改变 Worker 的错误分类、checkpoint、SSE 事件协议、文件修改确认和 Diff 应用/回滚权限；自动重试上限由独立需求 REQ-20260808-009 维护。
- 非目标：不展示 Provider 原始 HTML、密钥、完整请求内容或未经脱敏的服务端异常。

## 影响分析

| 维度 | 已确认内容 |
|---|---|
| 写入入口 | `POST /api/agent/loop/start` 创建普通任务；错误卡片通过现有对话截断接口和 `onSend` 重新创建任务；不新增后端写入接口。 |
| 读取方与状态传播 | `useAgentLoopController` 产生请求级错误和 `run_error` 工具步骤；`AgentWorkspace` 将步骤和错误状态渲染为卡片；`FileAgentWorkspace` 继续提供会话、模型配置和发送入口；历史会话从 `agent_run_events` 与用户消息元数据恢复。 |
| 重试载荷 | 文本使用错误任务对应的用户消息；Mention 与 `mention_segments` 原样复用；附件、图片和 `media_items` 从已保存消息的统一媒体列表恢复，并保持 `upload_order`。 |
| 失败与恢复边界 | 有服务端消息 ID 的错误任务先按当前重试规则截断错误任务之后的消息，再用同一用户消息 ID 创建新任务；尚未落库的请求级失败不执行截断，隐藏失败的临时气泡后重新发送。原有“继续任务”仍使用 checkpoint 和恢复票据。 |
| 平台与安全边界 | Web、Electron 和懒猫共用前端组件与现有 API；错误卡片只显示受控 message、error code 和 request id，不显示 HTML、API Key、Cookie 或临时文件路径。 |
| 已检查但不受影响 | Worker 错误分类、队列 FIFO、控制票据 TTL、提问卡、文件预览/Diff 应用与回滚、资料回执开关均不改变；Agent Loop 的自动重试上限由 REQ-20260808-009 单独维护。 |

## 行为验收矩阵

| 场景 | 前置条件 | 操作 | 预期结果 | 验证状态 |
|---|---|---|---|---|
| LLM API 错误 | 任务已创建并收到 `run_error` | 查看当前任务 | 工具链中显示统一错误卡片，包含受控错误说明、错误码或请求编号和“重试”按钮；不再在页面底部裸显示字符串；不重复展示重试载荷说明，不显示分隔线，两个按钮位于右下角。 | 已完成，本地受控失败路径与页面回归通过 |
| 请求级错误 | `/api/agent/loop/start` 或 SSE 初始化返回受控错误 | 查看当前任务 | 同样显示错误卡片；非 JSON/HTML 只显示短提示、HTTP 状态和可选请求编号。 | 已完成，自动化与页面回归通过 |
| 带附件重试 | 失败用户消息含解析附件、图片或混合媒体 | 点击“重试” | 先按现有重试规则处理会话，再发送同一 prompt；附件、图片、`media_items` 顺序和图片受控引用都保留。 | 已实现，静态测试通过 |
| 带 Mention 重试 | 失败用户消息含文件、目录或 Skill Mention | 点击“重试” | Mention 与 `mention_segments` 保持原样，Agent 收到与原任务等价的引用上下文。 | 已实现，静态测试通过 |
| 重试中 | 已点击“重试” | 快速重复点击 | 按钮进入处理中并阻止重复提交；请求失败时恢复按钮状态。 | 已实现，设计预览通过 |
| 继续任务 | 任务仍处于可恢复状态 | 点击原有“继续任务” | 仍走 checkpoint 续跑，不被错误卡片的重新发送逻辑替换。 | 保持原实现，待真实错误回归 |
| 历史恢复 | 刷新或重新打开含失败 session 的对话 | 查看任务 | 错误卡片从持久化事件恢复，重试仍能定位原用户消息。 | 已实现，正常历史页面通过；失败历史待真实回归 |

## 文档同步

- 已更新：本需求文档、`Requirements/需求总台账.md`、`docs/产品设计说明.md`、`docs/产品技术实现说明.md`、`docs/文件工作区Agent业务流程.md`、`docs/界面设计规范.md`、`docs/业务逻辑升级说明.md`。本轮补充错误卡片的按钮布局口径；重试载荷和服务端恢复协议不变。
- 已检查但本轮不改变：`docs/Agent循环架构实现说明.md` 的 Worker、checkpoint 和恢复协议；错误卡片不改变服务端错误分类、续跑协议或控制票据规则。

## 实现与验证

- 代码与配置：`notus/components/AgentWorkspace/AgentWorkspace.js` 增加统一错误卡片与完整原消息重试；`notus/hooks/useAgentLoopController.js` 将请求级错误和 `run_error` 转为受控错误步骤；`notus/pages/api/agent/loop/start.js` 与 `notus/lib/agentMedia.js` 持久化完整媒体列表和 MCP 选择，保证历史消息重试载荷不丢失；`notus/styles/globals.css` 增加 Diff 详情风格的暖色错误卡片样式，操作区右对齐且不带重复说明和分隔线。
- 设计资产：[`designs/agent-error-retry/Agent Error Retry Component.html`](../designs/agent-error-retry/Agent%20Error%20Retry%20Component.html)，已通过本地 Browser 预览、状态切换和重试中交互检查。
- 已执行命令及结果：`node tests/agent-workspace-controls.test.js`、`node --check components/AgentWorkspace/AgentWorkspace.js`、`node --check hooks/useAgentLoopController.js`、`npm run lint:web`、`npm run test:all`、`git diff --check` 均通过；Lint 仅保留既有的 `FileAgentWorkspace.js:587` Hook 依赖警告。
- 本地 Browser 验证：`http://127.0.0.1:3000/files` 可正常打开，成功态没有错误遮罩或裸错误文本；设计预览可切换模型不可用、配置待处理和请求未完成三种状态，并可进入“重新发送中”。
- 说明：当前验证使用本地不可达模型地址模拟 LLM 请求失败；真实额度、错误 Key、网络超时和具体 Provider 返回错误仍可按同一组件路径补做实机回归，但不影响本次组件结构、重试载荷和按钮布局验收。
