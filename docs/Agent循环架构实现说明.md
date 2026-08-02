# Notus Agent Loop 架构实现说明

> 当前代码版本：0.1.13
> 更新时间：2026-08-01
> 适用范围：文件工作区现行 Agent Loop。旧 `/api/chat`、旧 `/api/agent/run` 和历史 session 只作兼容。

## 1. 设计边界

Notus Agent Loop 负责对话、工具调用、提问卡片、文件预览、恢复、取消和回滚。0.1.13 的控制面围绕四条边界实现：

- 同一 session 同时只能有一个 run。
- 用户回答、续跑任务和 checkpoint 必须可跨刷新恢复，重复请求不能重复执行模型或工具。
- system、历史消息、工具 Schema、动态材料和输出预留统一进入上下文预算。
- Skill、MCP、网页、知识库、附件和长期记忆均视为数据，不能覆盖系统策略或扩大工具权限。

Agent 仍可在 notes 根目录内创建、修改、重命名和移动文件或目录。删除能力不开放。文件路径统一经 `resolveInsideNotes()` 校验，前端不提交 `authorized_paths`。Agent 资料/文件回执卡由 `AGENT_TASK_RECEIPTS_ENABLED = false` 保持关闭，内部检索回执和 `get_task_activity` 继续工作。

## 2. 入口与模块

```text
FileAgentWorkspace
└── useAgentLoopController
    ├── POST /api/agent/loop/start
    ├── POST /api/interactions/:id/respond
    ├── POST /api/agent/sessions/:id/resume-interaction
    ├── POST /api/agent/loop/cancel
    ├── POST /api/agent/loop/apply
    └── POST /api/agent/sessions/:id/rollback

服务端
├── lib/agentControlPlane.js  # capability、resume job、lease、取消、usage
├── lib/agentSession.js       # session、checkpoint、Loop 事件窗口
├── lib/agentLoop.js          # 主循环与 SSE v2 语义事件
├── lib/llmBudget.js          # 单次与累计上下文预算
├── lib/agentToolPolicy.js    # Ajv 校验、结果限制与脱敏
├── lib/agentTools.js         # 文件、检索、提问和预览工具
├── lib/mcp.js                # 外部 MCP 调用、signal、timeout、脱敏
└── lib/prompt/agent-loop/*   # Prompt Registry 与 Envelope
```

所有现行 Agent API Route 先执行 `ensureRuntime()`。`/api/health` 是仓库规则明确列出的唯一例外。

## 3. 数据库迁移

迁移 `006_agent_control_plane` 只新增字段和表，不删除旧数据。

### 3.1 `agent_sessions` 新字段

- `state_version`：状态乐观锁版本。
- `active_run_id`：当前持有 lease 的 run。
- `lease_expires_at`：lease 到期时间。
- `cancel_requested_at`：显式取消时间。
- `last_committed_checkpoint_id`：最近成功提交的 checkpoint。
- `prompt_version`：本次使用的 Prompt Registry 版本。
- `toolset_version`：启用工具集合的稳定 Hash。
- `token_budget_total`：session 累计 token 上限。

### 3.2 新表

- `agent_checkpoints`：版本化 checkpoint，状态为 `active` 或 `superseded`。
- `agent_resume_jobs`：以 `interaction_id` 唯一约束保证一份回答只生成一个续跑任务。
- `agent_capabilities`：保存票据 nonce Hash、用途、owner、到期与消费状态。
- `agent_run_usage`：逐次记录主 LLM、图片识别、查询规划和 rerank 用量。
- `agent_run_events`：保存经过字段白名单、大小限制和 secret scan 的 `progress / artifact / final` 时间线，用于跨刷新重建工具链和中断前回复。

旧字段保留给 0.1.13 兼容读取。新链路不再把旧状态、inline checkpoint、`authorized_paths` 或 `agent_snapshots` 当作事实来源。

## 4. Session 状态机

```text
created → running → waiting_interaction → queued_resume → running
        → waiting_limit_confirmation
        → waiting_retry | waiting_model_recovery → running
        → completed | failed | cancelled
```

- `created`：session 和用户消息已入库，run 尚未开始。
- `running`：run 已取得 lease。
- `waiting_interaction`：等待提问卡片或资源交互回答。
- `queued_resume`：回答已提交且 resume job 已创建，等待 run 接管。
- `waiting_limit_confirmation`：累计任务预算耗尽，等待用户确认扩容。
- `waiting_retry`：临时模型错误的有界重试已耗尽，checkpoint 保留，可原任务续跑。
- `waiting_model_recovery`：额度、密钥、权限或模型可用性需要用户处理，完成后可原任务续跑。
- `completed / failed / cancelled`：终态。

历史 `pending` 迁移为 `created`，历史 `waiting_confirm` 按 checkpoint 原因迁移为 `waiting_interaction` 或 `waiting_limit_confirmation`。每次新 run 都清空连续工具失败和重复结果窗口。

## 5. Capability 与幂等恢复

### 5.1 Scoped ticket

0.1.13 保持单用户产品架构，控制权限使用短期 HMAC capability ticket。密钥位于应用数据目录：

```text
secrets/agent-capability.key
```

文件创建后权限固定为 0600。票据绑定：

```text
session_id / interaction_id / resume_job_id / action / owner_id
expires_at / nonce
```

票据只通过请求体或请求头传递，不进入 URL、运行日志或消息正文。数据结构预留 `owner_id`；未来接入登录后，消费票据时必须同时匹配当前 owner。旧 session token 只作显式兼容，不在 query 中传递。

### 5.2 回答和续跑

`POST /api/interactions/:id/respond` 在同一个 SQLite 事务内完成：

1. 校验 `respond_interaction` ticket。
2. 保存回答并更新 interaction。
3. 创建或读取 `interaction_id` 唯一的 resume job。
4. 将 session 置为 `queued_resume`。
5. 返回绑定 job 的短期 `resume_interaction` ticket。

同一回答重复提交只返回同一 resume job。前端随后调用：

```text
POST /api/agent/sessions/:id/resume-interaction
body: resume_job_id + resume_ticket
```

接口获取 run lease 后恢复 checkpoint，并通过 SSE 继续执行。会话详情 `GET /api/conversations/:id` 返回 pending interaction、未完成 resume job 和短期控制票据，所以刷新、重开或隔天进入对话时不依赖浏览器内存中的 session token。

## 6. Run lease、取消与超时

- lease 默认 90 秒。
- 运行中每 20 秒续租。
- 状态更新同时匹配 `active_run_id` 和 `state_version`。
- session 仍为 `running` 且已有不同的未过期 run 时，第二个 run 接管失败并返回 `SESSION_RUN_CONFLICT`。session 已进入 `queued_resume / waiting_retry / waiting_model_recovery` 时，旧 Loop 已停止执行，新 run 可以接管 API 收尾阶段尚未清空的 lease；旧 run 的条件释放不会影响新 run。
- 每个活动 run 注册 `AbortController`。
- 取消接口写入 `cancel_requested_at`，再中止当前进程内的 LLM、MCP 和受支持联网请求。
- LLM 总请求默认超时 180 秒；MCP 与联网工具默认 30 秒，统一从 `lib/config.js` 读取。
- SSE 每 15 秒发送 comment heartbeat，防止空闲代理提前关闭连接。

浏览器断线不等于用户取消。断线时保存 checkpoint，并将可继续任务保留为 `queued_resume`；显式取消才进入 `cancelled`。Provider SDK 没有暴露 AbortSignal 的调用，Harness 可停止等待和后续 Loop，但底层 Promise 是否立即终止仍取决于 Provider。

## 7. Checkpoint 两阶段提交

checkpoint 写入 `agent_checkpoints`，提交顺序如下：

1. 读取当前 active checkpoint，旧记录保持不变。
2. 写入新的 checkpoint 内容。
3. 在事务内把新记录设为 `active`，更新 session 的 `last_committed_checkpoint_id`。
4. 新记录成功后，旧记录才改为 `superseded`。

模型失败、数据库失败、进程退出或网络断线发生在第 3 步之前时，旧 active checkpoint 仍可恢复。恢复后产生的首个新模型响应或新 checkpoint 成功提交，才淘汰旧记录。历史 inline checkpoint 继续兼容读取。

## 8. 上下文与累计预算

### 8.1 单次请求预算

统一预算覆盖 system、messages、tool schemas 和输出预留。context window 的 10% 固定为安全余量，不参与借用。可用区的软配额为：

- system 与 tool schemas：20%。
- 当前任务：20%。
- 活动工具链：25%。
- 动态材料：25%。

软配额空余可借用。输入达到硬预算 85% 时压缩到 75%；Provider 返回 overflow 后强制压缩到 60%，只重试一次。仍超限时保存 checkpoint，并返回 `CONTEXT_BUDGET_EXCEEDED`。

压缩时保留当前任务、未完成 tool use/result 和最近两轮工具链。历史成功结果转换为确定性摘要，不依赖额外模型调用。

### 8.2 累计 session 预算

默认累计预算等于模型 context window：

- 70%：主动 compact。
- 85%：停止加载非必要动态材料和可选工具。
- 100%：进入 `waiting_limit_confirmation`。

用户确认继续后增加 25% token 预算，并增加 10 轮 hard limit。主 LLM、图片识别、查询规划和 rerank 分项写入 `agent_run_usage`。Provider 没有返回 usage 时使用估算值，并标记 `usage_source=estimated`。`final` 事件返回整个任务的累计值，不使用最后一次调用覆盖前序用量。

## 9. Loop 守卫

死循环和工具失败检测使用 session 级最近事件窗口，只统计相邻事件：

- 相邻且同工具、同结果连续三次时终止为 `deadloop_detected`。
- 相邻失败达到阈值时终止为 `consecutive_tool_failure`。
- 任一成功工具、不同结果、新用户回答或新 run 都重置相应连续窗口。
- 非连续重复调用和中间夹有成功结果的失败不会误判。

新 Loop 启动与恢复不再调用全库 `snapshotFiles()`。只有创建或应用 operation set 时，才保存涉及路径的 base Hash 和必要内容。session 级回滚从已应用 operation set 逆序聚合；旧 `agent_snapshots` 仅服务历史 session。

## 10. Prompt Registry

默认版本为 `agent-loop-v2`，可通过环境变量显式回退 `legacy-v1`。Registry 目录：

```text
lib/prompt/agent-loop/
├── version.js
├── policy.js
├── workspace.js
├── writing.js
├── research.js
├── resources.js
├── interactions.js
├── output.js
├── envelope.js
└── render.js
```

每个模块声明模块 ID、规则 ID、优先级、适用条件、token 上限和 eval case。render 阶段：

- 拒绝重复规则 ID。
- 拒绝显式冲突规则。
- 校验动态材料配额。
- 记录 prompt version、启用模块和 toolset Hash。

Skill、MCP、网页、知识库、附件和长期记忆在进入 Prompt 前包装为 Envelope：

```json
{
  "source_type": "mcp",
  "source_id": "stable-id",
  "trust": "untrusted",
  "content": "...",
  "truncated": false,
  "digest": "sha256:..."
}
```

用户维护的全局 Agent 文件可标为 `user_managed`，仍低于 policy 和工具权限。Envelope 内容不得作为系统指令执行。

## 11. Tool Harness

Ajv 8 是直接依赖。所有 tool input 在执行前按工具的 JSON Schema 校验，失败统一返回：

```json
{ "code": "INVALID_TOOL_INPUT" }
```

结果大小限制：

| 来源 | 单次上限 |
|---|---:|
| 文件读取 | 256KB |
| Skill | 128KB |
| 知识库 | 96KB |
| MCP / 网页 | 64KB |

`read_file` 接受 `offset_line / line_limit`，返回 `total_lines / truncated / next_offset`。截断结果保留稳定 source ID 和继续读取方式。MCP 输出在进入日志或 Prompt 前执行敏感字段脱敏、高熵 secret scan 和大小裁剪。

知识库与联网检索继续使用服务端 3→5 查询计划：先执行原词在首位的 3 条查询，证据不足再补 2 条。旧失活工具计数字段不参与新 Loop。

## 12. SSE v2

`session_created` 声明：

```json
{ "type": "session_created", "protocol_version": 2 }
```

之后只有三个用户语义通道：

- `progress`：短进展，仅在运行态显示，不保存为最终消息。
- `artifact`：interaction、operation set、资料状态、文件状态和限制确认。
- `final`：只出现一次，保存为最终 assistant message，并携带累计 usage。

工具内部日志与 SSE 用户事件分离。前端在 0.1.13 同时解析旧事件，服务端现行 Loop 只输出 v2 语义事件。现行 v2 事件会先写入 `agent_run_events` 再发送；会话恢复优先用该时间线重建工具链和中断前回复，旧 session 从 `agent_run_logs` 降级恢复。最终消息以事件 ID 和运行序号去重；连接重放或 React 重渲染不能写入第二条 assistant 消息，中断前回复草稿也不能写成 final 消息。

## 13. 安全 API 边界

- `/api/health` 是 `ensureRuntime()` 的唯一明确例外，只返回状态、版本和能力布尔值，不返回绝对目录和底层异常。
- `/api/logs` 调用 `ensureRuntime()`；默认仅真实 loopback 可访问。远程诊断必须提供 `NOTUS_DIAGNOSTICS_TOKEN`。
- `/api/models` 调用 `ensureRuntime()`。
- capability、Provider key、Cookie、MCP Header/env 和完整网页正文不得进入运行日志、SSE 或最终消息元数据。

## 14. 兼容与冻结

- 旧 `/api/chat`、`/api/agent/run` 保留，不再增加新行为。
- 文件工作区只调用现行 Agent Loop。
- 旧 session token 只在请求体或请求头兼容，不能放入 query。
- 旧 SSE 由前端兼容解析；新 Loop 只发 v2。
- `legacy-v1` session 可读取旧 inline checkpoint 和 `agent_snapshots`。
- 数据库旧字段保留到 0.1.14 再评估删除，不得作为 0.1.13 新功能的数据源。

## 15. 验证入口

根级 `npm run test:all` 运行全部 Node 测试和离线 JSONL Prompt Eval。重点用例覆盖：

- ticket 过期、重复消费、跨 interaction、owner 绑定。
- 回答与 resume job 幂等、run lease 冲突与续租。
- checkpoint 的模型失败、数据库失败和进程重载。
- 上下文安全余量、长消息、长 tool result 和 overflow 单次重试。
- LLM/MCP 取消、超时和 SSE heartbeat。
- 相邻重复判断、新 run 重置和非连续失败不误判。
- 1 万篇笔记启动普通任务时不生成全库快照。
- Prompt 冲突、动态材料配额、恶意外部指令和 secret scan。
- SSE `progress / final` 分离、final 单次保存和累计 usage。
- legacy migration、旧 token 兼容和 Prompt 回退。

真实模型 Eval 使用独立命令，并要求 `NOTUS_RUN_LIVE_AGENT_EVAL=1` 与隔离数据目录。没有 Provider 凭据时只记录为待实模验证，不影响代码阶段完成。Web、Electron、懒猫、对象存储、多 Provider 和真实多文件回滚仍需分别做实机回归。

## 16. LLM 失败重试与任务续跑

Harness 在每次主 LLM 请求前提交可恢复 checkpoint。临时错误最多额外重试 3 次，退避为 1s/2s/4s；额度、密钥、权限和模型可用性问题不自动重试。分类与状态映射为：

```text
retryable       → waiting_retry
action_required → waiting_model_recovery
fatal           → failed
```

`waiting_retry / waiting_model_recovery` 不是终态。会话详情继续签发 resume ticket，`acquireRunLease()` 允许两种状态接管。SSE 先以 `progress:llm_retry` 更新工具链；耗尽或需要用户处理时输出 `artifact:run_error`，不输出 `final`。Route 在发送可恢复错误前释放旧 lease，前端等 SSE 收尾后才开放继续按钮，并以同步 in-flight 锁拦截重复点击。前端的“继续任务”使用原 session 和 checkpoint，已保存的 tool result 作为 messages 恢复，不重新执行已完成工具。Provider 原始响应正文不进入 SSE 或最终消息。
# 持久化队列执行层（2026-08-01）

Agent Loop 由 `agentTaskWorker` 而非 API 请求执行。Worker 在 runtime 初始化时扫描任务表，按会话 FIFO claim，并用已有 lease/checkpoint 保护执行。SSE 只是可随时断开的观察通道，事件游标用于补发。Worker 对最终助手消息使用 task 的 `final_message_id` 幂等保护；交互回答创建 resume job 后唤醒原 task。
