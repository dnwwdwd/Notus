# 手动模式 Diff 生成即结束 Agent 任务

## 分类与状态

- 分类：功能优化 / 用户体验优化。
- 状态：已完成（自动化验证通过；真实 Provider、Electron 与懒猫待实机回归）。
- 对应台账：`REQ-20260813-004`。

## 背景与目标

手动应用模式此前在生成 Diff 后把 Agent session 置为等待确认。用户应用或废弃 Diff 时，系统会恢复原 checkpoint 并再次请求模型，产生没有业务价值的收尾总结，也会继续占用同一对话的 FIFO 队列。

本次将手动模式的任务完成边界收敛到“Diff 已生成”：生成预览即结束 Agent 任务；后续应用、废弃或回滚只处理该 Diff 和文件状态，不再恢复模型、Worker 或队列任务。

## 范围与非目标

- 手动模式生成文件或目录 Diff 后持久化最终事件、完成 session 和队列任务，并保留 Diff 的应用、废弃、回滚与累计详情入口。
- 应用或废弃完成后同步累计 Diff 的状态和文件树刷新，但不新增助手收尾消息，不发起新的 LLM 请求。
- 兼容旧版本遗留的 `waiting_operation_confirmation` session：用户处理该 Diff 后直接收口为完成态，不再续跑。
- 自动确认模式仍逐批安全应用并继续原任务；提问卡片、模型失败恢复、对外 MCP 手动审核均不改变。

## 影响分析

| 维度 | 结论 |
|---|---|
| 写入入口 | `agentLoop` 在手动 Diff 生成后完成任务；`/api/agent/loop/apply` 仅应用、废弃或回滚 operation set，并同步任务变更集。 |
| 读取方与状态传播 | Worker、任务队列、session 详情、SSE 时间线、累计 Diff 卡及文件树刷新均以完成态和 operation set 状态恢复；前端不再重新订阅或恢复该 session。 |
| 失败、取消与兼容 | 应用仍执行路径、Hash、原文和图片安全校验；旧等待确认任务在处理 Diff 后直接完成；失败、取消、提问和模型恢复路径保持原有语义。 |
| 平台与安全 | Web、Electron、懒猫共享服务端状态机；不改变 ticket 权限、文件授权范围、媒体存储或密钥脱敏边界。 |
| 已检查但不受影响 | 知识库对话、非 Agent 画布、对外 MCP 手动变更和自动确认多批续跑不使用该手动 Agent 收尾路径。 |

## 行为验收矩阵

| 场景 | 操作 | 预期结果 | 结果 |
|---|---|---|---|
| 手动生成 Diff | Agent 在手动模式产生文件修订 | 一次模型调用后发送 `manual_preview_generated` 最终事件，session 与队列任务完成，Diff 保持待处理。 | 自动化通过 |
| 应用 Diff | 点击全部应用 | 文件写入、累计 Diff 更新为已应用；模型调用次数不增加，session 与队列保持完成。 | 自动化通过 |
| 废弃 Diff | 点击废弃本批修改 | 累计 Diff 移除待处理项；不恢复 session 或生成助手总结。 | 路由与状态逻辑覆盖 |
| 旧等待确认会话 | 处理旧版本创建的待确认 Diff | 操作完成后直接结束旧 session 和队列任务，不再唤醒 Worker。 | 路由逻辑覆盖 |
| 自动模式 | 自动确认产生多批修改 | 继续原有逐批应用与任务续跑。 | 既有回归覆盖 |

## 文档同步与验证

- 已更新：需求总台账、既有 Agent 累计 Diff 需求与技术方案、PDD、PRD、界面规范、文件工作区 Agent 流程、业务逻辑升级说明与项目进度。
- 未更新：`docs/文档地图.md`；功能域、主要代码入口和验证入口均未新增或迁移。
- 已执行：`node notus/tests/agent-loop-preview-completion.test.js`、`node notus/tests/agent-execution-segment-timeline.test.js`、相关语法检查。
- 待实机回归：真实 Provider 下手动生成、应用、废弃、刷新恢复，以及 Electron、懒猫文件树刷新。
