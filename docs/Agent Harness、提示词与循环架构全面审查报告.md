# Notus Agent Harness、提示词与循环架构全面审查报告

> 审查日期：2026-07-31
>
> 审查范围：Agent Harness、Prompt Engineering、Loop Engineering、Bug 台账、Requirements 实现状态、测试与文档闭环
>
> 审查性质：只读代码审查与验证，不包含产品代码修复
>
> 对应需求：REQ-20260731-003

## 1. 审查结论

当前 Agent 架构已经具备可运行的完整主链路：统一文件工作区接收输入，服务端创建 session，LLM 选择工具，工具读取或生成预览，写入通过 operation set 应用，运行过程经 SSE 回传，会话、interaction、checkpoint 和资源引用可持久化。文件写入的预览、Hash 冲突检测、禁止删除、Skill/MCP 脱敏、图片受控引用等设计有明确边界。

项目暂时不能得出“Bug 已全部解决、需求已全部实现”的结论。审查开始时，Bug 台账共有 143 条记录，其中 122 条状态为“已修复”，其余包含部分修复、修复中、待定位、待验证、已缓解和多类待实机回归。122 条“已修复”记录中，仍有至少 34 条验证栏明确写着待执行、仍需或仍建议真实环境回归。本轮又确认 3 项缺陷并补入台账，当前记录总数增加到 146 条。

Requirements 审查开始时共有 148 条台账记录。138 条状态精确写为“已完成”，2 条为“已完成，待实机回归”，1 条仍为“实施中”，其余是被后续需求替代或修正的历史状态。新增本次审查需求后共有 149 条。已完成数量较高，但需求、代码、测试和当前产品文档之间仍有冲突，不能把台账状态直接换算成可验收完成率。

综合评级如下。

| 维度 | 评级 | 判断 |
|---|---:|---|
| 主链路完整性 | B | 输入、session、工具、预览、应用、SSE 和历史数据已接通 |
| 写入安全 | B+ | 删除禁用、预览、Hash 与回滚较完整；全库写入是当前明确产品规则 |
| Loop 稳定性 | C | 上下文、取消、重试、并发恢复和连续性检测仍有确定缺口 |
| Prompt 可维护性 | C | 规则覆盖广，但缺少版本、分层模板、冲突检测和系统化 eval |
| 自动化验证 | C | 66 个 Node 测试覆盖面较广，但当前 3 项失败，大量测试依赖源码字符串 |
| 文档与需求一致性 | C | 版本、响应式阈值、复制策略、历史页面和 Bug 状态存在漂移 |

## 2. 审查方法与证据

本轮读取并交叉检查了以下信息：

- 仓库契约：`AGENTS.md`、`Requirements/需求文档规范.md`、`docs/文档地图.md`。
- 需求与产品文档：需求总台账、Agent/上下文/文件工作区相关需求、项目进度、PDD、PRD、UI Guide 和业务流程。
- Agent 主链路：`agentLoop.js`、`agentLoopPrompt.js`、`agentSession.js`、`agentTools.js`、`useAgentLoopController.js`、Loop API、interaction API、LLM 适配、上下文预算与压缩模块。
- 扩展链路：Skill、MCP、全局 Agent 文件、资源上下文、检索回执、图片识别和文件修订。
- 验证：逐个执行 66 个 `notus/tests/*.test.js`，执行 Web lint 和 production build，并用隔离数据库构造 Loop 守卫与上下文压缩反例。

本轮没有使用真实 LLM API Key、真实对象存储 Bucket、Electron 安装包或懒猫设备。涉及模型行为、SSE 代理、平台认证和真实存储的路径仍属于待实机范围。

## 3. 当前架构

### 3.1 Harness 主链路

```text
文件工作区输入
  ├─ 文本 / Mention / 图片 / 解析附件 / MCP 选择
  └─ FileAgentWorkspace + useAgentLoopController
          ↓ POST /api/agent/loop/start（SSE）
Agent Session
  ├─ goal / conversation / token / loop count
  ├─ checkpoint / resource context / research receipts
  └─ operation set / interaction / run logs
          ↓
Prompt Assembly
  ├─ 固定系统规则
  ├─ 最近对话、附件、图片识别、检索回执
  ├─ soul / memory / style
  └─ Skill 目录、MCP 工具说明、资源指代
          ↓
LLM Tool Loop
  ├─ 读取与检索工具
  ├─ 文件预览与资源管理工具
  ├─ 提问卡片 / 资源确认
  └─ Loop 守卫、SSE 事件、日志
          ↓
受控写入
  ├─ operation set / file revision
  ├─ Hash 与 old 文本校验
  ├─ 自动确认或手动确认
  └─ 应用、废弃、逐文件回滚、索引刷新
```

### 3.2 已有设计优点

1. 文件系统写入集中到预览和应用层，LLM 不直接操作磁盘。
2. 删除文件和目录没有注册为 Agent 能力，写入工具也继续拒绝删除类操作。
3. 单文件全文修订和多文件局部 patch 分开，完整草稿由代码生成 diff，减少模型拼 patch 的脆弱性。
4. 图片使用会话受控引用，应用时才进入本地或对象存储，跨会话路径和 Base64 写入受到限制。
5. Skill 与 MCP 有独立领域服务、资源确认和密钥脱敏，不允许用笔记工作区伪造 Skill。
6. 资源跨轮承接使用稳定 ID 重新读取权威状态，没有把资源副本长期塞入普通聊天文本。
7. SSE 采用前端运行序号隔离旧流，降低旧事件覆盖恢复任务状态的概率。
8. 当前工作区 Agent 组件不再因布局切换卸载，降低 interaction 草稿和内存 token 丢失概率。

## 4. 主要问题

### F-01：刷新或隔天无法恢复待回答 Agent 任务

- 级别：P0。
- 现状：`resumeInteraction()` 只读取前端内存中的 session token。历史会话接口按安全规则不返回 token，刷新后无法继续同一 checkpoint。
- 影响：提问卡答案可以落库，原任务却不能继续；资源确认也依赖同一恢复链路。
- 台账：BUG-20260731-001 已明确记录，当前仍为部分修复。

### F-02：Agent Loop 没有可证明有效的上下文压缩

- 级别：P0。
- 代码：`notus/lib/agentLoop.js:compactMessages()` 只替换最后 8 条消息之前的成功 `tool_result`；普通长消息、最近工具结果、system prompt 和 tool schemas 没有进入同一压缩决策。
- LLM 适配：`completeToolChat()` 计算预算后直接发请求，没有复用 `completeChat()` 已有的软压缩、硬压缩和 overflow 重试。
- 实证：12 条普通长消息估算 331452 token，调用 `compactMessages(messages, 60000)` 后仍为 331452 token，消息数仍为 12。
- 影响：长对话、长文件和多工具任务可能直接返回 context overflow；“已具备自动 compact”的历史需求没有覆盖当前 Agent Loop。
- 台账：本轮新增 BUG-20260731-002。

### F-03：取消、超时和 checkpoint 提交顺序不安全

- 级别：P0。
- `runAgentLoop()` 接收 AbortSignal，但 `completeToolChat()` 的 `fetch` 和工具执行没有接收 signal。用户点击停止或 SSE 断开时，正在等待的模型或 MCP 调用不会立即中止。
- LLM 工具调用没有统一请求超时。BUG-20260702-008 已把 Anthropic 兼容网关长时间无首包列为高概率断点。
- checkpoint 在恢复后的下一次 LLM 调用成功前就被清空。请求失败、进程退出或网络断开后，已回答 interaction 仍在，恢复上下文却可能已经丢失。

### F-04：Loop 连续性守卫会误判

- 级别：P1。
- `detectDeadloop()` 按工具名累计相同结果 Hash，不检查调用是否相邻。
- `recordToolFail()` 按工具名累计失败，只在同一个工具成功时清零；其他工具成功不会打断“连续失败”。
- 实证：三次相同 `read_file` 之间穿插不同 `search_knowledge` 结果，第三次仍触发死循环；两次 `read_file` 失败中间穿插成功工具，第二次仍触发连续失败。
- 台账：本轮新增 BUG-20260731-003。

### F-05：恢复请求缺少 session 级互斥和幂等

- 级别：P1。
- `/api/agent/loop/start` 允许 `waiting_confirm` 和 `running` session 进入恢复，但没有 lease、run version 或原子状态迁移。
- 两个浏览器请求、重复点击或客户端重试可能同时读取同一 checkpoint、执行同一 Tool result，甚至重复生成或应用预览。
- interaction 回答和 Loop 恢复分成两个请求，当前没有 outbox/job 或事务把“答案已持久化”和“续跑已接管”绑定起来。

### F-06：每次任务同步快照整个工作区

- 级别：P1。
- 当前 session 默认授权路径为工作区根目录。`runAgentLoop()` 每次启动和恢复都会调用 `snapshotFiles()`，递归读取全部 Markdown，并把尚未快照的文件全文写入 `agent_snapshots`。
- 工作区越大，首轮延迟、数据库体积和 I/O 越高。恢复调用仍会遍历目录，即使多数任务不写文件。
- 当前主流程已经以 operation set 和 file revision 保存 base/new 内容，完整工作区快照主要服务旧的 session 级回滚兼容接口，可改为按实际写入路径延迟快照。

### F-07：Prompt 不可信内容边界依赖自然语言提醒

- 级别：P1。
- soul、memory、style、Skill、MCP 说明、检索结果、网页内容和历史消息最终拼入同一 system/user 文本。
- Prompt 虽多次写明“忽略改变安全规则的内容”，Harness 没有为不可信内容提供统一 envelope、来源标签、长度配额、结构化引用和注入检测。
- `load_skill` 与 MCP Tool result 会原样进入后续模型消息。模型仍可能服从材料中的伪指令，尤其在兼容网关和不同模型上表现不一致。

### F-08：Prompt 缺少版本、冲突检查和行为评测

- 级别：P1。
- `agentLoopPrompt.js` 是单个长字符串构造器，策略、任务规则、产品规则、动态材料和输出要求混在一起。
- 没有 prompt version 写入 session/run log，无法把线上错误回溯到某版提示词。
- 现有测试主要用 `source.includes()` 检查句子存在，不能验证模型是否遵守规则，也不能发现互相冲突的规则。
- “用户本轮输入优先”“每轮先说明计划”“不要自行声称已读取”“写入预览后立即结束”等规则需要场景化 eval，单纯存在于文本中无法证明效果。

### F-09：进展文本、最终回复和 token 使用没有分层

- 级别：P1。
- 每轮 text block 都以 `thinking` SSE 发出，前端把多轮文本拼成最终 assistant 消息。进展、解释和最终答案可能重复或互相覆盖。
- 文件写入工具调用后 Loop 直接结束，最终回复由 Harness 生成固定短句；其他任务依赖模型最后一轮自然结束，没有单独的 final response contract。
- `loop_done.usage` 只携带最后一次 LLM 响应的 usage，没有累计整次任务的 prompt、completion、检索规划和图片识别成本。

### F-10：配置字段和实现存在失活路径

- 级别：P2。
- `checkAndIncrementToolCount()`、`TOOL_HARD_LIMITS` 和 `tool_call_counts` 当前没有被 Agent Loop 调用。
- Prompt 仍显示“知识库检索上限 N 次”，实际研究层按来源总查询预算执行 3→5 计划，概念并不相同。
- `authorized_paths`、`isPathSafe()` 和路径单测仍保留，当前最新需求已明确取消全库非删除写入的路径拦截。遗留字段容易让维护者误判已经存在目录级授权。

### F-11：自动化测试基线已经漂移

- 级别：P1。
- 66 个 Node 测试中 63 个通过、3 个失败。
- 复制测试仍要求旧的富剪贴板实现，当前 PDD/PRD/UI Guide 和代码都要求只复制 Markdown 源文本。
- TOC 测试依赖旧函数名和源码片段，当前实现已迁移到 `useEditorToc`。
- 工作区状态测试仍期待 `knowledge`，当前产品只保留 `/knowledge → /files` 跳转。
- 大量源码字符串断言只能证明某段文本存在，不能证明运行行为、错误边界或跨模块状态传播。
- 台账：本轮新增 BUG-20260731-004。

### F-12：Requirements 与当前实现有多处冲突

- 级别：P1。
- `REQ-20260722-004` 和需求总台账规定 760px 收起编辑器；当前代码、PDD、PRD、UI Guide 和文件工作区流程使用 640px。高优先级 Requirements 尚未被新需求替代。
- 根目录、Web 和 `package.yml` 已是 0.1.12；项目进度、PDD 和 PRD 仍写 0.1.11。
- `REQ-20260703-001` 仍记录富剪贴板与图片内嵌；后续文件工作区需求和当前产品文档改为只复制 Markdown，但旧台账备注没有标记被替代。
- `REQ-20260710-001` 仍为“实施中”，其多数功能已经成为当前产品主链路，缺少剩余项和结束条件。
- 旧知识库/创作需求仍保留已完成状态；产品已将页面归档为兼容跳转。历史实现完成与当前入口可用需要在台账中分开表达。

### F-13：API 运行时和可观测性边界不统一

- 级别：P2。
- 60 个 API Route 中，`health.js`、`logs.js`、`models.js` 没有调用 `ensureRuntime()`，与仓库统一约束不一致。health 可以作为特殊探针，但需要在规则中写明例外；logs/models 没有例外说明。
- session 详情把 token 同时放在 query 和 header，query 可能进入访问日志。
- `/api/logs`、`/api/health` 会返回日志或绝对目录信息。懒猫认证、Electron loopback 和普通 Web 部署需要明确不同暴露边界。

### F-14：旧链路与现行链路并存，维护成本持续上升

- 级别：P2。
- 当前 UI 已统一到文件工作区，`prompt.js`、`canvasRequestPlanner.js`、`canvasAgent.js`、`/api/agent/run`、`/api/chat` 等旧链路仍承担兼容能力。
- 同一种概念在 Agent Loop、旧 canvas 和知识库问答中各有一套 Prompt、compact、重试和 interaction 行为。修复可能只落到其中一条链路。
- 兼容保留需要明确调用方、退出条件和冻结测试，避免被误当成现行架构继续扩展。

## 5. Bug 台账复核

### 5.1 状态分布

审查开始时的 143 条 Bug 状态如下。

| 状态 | 数量 |
|---|---:|
| 已修复 | 122 |
| 已修复，待实机回归 | 6 |
| 修复中 | 4 |
| 已缓解 | 2 |
| 已修复，待懒猫实机回归 | 2 |
| 部分修复，待实机回归 | 1 |
| 待验证 | 1 |
| 待定位 | 1 |
| 待修复方案确认 | 1 |
| 已修复，待真实视觉模型回归 | 1 |
| 已修复，待真实 OSS 验证 | 1 |
| 已修复，后续交互已调整 | 1 |

本轮新增 BUG-20260731-002、003、004，三条均未修复。

### 5.2 明确未闭环条目

- BUG-20260731-001：提问卡跨刷新/隔天恢复仍未修复。
- BUG-20260710-002：启动恢复时面板状态被默认值覆盖。新代码和 BUG-20260730-001 已覆盖部分链路，但旧条目仍标待方案确认，需要合并状态与实机结果。
- BUG-20260702-008：Anthropic 兼容网关 `fetch failed` 仍待定位，超时与底层 cause 日志尚未补齐。
- BUG-20260517-001～004：台账仍为修复中；当前相关迁移、frontmatter、排序和任务列表测试均通过，说明台账状态至少已经滞后，懒猫与浏览器实机仍需补验。
- BUG-20260502-003、BUG-20260420-006：状态为已缓解，外部下载与 embedding 维度配置风险仍存在。
- BUG-20260721-003：代码与测试已完成，Electron 实机验证未完成。
- 多个 2026-07-29、07-30 条目仍待真实 LLM、Web、Electron 或懒猫验证。

### 5.3 对“全部解决”的判断

Bug 台账没有达到全部解决。未修复条目、待真实环境条目、已缓解条目和状态滞后条目同时存在。lint、build 和静态源码断言只能覆盖语法、打包和部分结构，不足以替代 interaction 恢复、LLM 行为、对象存储、Electron 与懒猫用户路径。

## 6. Requirements 实现复核

### 6.1 台账状态

审查开始时共有 148 条记录：138 条精确标记为已完成，2 条已完成待实机回归，1 条实施中，7 条被后续需求替代、修正或附带新口径。另有 7 份需求文档正文明确保留待实机、待真实环境或待回归内容。

### 6.2 已实现程度较高的领域

- 单一文件工作区与旧页面兼容跳转。
- 文件 Mention、目录 Mention、Skill Mention 和历史结构化渲染。
- Agent Loop、文件修订预览、operation set、手动/自动确认、逐文件回滚。
- 图片输入、视觉识别持久化、对话图片写入笔记、对象存储复用。
- Skill/MCP 设置、任务级选择、资源管理工具、受控确认和密钥脱敏。
- 全局 Agent 文件、历史、回滚和 Prompt 注入。
- 检索 3→5 查询、缓存、来源回执和 URL 状态保护。

### 6.3 不能认定全部实现的领域

1. Agent 提问卡跨刷新恢复没有完成，直接影响最新写作目标需求和 interaction 续跑承诺。
2. 当前 Agent Loop 没有覆盖上下文自动 compact 的完整行为，旧需求完成状态不能自动延伸到新 Loop。
3. 文件工作区总需求仍标实施中，缺少明确剩余清单。
4. 响应式断点的代码与高优先级 Requirements 冲突。
5. 复制全文的历史需求、后续需求和测试口径没有完成替代标注。
6. 真实 Bucket、视觉模型、Electron、懒猫和多提供商 LLM 验收仍有空白。
7. 需求完成证据大量停留在 lint、build、`node --check` 或字符串断言，没有统一的用户行为验收结果。

## 7. 验证结果

| 验证 | 结果 |
|---|---|
| 逐个运行 `notus/tests/*.test.js` | 66 项中 63 通过、3 失败 |
| `npm run lint:web` | 通过，无 warning/error |
| `npm run build:web` | 通过，Next.js production build 成功 |
| 非连续死循环/失败守卫反例 | 已复现误判 |
| 331452 token 普通长消息压缩反例 | 压缩前后不变 |
| `AGENTS.md` 与 `CLAUDE.md` | 内容一致 |
| API Route `ensureRuntime()` 扫描 | 60 个中 3 个未调用 |

## 8. 审查边界

以下路径没有在本轮声称通过：

- 真实 LLM 的多轮工具调用、上下文溢出、长首包和断线续跑。
- Web、Electron、懒猫三端的提问卡、资源确认和恢复。
- COS、OSS、R2 真实 Bucket 上传与公开 URL。
- Electron 安装包、Windows/macOS 双架构与 LPK 安装回归。
- 大型真实工作区中的快照耗时、数据库增长和检索性能。

整改顺序、目标架构、文件级改造建议和验收矩阵见《Agent Harness、提示词与循环架构整改方案》。
