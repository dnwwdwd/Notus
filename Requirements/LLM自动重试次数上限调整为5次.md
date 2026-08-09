# LLM 自动重试次数上限调整为 5 次

## 分类与状态

- 分类：功能优化。
- 状态：已完成（2026-08-08，本地自动化回归通过）。

## 背景与目标

当前 Agent 主 LLM 请求遇到临时网络、超时、临时限流或可恢复 5xx 错误时，最多额外重试 3 次。将这一上限调整为 5 次，降低短时 Provider 抖动对任务的影响；重试耗尽后仍保留 checkpoint，并按原有规则进入等待恢复状态。

本需求中的“5 次”指首次请求失败后额外发送 5 次，单轮主 LLM 调用最多产生 6 次请求。上下文超限的压缩重试属于另一条预算恢复逻辑，仍最多执行 1 次。

## 范围与非目标

- 范围：Agent Loop 主 LLM 临时错误的自动重试上限、指数退避、SSE/持久化事件中的重试次数，以及工具链的重试次数显示。
- 非目标：不改变错误分类、checkpoint、session 状态、队列 FIFO、恢复票据、用户消息重试、错误卡片重试或文件操作权限。
- 非目标：额度不足、API Key、权限、模型不可用、请求结构错误和上下文无法恢复等错误不因上限变化而自动重试。

## 影响分析

| 维度 | 已确认内容 |
|---|---|
| 写入入口 | `notus/lib/agentLoop.js:runAgentLoop()` 调用 `callLLMWithRetry()`；不新增 API 或数据库写入入口。 |
| 读取方与状态传播 | `onRetry` 生成 `progress.llm_retry`，带有 `retry_attempt` 和 `retry_limit`；`agentSession` 持久化白名单保留这些字段；`useAgentLoopController` 实时和历史工具链显示 `attempt/limit`。 |
| 失败与恢复边界 | 第 5 次额外重试仍失败时保持现有 `waiting_retry / waiting_model_recovery` 分类、checkpoint 和“继续任务”入口；成功时不改变最终回复和工具执行顺序。 |
| 平台与安全边界 | Web、Electron、懒猫共用 Agent Loop；不新增凭据、请求内容、日志字段或外部服务。退避时间从 1s、2s、4s 延伸为 1s、2s、4s、8s、16s。 |
| 已检查但不受影响 | `completeToolChat()` 的上下文超限压缩重试、Agent 任务队列、SSE 订阅、控制票据、错误卡片重试和文件 Diff 操作。 |

## 行为验收矩阵

| 场景 | 前置条件 | 操作 | 预期结果 | 验证状态 |
|---|---|---|---|---|
| 临时错误第 1～5 次 | Provider 返回 timeout、网络错误、408/425/429 或可恢复 5xx | 等待 Agent 自动处理 | 最多依次显示 `1/5`、`2/5`、`3/5`、`4/5`、`5/5`，按指数退避继续请求。 | 已完成，自动化通过 |
| 第 5 次额外重试后仍失败 | 连续 6 次请求均为可重试错误 | 等待重试结束 | 任务进入原有等待恢复状态，checkpoint 保留，不追加最终助手错误消息。 | 已完成，自动化既有恢复链路通过 |
| 额度、Key、权限或模型错误 | Provider 返回 action_required 错误 | 发送 Agent 任务 | 不自动重试，直接进入用户处理状态。 | 已完成，自动化通过 |
| 上下文超限 | 请求超过上下文预算 | 等待压缩处理 | 仍沿用 `completeToolChat()` 最多 1 次压缩重试，不叠加为 5 次临时错误重试。 | 已完成，代码复查通过 |
| 工具链历史恢复 | 已保存 `llm_retry` 事件 | 刷新或重新打开对话 | 按持久化事件显示真实的 `attempt/limit`，不再把缺省上限显示为 3。 | 已完成，前端静态回归通过 |

## 文档同步

- 已更新：本需求文档、`Requirements/需求总台账.md`、`docs/产品设计说明.md`、`docs/产品技术实现说明.md`、`docs/业务逻辑升级说明.md`、`docs/文件工作区Agent业务流程.md`、`docs/Agent循环架构实现说明.md`、`docs/项目进度.md`、`Requirements/NotusAgent持久化后台任务与Codex式工具链体验.md`。
- 已检查但不修改：错误卡片和消息级重试文档；它们继续复用原消息重新发送，不改变 Agent Loop 的自动重试分类。

## 实现与验证

- `notus/lib/agentLoop.js` 新增共享常量 `DEFAULT_LLM_RETRY_LIMIT = 5`，默认调用和主循环调用统一使用该值；退避沿用指数策略并扩展到第 5 次。
- `notus/hooks/useAgentLoopController.js` 的历史事件缺省显示上限改为 5，服务端事件带有真实 `retry_limit` 时优先使用事件值。
- `notus/tests/agent-llm-retry-resume.test.js` 覆盖连续临时错误时最多 6 次请求、5 个重试事件，以及额度错误不自动重试。
- 已执行：`node notus/tests/agent-llm-retry-resume.test.js`、`npm run test:all`、`npm run lint:web`、`git diff --check`。
