# Agent写作目标由LLM判断

## 分类与状态

- 分类：功能优化。
- 状态：已完成，待实机回归。

## 背景与目标

同一对话已有新建或修改过的 Markdown 文件时，服务端会用关键词正则和近期操作记录预先判断当前请求是否需要选择旧文件或新建文件。该规则无法覆盖自然语言表达，例如“再写一个技术实现文档”，会在用户已明确新建意图时错误弹出确认卡，并让确认卡续跑链路成为不必要的阻塞点。

移除这项服务端写作目标预检。当前请求、最近对话和真实工作区状态由 Agent LLM 综合判断；只有目标确实不明确时，Agent 才通过 `ask_question_card` 主动提问。

## 范围与非目标

- 移除 `/api/agent/loop/start` 在创建 session 后自动生成“确认写作目标”卡片的逻辑。
- 移除仅为该预检服务的近期文章候选与明确新建关键词判断。
- 保留 Agent 的最近对话上下文、文件工具、`ask_question_card`、写入预览与人工确认机制。
- 不改变文件写入权限、删除禁令、Diff 应用/回滚、session token 安全边界或确认卡跨刷新恢复策略；该策略另由 BUG-20260731-001 跟进。

## 影响分析

| 维度 | 已确认内容 |
|---|---|
| 写入入口 | `/api/agent/loop/start` 不再创建 `write_target_ambiguous` interaction、assistant 提示消息或 checkpoint；后续是否创建文件、修改文件或提问由 Agent Tool 调用决定。 |
| 读取方与状态传播 | `runAgentLoop` 继续向 Prompt 注入最近对话；`FileAgentWorkspace` 仅渲染 Agent 主动创建的确认卡。会话列表、消息、SSE 与 Diff 无需适配新的状态格式。 |
| 失败、取消与恢复 | 不再因自动写作目标卡进入 `waiting_confirm`，从而减少该场景依赖 session token 续跑的机会。LLM 主动发起的确认卡仍使用现有 checkpoint、取消和恢复机制。 |
| 平台与安全边界 | Web、Electron 和懒猫共用服务端 Agent Loop；不新增前端 token 持久化，不暴露 session token、密钥或工作区路径。 |
| 已检查但不受影响 | `preview_file_revision`、`preview_patch_files`、`create_note`、文件索引、MCP/Skill 资源确认和图片写入链路均保留原行为。 |

## 行为验收矩阵

| 场景 | 前置条件 | 操作 | 预期结果 | 验证状态 |
|---|---|---|---|---|
| 明确新建 | 同一对话已应用一篇 Markdown 文件 | 输入“再写一个技术实现文档” | 不出现服务端候选文章卡；Agent 根据上下文直接开始新建文档任务 | 自动化静态回归通过；待实机验证 |
| 明确承接修改 | 同一对话已有文章 | 输入“继续修改刚才那篇文档” | Agent 从最近对话与工作区定位目标，必要时读取文件后生成修订预览 | 自动化静态回归通过；待实机验证 |
| 意图不明确 | 同一对话已有多篇相关文档 | 输入“再写一下这个” | 由 Agent 判断上下文；仍无法定位时才主动调用 `ask_question_card` | 自动化静态回归通过；待实机验证 |
| 既有写入安全 | 任意写作任务 | Agent 创建或修改文件 | 仍经既有写入工具和 Diff/确认策略执行，不发生直接越权写入 | 已通过 Agent Loop 预览回归；待实机验证 |

## 文档同步

- 已更新：`Requirements/需求总台账.md`、本需求记录、PDD、PRD、UI Guide、`docs/文件工作区Agent业务流程.md`、`docs/Agent循环架构实现说明.md`、`docs/业务逻辑升级说明.md`。
- 已检查但不更新：`docs/项目进度.md`。本次不改变产品里程碑。

## 实现与验证

- 代码与配置：已移除服务端写作目标预检、近期文章候选和关键词分流；新增 `agent-writing-intent-routing` 回归测试，并清理旧预检测试。
- 已执行命令及结果：`node --check`（改动源码）、`node notus/tests/agent-writing-intent-routing.test.js`、`node notus/tests/agent-loop-preview-completion.test.js`、`node notus/tests/agent-loop-error-recovery.test.js`、`node notus/tests/conversation-interactions.test.js`、`node notus/tests/workspace-continuity.test.js`、`npm --prefix notus run lint` 与 `git diff --check` 均通过。
- 待实机回归：Web、Electron、懒猫分别验证上述四类场景。
