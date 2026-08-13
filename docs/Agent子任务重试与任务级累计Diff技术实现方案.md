# Agent 子任务重试与任务级累计 Diff 技术实现方案

> 实现状态（2026-08-13）：迁移、执行段、请求窗口、工具分发游标、任务变更集、手动 Diff 终态收口、累计详情接口、前端单卡展示和核心自动化已落地。当前实现复用现有 DiffDialog；手动模式首次生成 Diff 即完成原任务，后续应用或废弃只更新 Diff 与文件状态，`agent_resume_jobs` 不承载文件确认。文件系统写入后、元数据提交前的 `applying` 崩溃核对，逐资源分页详情和真实进程退出故障注入仍列为后续可靠性工作，不应写成已经验证。

> 状态：代码已实现，自动化验证通过，待 Web / Electron / 懒猫实机回归。
> 对应需求：`Requirements/Agent子任务重试与任务级累计Diff.md`。
> 适用范围：文件工作区 Agent、后台任务、checkpoint、文件预览与 Diff。

## 1. 当前实现与改造目标

当前 `callLLMWithRetry()` 的计数变量属于一次函数调用。每次主 LLM 调用都会重新从 0 开始，但 session 没有持久化的 sub task 标识，SSE 和前端通过 `loop_index` 关联重试记录。刷新、失败恢复和模型切换后，前端无法判断一次重试属于原执行段的新请求窗口，还是已经进入下一执行段。

改造前的文件变更使用 `canvas_operation_sets`。自动确认模式可以逐批应用并继续 Loop；手动确认模式会在第一个待确认 operation set 生成后结束 session。`FileAgentWorkspace` 过去按 `operation_set_id` 或 `agent_session_id` 选择一条 operation set，同 session 的后续记录会覆盖前一条，因此只适合单批展示。

技术改造需要完成四项工作：

1. 为每次主 LLM 决策请求建立可恢复的执行段和请求窗口。
2. 把 checkpoint 从“模型请求前快照”扩展为“模型请求、工具分发、等待文件确认”三阶段恢复记录。
3. 为每个 session 建立一个任务变更集，继续用 operation set 保存不可变批次。
4. 让工具链和 Diff 都从 session 级数据恢复，不再依赖最终助手消息是否带有最近一条 `operation_set_id`。

## 2. 技术选择

方案继续使用现有 Next.js Pages Router、Node.js、better-sqlite3、SQLite、SSE 和 React，不增加运行时依赖。

SQLite 事务只包住短时间的元数据写入，不包住 LLM、图片上传或文件系统操作。SQLite 同时只能执行一个写事务，长事务会阻塞其他任务；文件系统也无法参加 SQLite 事务。数据库与文件写入之间使用“两阶段状态 + Hash/路径核对”恢复。SQLite 的事务和唯一约束分别用于原子元数据更新与重复请求去重，依据为 [SQLite Transaction](https://www.sqlite.org/lang_transaction.html) 和 [SQLite UPSERT](https://sqlite.org/lang_upsert.html)。

不引入临时工作区副本。手动模式的 Diff 在生成后由用户独立决定是否写入正式工作区，原 session 已完成且不会恢复。这样 `read_file`、`analyze_folder`、索引和文件监听继续读取同一份真实数据。

## 3. 组件与数据流

```text
FileAgentWorkspace / AgentWorkspace
            │
            ├── GET session detail ─────────────┐
            ├── GET change-set detail           │
            ├── POST apply / discard / rollback │
            └── SSE events                      │
                                                ▼
API Routes ── Agent Task Queue ── Agent Worker ── Agent Loop
    │                 │               │              │
    │                 │               │              ├── execution segments
    │                 │               │              ├── LLM request windows
    │                 │               │              └── staged checkpoint
    │                 │               │
    │                 │               └── file tools / operation sets
    │                 │                              │
    ▼                 ▼                              ▼
session state   queue state                task change-set service
    │                 │                              │
    └─────────────────┴──────── SQLite ──────────────┘
                                                   │
                                                   ▼
                                      Markdown files / directories / index
```

数据流没有循环调用。前端只通过 API 和 SSE 读写服务端状态；Worker 不等待浏览器连接。Agent Loop 和 apply/rollback API 负责依次调用文件工具与任务变更集服务；任务变更集服务只读取 operation set、快照和文件状态，不调用 Agent Loop 或 `agentTools`。

## 4. 数据库迁移

新增迁移文件 `notus/lib/migrations/010_agent_execution_changes.js` 与 `011_agent_queue_resume_request.js`，并在 `notus/lib/db.js` 注册。迁移只增加表、字段和索引，不删除旧数据；续跑标记独立放在 011，确保已经应用过 010 的开发数据库也能继续升级。

### 4.1 `agent_execution_segments`

每条记录对应一个可恢复的主 LLM 执行段。

| 字段 | 类型与约束 | 用途 |
|---|---|---|
| `id` | INTEGER PK | 执行段 ID。 |
| `session_id` | FK，非空 | 所属 Agent session。 |
| `sequence_no` | INTEGER，非空 | session 内顺序号，从 1 递增。 |
| `loop_index` | INTEGER，非空 | 兼容现有 Loop 计数和日志。 |
| `status` | TEXT，非空 | `created / requesting / awaiting_tools / waiting_retry / waiting_model_recovery / completed / failed / cancelled`。 |
| `label` | TEXT | 初始为“规划下一步”，收到工具调用后更新为真实动作摘要。 |
| `tool_names_json` | TEXT | 本执行段返回的工具名称，不保存参数。 |
| `created_at / started_at / finished_at / updated_at` | DATETIME | 排序和恢复。 |

唯一索引为 `(session_id, sequence_no)`。查询未完成执行段时按 session 和状态读取最后一条。

### 4.2 `agent_llm_request_windows`

一次执行段可以有多个请求窗口。自动重试发生在一个窗口内；用户点击继续或切换模型后，原执行段增加新窗口。

| 字段 | 类型与约束 | 用途 |
|---|---|---|
| `id` | INTEGER PK | 请求窗口 ID。 |
| `execution_segment_id` | FK，非空 | 所属执行段。 |
| `window_no` | INTEGER，非空 | 执行段内从 1 递增。 |
| `run_id` | TEXT | 对应 run lease。 |
| `llm_config_id` | TEXT | 本窗口使用的模型配置 ID。 |
| `status` | TEXT，非空 | `requesting / succeeded / exhausted / action_required / fatal / interrupted / cancelled`。 |
| `retry_attempts` | INTEGER | 已执行的额外自动重试次数，范围 0～5。 |
| `retry_limit` | INTEGER | 当前固定为 5，保存实际值便于历史恢复。 |
| `error_category / error_code` | TEXT | 脱敏错误分类和错误码。 |
| `created_at / started_at / finished_at / updated_at` | DATETIME | 请求窗口历史。 |

唯一索引为 `(execution_segment_id, window_no)`。

### 4.3 `agent_task_change_sets`

每个 session 最多一条，作为累计 Diff 的稳定入口。

| 字段 | 类型与约束 | 用途 |
|---|---|---|
| `id` | INTEGER PK | 任务变更集 ID。 |
| `session_id` | FK，UNIQUE，非空 | 一个 session 对应一个变更集。 |
| `conversation_id` | FK，非空 | 会话校验。 |
| `approval_mode` | TEXT，非空 | `auto_confirm / manual_confirm`。 |
| `status` | TEXT，非空 | `active / waiting_confirmation / completed / failed / cancelled / partial / rolled_back / rollback_conflict`。 |
| `current_operation_set_id` | FK | 当前待确认批次。 |
| `version` | INTEGER，非空 | 任何批次或资源状态变化时加 1，供 SSE 和前端去重。 |
| `created_at / updated_at` | DATETIME | 排序和缓存判断。 |

### 4.4 `agent_task_change_items`

每条记录代表累计 Diff 中的一个逻辑文件或目录。初始快照保持不变，已应用快照和待确认快照随批次更新。

| 字段 | 类型与约束 | 用途 |
|---|---|---|
| `id` | INTEGER PK | 资源项 ID。 |
| `change_set_id` | FK，非空 | 所属任务变更集。 |
| `resource_key` | TEXT，非空 | 服务端生成的稳定资源标识。 |
| `resource_kind` | TEXT，非空 | `file / directory`。 |
| `base_exists` | INTEGER | 任务首次触及时是否存在。 |
| `base_path / base_hash / base_content` | TEXT | 初始路径、Hash 和 Markdown 正文；目录正文为空。 |
| `base_manifest_json` | TEXT | 目录移动前的 Markdown 相对路径与 Hash 清单。 |
| `applied_exists` | INTEGER | 当前已应用状态是否存在。 |
| `applied_path / applied_hash / applied_content` | TEXT | 最近一次成功应用后的状态。 |
| `pending_exists` | INTEGER，可空 | 当前待确认批次的候选状态。 |
| `pending_path / pending_hash / pending_content` | TEXT | 当前待确认结果。 |
| `status` | TEXT，非空 | `pending / applied / mixed / conflict / rolled_back`。 |
| `first_batch_no / last_batch_no` | INTEGER | 资源涉及的批次范围。 |
| `updated_at` | DATETIME | 详情缓存。 |

唯一索引为 `(change_set_id, resource_key)`。目录路径映射使用已存在的 directory item；按最长 `applied_path` 前缀反向映射到 `base_path`，使目录移动后首次修改的文件仍能恢复任务开始前路径。

### 4.5 `agent_operation_resolutions`

该表保存手动批次的最终决定，供 Diff 与任务变更集汇总读取；它不唤醒 Worker。

| 字段 | 类型与约束 | 用途 |
|---|---|---|
| `id` | INTEGER PK | 决定记录 ID。 |
| `session_id` | FK，非空 | 所属 session。 |
| `operation_set_id` | FK，UNIQUE，非空 | 一个批次只形成一次最终决定。 |
| `resolution` | TEXT，非空 | `applied / discarded / partial`。 |
| `tool_result_json` | TEXT，非空 | 应用或废弃的受控结果，供历史审计与兼容读取。 |
| `status` | TEXT，非空 | `resolved`；旧数据可保留既有状态。 |
| `created_at / updated_at` | DATETIME | 记录决定时间并支持幂等读取。 |

用户逐文件应用或废弃时继续使用 operation set 内的 patch status。全部 patch 均不再是 pending 后，才创建 resolution。整批“全部应用”和“废弃本批修改”会在一次请求内完成相同过程，不写回模型工具结果，也不恢复原 session。

### 4.6 现有表的增量字段

`canvas_operation_sets` 增加以下字段：

- `task_change_set_id`：所属任务变更集。
- `execution_segment_id`：创建该批次的执行段。
- `batch_sequence_no`：session 内批次顺序号。
- `tool_use_id`：模型工具调用 ID。

增加部分唯一索引 `(agent_session_id, tool_use_id)`，只约束非空值。Worker 重放相同工具调用时直接返回已有 operation set 的受控结果。

operation set 与 patch 状态已允许读取 `applying`，为后续文件写入中间态核对保留兼容空间；本次尚未把全部文件工具切换为先写 `applying` 再落盘，因此不能把该项视为已完成的崩溃恢复能力。

`agent_checkpoints` 增加以下字段：

- `phase`：`before_llm / dispatching_tools / after_tools`；历史记录中的 `waiting_operation_confirmation` 只作兼容读取，新手动 Diff 不再写入。
- `execution_segment_id`、`llm_request_window_id`。
- `tool_results_json`：已经完成的工具结果，按 `tool_use_id` 保存。
- `next_tool_index`：下一条待执行工具的位置。
- `pending_operation_set_id`、`resume_tool_result_json`：仅用于读取旧版等待确认记录；新手动 Diff 不写入或消费这两个字段。

主 LLM 返回的完整结构化 content 复用现有 `last_response_content_json`，不再增加同义字段。

旧 checkpoint 缺少 `phase` 时按当前格式读取，继续走兼容恢复逻辑。

## 5. 执行段与重试实现

### 5.1 创建执行段

Agent Loop 准备调用主 LLM 时先读取 active checkpoint：

- `before_llm` 且引用未完成执行段时复用该执行段。
- 上一执行段已经完成工具分发或最终回答时，新建下一条执行段。
- 新执行段与 `before_llm` checkpoint 在同一个 SQLite 事务内提交。

每次进入执行段都创建请求窗口。模型失败后用户点击继续，仍复用原执行段，`window_no` 加 1，重试次数重新从 0 计算。

### 5.2 自动重试

`callLLMWithRetry()` 保留本地循环，但接收 `requestWindowId`。每次额外重试发生时，服务端在一个短事务内完成三项更新：

1. 更新请求窗口的 `retry_attempts`。
2. 更新执行段为 `requesting`。
3. 写入带 `execution_segment_id` 和 `request_window_no` 的持久化 `llm_retry` 事件。

窗口成功后标记为 `succeeded`。连续 6 次请求仍失败时窗口为 `exhausted`，执行段为 `waiting_retry`，session 沿用 `waiting_retry`。额度、Key、权限或模型不可用时窗口为 `action_required`，执行段和 session 进入 `waiting_model_recovery`。

### 5.3 前端重试记录

SSE `llm_retry` 事件增加以下白名单字段：

- `execution_segment_id`
- `segment_sequence_no`
- `segment_label`
- `request_window_no`
- `retry_attempt`
- `retry_limit`

`buildEventStep()` 的 ID 从 `llm-retry-${loop_index}` 改为 `llm-retry-${execution_segment_id}`。同一执行段内的新事件更新同一行；不同执行段生成不同记录。展开详情按请求窗口显示各自的重试次数、模型配置摘要和结束状态，不显示 API Key、原始响应或请求正文。

## 6. checkpoint 与工具恢复

### 6.1 模型请求前

保存 `before_llm` checkpoint，包含当前 messages、执行段和请求窗口。LLM 或进程在请求期间失败时，可从这条记录重新发起同一执行段的新请求窗口。

### 6.2 模型成功后

收到模型 content 后不立即删除 checkpoint。服务端先写入 `dispatching_tools` checkpoint，保存完整 content、工具列表、空的工具结果集合和 `next_tool_index = 0`，再开始执行工具。

这项调整解决“模型已经返回工具调用，但进程在工具结果进入 messages 前退出”的恢复空白。Worker 重启后读取同一 content，从 `next_tool_index` 继续。

### 6.3 每个工具完成后

工具完成事件、脱敏日志、工具结果、`next_tool_index` 和 change set 版本必须先落库，Loop 才能执行下一工具或下一次 LLM 请求。

写入工具先查询 `(agent_session_id, tool_use_id)`：

- 已有 applied、pending 或 discarded operation set 时返回原批次结果。
- 已有 processing 记录时先执行文件状态核对。
- 没有记录时创建 operation set 和 change set 资源项。

所有工具完成后 checkpoint 改为 `after_tools`，随后把 assistant content 与 tool results 追加到 messages，再提交下一条 `before_llm` checkpoint。上一 checkpoint 只有在新 checkpoint 提交成功后才标记 superseded。

### 6.4 手动确认

手动预览生成后，写入 operation set 与任务变更集快照，并以 `manual_preview_generated` final 事件完成当前执行段、session 和队列任务。不会保存 `waiting_operation_confirmation` checkpoint，不会把应用结果再注入模型，也不会请求额外的收尾总结。

用户处理完当前批次后，API 只把 applied、discarded 或 partial 结果写入 operation set、任务变更集和 resolution 记录；不改写模型消息、checkpoint、执行段或队列状态。为兼容升级前的 `waiting_operation_confirmation` session，用户决定落库后直接收口为 `completed`，同样不唤醒 Worker。

`agent_resume_jobs` 保持 interaction 专用。文件确认不创建伪 interaction，也不修改现有提问卡恢复规则。

自动确认模式因高风险检查而临时要求确认时，仍沿用既有 checkpoint 恢复链路；该分支由任务队列保存的 `approval_mode` 区分，不属于手动模式生成 Diff 即结束任务的规则。

## 7. 任务变更集聚合算法

### 7.1 创建时点

session 第一次成功创建写入型 operation set 时，使用 `session_id` 唯一约束创建任务变更集。后续批次复用同一记录，并按 `MAX(batch_sequence_no) + 1` 分配顺序号。

### 7.2 不同工具的快照生成

| 工具或操作 | 初始快照 | 待确认快照 |
|---|---|---|
| `create_note` | `base_exists = 0` | 新路径、完整 Markdown、Hash。 |
| `preview_file_revision` | 现有 revision base | revision draft。 |
| `preview_patch_files` | 创建批次时读取完整文件 | 在内存中把 old/new 应用到完整文件后的结果。 |
| `move_file` | 旧路径、正文、Hash | 新路径，正文与 Hash 不变。 |
| `create_folder` | `base_exists = 0` | 新目录路径。 |
| `rename_folder / move_folder` | 旧目录路径和 Markdown 清单 | 新目录路径和按前缀映射后的清单。 |

同一批次内按工具输入顺序模拟候选状态，使“创建目录后移动文件到该目录”等依赖顺序得到一致预览。

### 7.3 资源匹配

聚合服务按以下顺序寻找已有资源项：

1. `pending_path` 精确匹配。
2. `applied_path` 精确匹配。
3. `base_path` 精确匹配。
4. 对目录 item 做最长路径前缀映射，把当前路径还原到任务开始前路径。
5. 没有匹配时创建新 `resource_key`。

创建后重命名会更新同一文件 item 的路径；同一文件连续三次修改只更新 applied 或 pending 快照，base 快照不变。

### 7.4 状态推进

- 预览生成：写入 pending 快照，change set 版本加 1。
- 自动应用成功：pending 提升为 applied，清空 pending，版本加 1。
- 手动应用成功：对应资源提升为 applied；批次全部处理完后生成 resolution。
- 废弃：清空对应 pending；base 和 applied 保持不变。
- 冲突：保留 pending，资源与批次标记 conflict。
- 回滚：按底层 operation set 逆序执行；成功后资源恢复 base，change set 标记 rolled_back。

### 7.5 累计 Diff 输出

主 Diff 以 base 快照与“pending 优先，否则 applied”的目标快照生成：

- base 不存在：新增。
- 路径变化：移动或重命名。
- 正文 Hash 变化：生成行级 diff hunks。
- 路径与正文都变化：同一资源同时显示路径变化和正文差异。
- base 与目标完全一致：不进入主资源列表，批次历史仍可查看。

Diff 主列表按逻辑资源展示，不按 operation set 展示。详情中的“批次记录”按 batch sequence 列出该资源经历的预览、应用、废弃、冲突和回滚状态。

## 8. 文件系统与数据库不一致的恢复

文件系统写入无法与 SQLite 共同提交。operation set 在开始应用前标记 processing，任务变更项保留 base、pending 和预期 Hash。进程恢复时按下面规则处理：

| 操作 | 未应用 | 已应用 | 冲突 |
|---|---|---|---|
| 正文修改 | 当前 Hash 等于 base/applied Hash | 当前 Hash 等于 pending Hash | 当前 Hash 两者都不等。 |
| 新建文件 | 目标不存在 | 目标存在且 Hash 等于 pending Hash | 目标存在但 Hash 不同。 |
| 移动文件 | 旧路径存在、新路径不存在 | 旧路径不存在、新路径存在且 Hash 匹配 | 两边同时存在、同时不存在或 Hash 不同。 |
| 新建目录 | 目标不存在 | 目标存在 | 目标被文件占用。 |
| 移动目录 | 旧路径存在、新路径不存在 | 旧路径不存在、新路径存在且清单可映射 | 两边同时存在、同时不存在或清单不符。 |

核对为已应用时补写 operation set、change item 和 checkpoint；核对为未应用时允许幂等重试；冲突时停止当前批次，已有成功批次继续保留在累计 Diff。

对象存储图片仍沿用现有规则。Markdown 未写入时不把图片声明为已应用；已经上传但未被 Markdown 引用的对象继续按当前策略保留，回滚不物理删除对象。

## 9. session 与队列状态机

手动 Diff 不再引入新的等待状态，也不会阻塞同会话 FIFO；它生成后立即终止当前任务。

```text
running
  ├─ LLM 临时失败 ───────────────→ waiting_retry ───────→ queued_resume → running
  ├─ 模型配置问题 ───────────────→ waiting_model_recovery → queued_resume → running
  ├─ 手动文件批次 ───────────────→ completed（保留待处理 Diff）
  │                                      └─ 应用/废弃 → 仅更新 Diff 与文件状态
  ├─ 不可恢复错误 ───────────────→ failed
  └─ 全部完成 ───────────────────→ completed
```

需要同步修改的状态集合：

- `agentTaskQueue.BLOCKING`
- `USER_ACTION_WAITING`
- `SUPERSEDEABLE_SESSION_STATUSES`
- `getQueuePosition()` 查询
- `wakeTask()` 允许来源
- Worker 的 allowed statuses
- 会话列表状态优先级
- 前端恢复、停止和输入按钮判断
- `markStaleWaitingSessions()`

手动 Diff 生成后的“全部应用”“废弃本批修改”和逐文件操作只作用于对应 Diff。新的 completed session 不会因这些操作重新入队；遗留的 `waiting_operation_confirmation` session 仅接受文件决定接口，决定完成后直接转为 `completed`。

## 10. API 设计

### 10.1 会话详情

`GET /api/agent/sessions/:id` 保留现有字段，增加：

| 字段 | 内容 |
|---|---|
| `execution_segments` | 执行段、请求窗口摘要和真实工具名称。 |
| `change_set` | ID、version、状态、文件数、目录数、待确认数、冲突数、当前批次 ID。 |

现有 `operation_sets` 继续返回，供旧会话和旧前端逻辑兼容。

`GET /api/conversations/:id` 的每个 `agent_session` 同样返回 change set 摘要。顶层 `pending_operation_sets` 保留兼容，但新界面不再通过它决定主 Diff 卡。

### 10.2 Diff 详情

新增 `GET /api/agent/sessions/:id/changes`，当前一次返回任务变更集、资源快照、批次摘要和可直接交给 DiffDialog 的累计视图。接口强制校验 `session_read` capability 或 session token；session 与 conversation 列表只返回摘要，不携带正文。逐资源 `item_id` 查询和分页尚未实现。

### 10.3 手动处理与回滚

扩展 `POST /api/agent/loop/apply`，新增 change set 语义：

| action | 行为 |
|---|---|
| `apply_all / apply` | 应用当前批次全部 pending 项；批次全部解决后更新 resolution 与任务变更集，不恢复原 session。 |
| `discard_pending` | 废弃当前批次剩余 pending 项；批次全部解决后更新 resolution 与任务变更集，不恢复原 session。 |
| `apply_file / discard_file / rollback_file` | 保留现有逐文件处理；仍有 pending、applying 或 failed 时不改变任务终态。 |
| 累计卡“全部应用 / 废弃本批修改” | 调用上述现有批次动作，不在浏览器中直接改文件。 |

所有操作同时校验 session 与 operation set 所属 conversation，使用 `operate` capability 或 session token。批次解决、任务变更集摘要与 resolution 在同一 SQLite 事务中更新；事务提交后只刷新前端 Diff 和文件树，不唤醒 Worker。旧版等待确认 session 额外收口 session 与队列终态。任务级逆序回滚仍按既有安全检查执行。

### 10.4 SSE

新增或扩展两类事件：

- `progress.llm_retry`：带执行段和请求窗口字段。
- `artifact.task_change_set`：带 `change_set_id / version / status / current_operation_set_id / counts`。

SSE 不传全文、完整 diff 或目录清单。前端看到更高 version 后拉取摘要；用户打开详情时再读取选中资源。

## 11. 前端实现

### 11.1 状态归属

`FileAgentWorkspace` 增加 `changeSetBySessionId`，来源为会话详情、历史恢复和 SSE 摘要。消息关联优先使用 `meta.session_id`，不再用“同 session 最后一条 operation set”代替累计结果。

任务变更集附着于 session 时间线：

- 尚未形成助手 final 时，显示在原用户消息下方的任务记录中。
- 已有 final 时，随同一 session 的任务记录移动到助手消息区域。
- 错误卡、取消状态和累计 Diff 可以同时存在。
- 一个 session 始终只有一张累计 Diff 卡，key 使用 change set ID。

### 11.2 重试工具记录

`useAgentLoopController` 的 step 数据增加 `executionSegmentId`、`requestWindows` 和 `retryHistory`。同一执行段的新 retry 事件更新当前次数，并保留已经结束的窗口；不同执行段互不覆盖。

历史恢复优先读取 `execution_segments`，旧 session 继续从 run events 和 `loop_index` 生成兼容记录。

### 11.3 累计 Diff 卡

新增 `TaskChangeSetCard`，累计详情继续复用现有 DiffDialog 的行级 diff、图片预览、文件跳转和窄屏抽屉组件，不再建立第二套弹窗组件。

卡片摘要显示：

- 文件和目录总数。
- 已应用、待确认、冲突数量。
- 当前状态。
- “查看详情”入口。

详情左侧按逻辑资源列出最终路径；正文区按需请求当前 item。手动等待时显示批次操作区；历史已应用资源保持只读或提供受 Hash 保护的回滚。

旧 `OperationSetCard` 和旧 DiffDialog 保留，用于没有 change set 的历史消息。新 session 不再生成多张消息级 operation set 卡。

## 12. 文件级改造清单

### 12.1 新增文件

| 文件 | 职责 |
|---|---|
| `notus/lib/migrations/010_agent_execution_changes.js` | 增量数据库结构。 |
| `notus/lib/migrations/011_agent_queue_resume_request.js` | 交互与历史等待会话的队列恢复兼容字段；新手动 Diff 不使用。 |
| `notus/lib/agentExecutionSegments.js` | 执行段、请求窗口及重试状态。 |
| `notus/lib/agentTaskChangeSets.js` | 任务变更集、资源快照、聚合、核对和摘要；不执行文件写入。 |
| `notus/pages/api/agent/sessions/[id]/changes.js` | 按需读取累计 Diff。 |
| `notus/tests/agent-subtask-retry.test.js` | 分段重试与窗口恢复。 |
| `notus/tests/agent-task-change-composition.test.js` | 混合应用/废弃、累计快照和文件移动类型。 |
| `notus/tests/agent-tool-dispatch-resume.test.js` | 工具 content、结果和游标的中断恢复。 |
| `notus/tests/agent-loop-preview-completion.test.js` | 手动 Diff 生成即完成、应用后不续跑和队列终态。 |

### 12.2 修改文件

| 文件 | 计划修改 |
|---|---|
| `notus/lib/db.js` | 注册迁移 010。 |
| `notus/lib/agentLoop.js` | 创建执行段、持久化请求窗口、三阶段 checkpoint、写入工具幂等和手动 Diff 终态收口。 |
| `notus/lib/agentSession.js` | 扩展 checkpoint、SSE 白名单、session 读取和等待状态。 |
| `notus/lib/agentRunEventBus.js` | 支持元数据事务提交后广播已持久化事件，避免重复写事件。 |
| `notus/lib/agentTaskWorker.js` | 恢复 staged checkpoint、变更集关联、终态消息不再只带最近 operation set。 |
| `notus/lib/agentTaskQueue.js` | 新等待状态、排队恢复和 FIFO 规则。 |
| `notus/lib/agentControlPlane.js` | 为终态 Diff 操作签发 operate/rollback ticket，保留原 owner 和过期规则。 |
| `notus/lib/canvasOperationSets.js` | 批次关联字段、tool use 幂等查询和批次顺序。 |
| `notus/lib/agentTools.js` | 接收 change set、执行段和 tool use 上下文，创建或应用 operation set，并返回聚合服务需要的受控结果。 |
| `notus/lib/fileRevisions.js` | revision 应用后的 Hash 核对和 change item 同步。 |
| `notus/lib/fileSystemPatches.js` | 目录清单、路径核对和恢复判定。 |
| `notus/pages/api/agent/loop/start.js` | 新恢复状态和 event cursor 行为。 |
| `notus/pages/api/agent/loop/apply.js` | 批次解决、任务变更集更新、旧等待会话收口和累计回滚。 |
| `notus/pages/api/agent/sessions/[id].js` | 返回执行段与 change set 摘要。 |
| `notus/pages/api/agent/sessions/[id]/events.js` | 协议字段透传不变，依赖新的事件白名单。 |
| `notus/pages/api/agent/sessions/[id]/rollback.js` | 委托任务变更集逆序回滚并回写版本。 |
| `notus/pages/api/conversations/[id].js` | 历史恢复附带 session change set 摘要。 |
| `notus/hooks/useAgentLoopController.js` | 按执行段更新重试记录，缓存 change set 摘要，调用新批次动作。 |
| `notus/components/AgentWorkspace/FileAgentWorkspace.js` | 维护 session→change set 映射，替换最后 operation set 回退。 |
| `notus/components/AgentWorkspace/AgentWorkspace.js` | 增加累计卡和按需 Diff，对旧卡保持兼容。 |

实现预计修改 20 个现有文件、新增 7 个文件，并增加两个领域服务。代码评审时应按“执行段与 checkpoint”“变更集与文件工具”“API 与界面”三组检查，避免把所有状态变化放进单个大改动中。

## 13. 实施顺序

1. 完成迁移 010、执行段服务和变更集服务的纯数据测试。
2. 改造 checkpoint，使模型成功后的工具 content 和工具游标能够恢复；暂时保持旧 UI。
3. 接入执行段和请求窗口，让现有 LLM 重试测试按 segment/window 断言。
4. 为写入工具增加 `tool_use_id` 幂等、完整候选快照和文件状态核对。
5. 接入自动模式多批 change set，验证成功、冲突、进程中断和逆序回滚。
6. 手动 Diff 生成后直接完成任务；完成整批和逐文件处理时只更新 Diff 与文件状态，并兼容收口旧等待会话。
7. 扩展 session、conversation、changes API 和 SSE 摘要。
8. 接入前端执行段重试记录和单张累计 Diff 卡，保留旧会话兼容。
9. 更新产品、技术、业务流程、界面和项目进度文档，执行完整自动化与实机回归。

## 14. 测试与故障注入

### 14.1 重试

- 同一执行段第 1～5 次重试更新同一工具记录。
- 下一执行段重新从 `1/5` 开始并生成新记录。
- 重试耗尽后继续，原执行段增加请求窗口，旧窗口历史保留。
- 切换模型后继续，新窗口记录新配置 ID，旧配置不被覆盖。
- 额度、Key、权限和模型不可用不执行自动重试。

### 14.2 文件批次

- 自动模式连续创建、修改、移动，Loop 不提前完成。
- 手动模式首个 Diff 生成后立即完成；整批应用、整批废弃、逐文件混合处理均不再请求模型或恢复队列。
- 同一文件多次修改只显示一条净 Diff。
- 创建后移动、移动后修改、目录连续移动得到稳定初始路径和最终路径。
- 图片写入失败不提升 applied 快照。
- 外部编辑造成 Hash 冲突时保留已成功批次。

### 14.3 中断时点

- `before_llm` checkpoint 提交后进程退出。
- LLM 成功、`dispatching_tools` checkpoint 提交后退出。
- 文件已经写入、operation set 尚未完成状态更新时退出。
- operation set 与 change set 已完成、`next_tool_index` 尚未推进时退出。
- 手动决定已经落库、旧等待会话尚未收口为 completed 时退出。
- change set SSE 已落库、浏览器尚未收到时断开。

每个时点都验证工具不重复执行、文件状态与 change set 一致、SSE 游标不重复追加卡片。

### 14.4 兼容与界面

- 迁移前数据库打开后仍可读取旧 operation set、checkpoint 和历史消息。
- 旧 session 使用单 operation set 卡；新 session 使用 task change set 卡。
- 刷新、切换对话、应用重启后恢复相同执行段、重试窗口和累计 Diff。
- 960px 以下 Diff 文件抽屉、长行内部滚动、暗色主题和 reduced motion 不回归。
- Web、Electron 和懒猫分别验证目录移动、文件监听和索引刷新。

### 14.5 命令

- 新增的三个专项测试。
- `node notus/tests/agent-llm-retry-resume.test.js`
- `node notus/tests/agent-loop-auto-write-continuation.test.js`
- `node notus/tests/agent-loop-preview-completion.test.js`
- `node notus/tests/agent-control-plane.test.js`
- `node notus/tests/agent-task-queue.test.js`
- `node notus/tests/agent-workspace-controls.test.js`
- `npm run test:all`
- `npm run lint:web`
- `npm run build:web`
- `npm run build:desktop`
- `git diff --check`

真实 Provider 的 timeout、429、5xx、额度不足和切换模型续跑必须列为实机回归，不能用静态断言替代。

## 15. 回退方案

- 数据库迁移只新增结构，停用新路径时不删除表和历史记录。
- 新 session 写入的 operation set 仍保持原格式字段，旧 `listOperationSetsBySession()` 可以读取。
- 前端在没有 change set 摘要或详情请求失败时，回退到旧 `OperationSetCard`。
- 执行段功能停用时，LLM 重试仍可按原 `loop_index` 显示，不影响模型调用。
- 手动 Diff 终态逻辑回退时，新 session 仍保持 completed；历史 `waiting_operation_confirmation` session 只能在用户处理当前批次后收口为 completed，不能转为 `queued_resume` 以避免额外模型调用。
- 回退不需要改写用户 Markdown，也不需要删除任务数据。

## 16. 外部依赖与凭据

- 不新增 npm 包、MCP Server、外部 CLI、API Key、Token 或第三方账号。
- 真实模型故障回归继续使用用户已有的 LLM 配置；实施过程中不修改用户密钥内容。
- Web、Electron 和懒猫共用相同服务端实现，平台差异继续通过现有平台中间层处理。

## 17. 需要确认的产品定义

本方案把 sub task 定义为“读取上一批工具结果后，由主 LLM 决定下一步”的服务端执行段。它具有稳定 ID、独立重试窗口和真实工具标题。

若 sub task 需要成为用户可见、可编辑、带依赖关系的高层任务计划，数据模型还要增加 planner 任务、父子关系、完成条件和计划变更历史。当前方案不包含这组能力。
