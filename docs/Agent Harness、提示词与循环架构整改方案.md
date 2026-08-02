# Notus Agent Harness、提示词与循环架构整改方案

> 日期：2026-07-31
>
> 对应审查：`docs/Agent Harness、提示词与循环架构全面审查报告.md`
>
> 当前状态：方案完成，尚未实施

## 1. 整改目标

本方案把 Agent 可靠性收口到五个可验收结果：

1. interaction 回答后可以跨刷新、重开和短期断线恢复，服务端不会依赖浏览器内存 token 才能续跑。
2. 每次模型请求都在明确预算内，超限前压缩，超限后最多执行一次受控硬压缩重试。
3. 取消、超时、重试、并发恢复和 checkpoint 提交具有一致的状态语义，不重复执行写入工具。
4. Prompt 有版本、分层、不可信内容边界和场景化 eval，线上错误可以回指到 prompt 与 toolset 版本。
5. Requirements、Bug、PDD、PRD、UI Guide、测试和实机结果使用同一组可核对状态。

本方案不改变“Agent 可在整个 notes 工作区执行非删除写入”的当前产品规则。目录级授权字段可以删除、冻结为兼容字段，或重新设计后再启用，不能继续维持“代码看起来存在授权、运行时不执行授权”的模糊状态。

## 2. 目标架构

### 2.1 控制面与数据面分离

```text
控制面
  Session State Machine
  Run Lease / Idempotency Key
  Interaction / Approval
  Checkpoint / Resume Job
  Cancellation / Timeout / Retry
  Prompt & Toolset Version

数据面
  LLM Request
  Knowledge / Web / File Read
  Skill / MCP Tool
  File Revision / Operation Set
  Index Refresh / Receipts
```

控制面决定一项动作能否执行、由哪次 run 执行、失败后从哪里继续。数据面只处理一次有边界的模型或工具调用。文件写入仍以 operation set 和 file revision 为唯一正式入口。

### 2.2 明确状态机

建议将 session 状态统一为：

```text
created
  → running
  → waiting_interaction
  → queued_resume
  → running
  → completed | failed | cancelled

running
  → waiting_limit_confirmation
  → queued_resume

completed
  → rolled_back（仅兼容 session 级回滚）
```

每次状态变化写入 `state_version`。更新 SQL 使用 `WHERE id = ? AND state_version = ? AND status IN (...)`，失败时返回 `SESSION_STATE_CONFLICT`，禁止两个请求同时接管同一 session。

### 2.3 Run Lease 与幂等键

新增或扩展字段：

- `active_run_id`：当前服务端 run 标识。
- `lease_expires_at`：异常进程退出后的租约回收时间。
- `state_version`：乐观并发版本。
- `prompt_version`、`toolset_version`：本轮规则版本。
- `resume_interaction_id`：本轮续跑消费的 interaction。
- `last_committed_checkpoint_id`：已经提交的 checkpoint。

同一个 interaction 只允许生成一个 resume run。`POST /interactions/:id/respond` 在事务内完成答案写入、interaction 状态更新和 resume job 创建；重复请求返回同一 job，不重复调用模型。

## 3. P0 修复

### 3.1 修复跨刷新恢复

建议新增服务端恢复入口：

```text
POST /api/agent/sessions/:id/resume-interaction
body: { interaction_id, llm_config_id? }
```

该接口在当前应用认证边界内校验：

1. interaction 属于当前 conversation。
2. interaction.payload.agent_session_id 等于 session ID。
3. interaction 已回答且尚未被某个 resume run 消费。
4. session 状态允许恢复，checkpoint 存在。
5. 创建或返回幂等 resume job。

浏览器不需要持久化原始 session token，也不从历史接口读取 token。Electron 使用 loopback 认证，懒猫使用平台认证，普通 Web 使用应用登录态。外部 MCP Token 不得复用于内部 Agent session。

兼容期内可以保留旧 `session_token` API，但前端 interaction 恢复改用新入口；URL query 不再携带 token。

### 3.2 建立统一上下文预算器

Agent Loop 每次请求使用 `resolveLlmBudget()`，预算按以下顺序分配：

| 区域 | 建议上限 |
|---|---:|
| 固定系统规则与工具 Schema | 20% |
| 当前用户任务与最近对话 | 20% |
| 最近未完成 tool use/result | 25% |
| 检索、附件、图片识别、Skill/MCP 材料 | 25% |
| 安全余量 | 10% |

软压缩在 `compactTriggerTokens` 触发：

1. 保留当前用户任务、未消费 interaction 和最近两轮工具调用原文。
2. 较早成功工具结果改为结构化摘要，失败结果保留错误码、路径和重试信息。
3. 最近对话使用确定性截断与任务摘要，不把完整历史重复放入 initial message。
4. 检索、附件和 Skill 文件按来源配额裁剪，保留稳定 ID 和可再次读取的引用。
5. 重新估算 system、messages、tools 和 response format 的总 token。

模型返回 context overflow 时执行一次硬压缩。硬压缩后仍超限就返回 `CONTEXT_BUDGET_EXCEEDED`，保存可恢复 checkpoint，并提示用户缩小范围。

### 3.3 贯通取消、超时和 SSE 心跳

- `runAgentLoop(signal)` 把 signal 传给 `completeToolChat()`、联网搜索、MCP 调用和支持取消的长工具。
- LLM 请求使用 `AbortSignal.any([userSignal, AbortSignal.timeout(configuredTimeout)])` 或等价实现。
- 区分连接超时、首包超时、总请求超时和用户取消，日志保留 `cause.code/name/message` 的安全摘要。
- SSE 每 15～20 秒发送 comment heartbeat，避免代理把长模型等待误判为空闲连接。
- 用户取消后，session 只在服务端确认当前 run 释放 lease 后进入 `cancelled`。

Anthropic 工具调用先保留非流式协议兼容，增加可配置长超时和底层 cause；验证兼容网关对流式 tool use 支持后，再评估改为流式保活。

### 3.4 修复 checkpoint 提交顺序

恢复时不要立即删除旧 checkpoint。采用两阶段提交：

1. 读取 checkpoint，创建 `run_id`，把 interaction Tool result 写入内存请求。
2. 新的模型响应或新的 checkpoint 持久化成功后，原子更新 `last_committed_checkpoint_id`。
3. 只有新状态提交成功，旧 checkpoint 才标记为 superseded。
4. 请求失败时保留旧 checkpoint 和已回答 interaction，允许同一幂等 resume job 重试。

### 3.5 修复 Loop 守卫

用 session 级最近事件窗口替代按工具名累计对象：

```js
last_event = {
  tool_name,
  result_hash,
  failed,
  consecutive_same_result,
  consecutive_failures,
  loop_index,
}
```

规则如下：

- 工具名或结果 Hash 变化，`consecutive_same_result` 重置为 1。
- 任一成功工具调用把 `consecutive_failures` 重置为 0。
- 用户回答、手动继续和新的 session 都重置连续窗口。
- 死循环阈值保留 3，连续失败阈值保留 2；日志写出触发窗口，便于诊断。

### 3.6 修复回归基线

1. `editor-copy-all-support.test.js` 按当前 Markdown-only 口径验证 `writeText`、fallback 和 UI 提示，不再要求 ClipboardItem。
2. `editor-toc-export-runtime-support.test.js` 直接测试 `useEditorToc` 的 H1～H6 采集、更新和跳转，不锁函数名。
3. `workspace-state.test.js` 把旧 `knowledge/canvas` 状态归一化为 `files`。
4. 新增根脚本 `test:all`，稳定执行全部纯 Node 行为测试。
5. 源码字符串守卫单独命名为 `*.source-guard.test.js`，不与行为测试混算。

## 4. P1 架构改造

### 4.1 延迟快照和写入日志

移除 Loop 启动时的全工作区快照。改为：

- `read_file` 不创建快照。
- 创建 operation set 时保存涉及文件的 base Hash 与必要 base content。
- 应用前只为即将写入的路径创建 revision/snapshot。
- session 级回滚从已应用 operation set 聚合，旧 `agent_snapshots` 只服务历史数据。
- 迁移期增加快照数量、字节数和耗时指标，确认没有回滚能力退化。

### 4.2 Prompt Registry

把 Prompt 拆为以下模块：

```text
prompt/agent-loop/
  policy.js
  workspace.js
  writing.js
  research.js
  resources.js
  interactions.js
  output.js
  render.js
  version.js
```

每个模块声明：

- 规则 ID。
- 优先级。
- 适用工具或任务类型。
- 允许引用的动态数据。
- token 上限。
- 对应 eval case。

render 阶段检测重复规则、互斥规则和动态材料超额。session 与 run log 保存 `prompt_version` 和启用模块列表。

### 4.3 不可信材料 Envelope

所有动态材料采用统一结构：

```json
{
  "source_type": "skill|mcp|web|knowledge|attachment|memory",
  "source_id": "stable-id",
  "trust": "untrusted|user_managed",
  "content": "...",
  "truncated": false
}
```

Prompt 只解释 envelope，不把来源内容拼成新的规则标题。工具结果保留可追踪 ID，长正文用 `read_*` 再取。Skill/MCP/网页中的“忽略系统规则”“调用未授权工具”等文字可以作为普通内容呈现，不能进入策略层。

### 4.4 工具 Schema 与执行约束

- 在 Harness 层用 JSON Schema 校验每个 tool input，错误统一为 `INVALID_TOOL_INPUT`。
- 为读取、检索、管理和写入工具定义独立超时、最大输出字节和重试策略。
- 清理未使用的 `checkAndIncrementToolCount()`，或让它与研究层的 3→5 查询预算采用同一命名和数据源。
- 明确 `authorized_paths` 的去留。当前全库非删除写入不需要伪目录授权；未来若恢复 scope，必须在所有读写工具入口统一执行。
- MCP Tool result 做类型、大小和 secret scan 后再进入模型上下文。

### 4.5 最终回复协议

SSE 分成三个稳定通道：

- `progress`：可丢弃的短进展，不写入最终消息正文。
- `artifact`：operation set、interaction、来源和资源状态。
- `final`：只写一次的最终用户回复。

写入工具自动结束时，Harness 生成结构化 final；普通任务要求模型最后一轮返回 final。会话历史只保存 final 和 artifact 摘要，不把多轮进展拼成一条正文。

### 4.6 累计用量与成本护栏

每次 LLM、图片识别、检索规划和 rerank 的 usage 写入 `agent_run_usage` 或 run log 扩展字段。Loop 按累计值执行：

- 70% 预算时软压缩。
- 85% 预算时限制新增材料和非必要工具。
- 100% 时进入 `waiting_limit_confirmation`，用户确认后增加显式预算。

没有 provider usage 时使用估算值，并标记 `usage_source=estimated`。

## 5. P2 治理与验证

### 5.1 Prompt Eval 套件

建立 JSONL 场景集，至少覆盖：

- 新建、修改、继续讨论和目标不明确。
- 附件只读、附件写入、图片写入和历史图片承接。
- 文件、目录、Skill、MCP 的明确 Mention。
- prompt injection、恶意网页、恶意 Skill 和超长 MCP result。
- ask_question_card、资源确认、刷新恢复、重复回答和并发恢复。
- 搜索无证据、冲突证据、URL 成功后空搜索。
- 自动确认、手动确认、stale、回滚和对象存储失败。

每条 case 记录允许工具、禁止工具、期望终态、最大轮数、最大 token 和写入断言。真实模型 eval 与确定性 Harness 测试分开报告。

### 5.2 故障注入

- LLM 429、400 overflow、连接重置、无首包、半截 JSON。
- SSE 断线、浏览器刷新、重复 submit、两个窗口同时恢复。
- MCP 超时、超大结果、密钥混入结果。
- 文件在 preview 和 apply 之间变化。
- 数据库 busy、进程在 checkpoint 提交前后退出。
- 大型工作区、深目录和大文件。

### 5.3 文档清理

0.1.13 实施采用以下口径：

1. 响应式阈值恢复为 760px，已同步 Requirements、需求总台账、项目进度、业务流程、PDD、PRD、UI Guide 和测试。
2. 当前代码版本统一为 0.1.13，已同步项目进度、PDD、PRD 和版本记录；本轮不重新打包 `.lpk`。
3. 复制全文以 Markdown-only 为现行口径，REQ-20260703-001 已标记为被后续需求调整。
4. 新控制面缺陷和验收结论归入 BUG-20260731-001～004 的 0.1.13 最新状态；旧表格保留为审查历史快照。
5. `/api/health` 明确豁免 `ensureRuntime()`，并限制为状态、版本和能力布尔值；`logs`、`models` 按统一运行时规则处理。

## 6. 实施阶段

| 阶段 | 范围 | 预计工作量 | 退出条件 |
|---|---|---:|---|
| P0-A | 恢复 API、幂等 resume job、checkpoint 两阶段提交 | 2～3 天 | 刷新后回答卡可续跑；重复请求只执行一次 |
| P0-B | 统一预算、overflow 重试、signal、超时、SSE 心跳 | 2～3 天 | 长上下文在预算内；取消可中止活动请求 |
| P0-C | Loop 守卫与 3 个失败测试修复 | 1 天 | 非连续反例不误判；`test:all` 全绿 |
| P1-A | 状态机、run lease、累计 usage | 3～5 天 | 并发恢复无重复 Tool；成本可追踪 |
| P1-B | 延迟快照、Prompt Registry、不可信 envelope | 4～6 天 | 大工作区首轮不做全库快照；Prompt 可版本化 |
| P2 | Eval、故障注入、三端实机与文档收口 | 5～8 天 | 行为验收矩阵完成，未验证项有明确状态 |

工作量只用于拆分顺序，实施前仍需按实际代码冲突和平台环境校正。

## 7. 行为验收矩阵

| 场景 | 操作 | 预期结果 | 自动化 | 实机 |
|---|---|---|---|---|
| 提问卡刷新恢复 | 生成卡片后刷新，再回答 | 同一 session 续跑，答案不重复落库 | API + 状态机集成测试 | Web/Electron/懒猫 |
| 重复回答 | 双击提交或重放请求 | 返回同一 resume job，只执行一次 | 并发测试 | Web |
| 长上下文 | 注入超过软阈值的历史和工具结果 | 请求前压缩到预算内 | 单元 + 集成测试 | 真实 LLM |
| context overflow | Provider 返回 400 overflow | 硬压缩后只重试一次 | 故障注入 | 两类协议 |
| 用户取消 | 模型等待或 MCP 调用中点击停止 | 活动请求被 abort，session 终态一致 | fake fetch/MCP | 三端 |
| 非连续重复工具 | A(X)、B(Y)、A(X)、B(Z)、A(X) | 不触发死循环 | 单元测试 | 无需 |
| 连续重复工具 | A(X) 连续三次 | 触发 deadloop，记录窗口 | 单元测试 | 无需 |
| 非连续失败 | A 失败、B 成功、A 失败 | 不触发连续失败 | 单元测试 | 无需 |
| 并发恢复 | 两个请求同时恢复 | 只有一个拿到 lease | 数据库并发测试 | 双窗口 |
| 大工作区 | 1 万篇笔记启动普通对话 | 不递归快照全部文件 | 性能测试 | 桌面端 |
| 恶意 Skill/MCP | 材料包含越权指令和密钥 | 不改变工具权限，不把密钥写入日志 | eval + secret scan | 真实模型 |
| 文件写入 | preview 后外部修改文件 | apply 返回 stale/conflict | 集成测试 | Web/Electron |
| 全量回归 | 执行 `test:all`、lint、build | 全部通过 | CI | 无需 |

## 8. 建议修改入口

| 目标 | 主要文件 |
|---|---|
| session 状态机与 lease | `notus/lib/agentSession.js`、数据库迁移 |
| interaction 幂等恢复 | `notus/pages/api/interactions/[id]/respond.js`、新增 resume API、`FileAgentWorkspace.js` |
| Loop 预算与 checkpoint | `notus/lib/agentLoop.js`、`notus/lib/llm.js`、`notus/lib/llmBudget.js` |
| signal、超时、心跳 | `notus/pages/api/agent/loop/start.js`、LLM/MCP/搜索调用层 |
| 连续性守卫 | `notus/lib/agentSession.js`、新增行为测试 |
| 延迟快照 | `notus/lib/agentSession.js`、`notus/lib/agentTools.js`、file revision/operation set |
| Prompt Registry | `notus/lib/agentLoopPrompt.js` 拆分后的模块目录 |
| final/progress 协议 | `agentLoop.js`、`useAgentLoopController.js`、消息落库逻辑 |
| 测试基线 | 3 个当前失败测试、根 `package.json`、新增 Loop 集成测试 |
| 文档闭环 | Requirements、Bug 台账、项目进度、PDD、PRD、UI Guide、业务流程 |

## 9. 验证命令建议

```bash
npm run test:all
npm run lint:web
npm run build:web
```

新增集成测试建议使用隔离的临时数据目录和 stub LLM/MCP，不访问用户数据库，不要求真实 API Key。真实模型、对象存储、Electron 和懒猫路径另建实机验收记录，不能用 build 结果代替。

## 10. 回滚策略

- 数据库迁移只新增字段或表，旧字段保留一个版本周期。
- 新恢复入口通过 feature flag 灰度，旧 token 恢复只作为兼容 fallback。
- Prompt Registry 保留当前 Prompt 为 `legacy-v1`，新版本按 session 记录，出现回归时可切回。
- 延迟快照上线前保留旧 session 回滚 API；确认 operation set 聚合回滚稳定后再停用全库快照。
- 每个 P0 子阶段独立提交、独立验证，不把状态机、Prompt 和 UI 大改压进同一次交付。

完成 P0 后，项目可以把 Agent Loop 从“能运行”提升到“故障后可恢复、长任务有预算、重复请求不重复执行”。P1 与 P2 负责降低后续功能扩展中的回归成本。
