# Notus Agent 暂存修订与代码 Diff 预览实现方案

## 1. 背景

当前 Notus Agent 在修改内容较少时，预览生成通常能成功；当修改内容特别多、特别碎时，预览容易失败。根本原因是预览依赖 LLM 输出碎片化的 `old/new` 或 patch 结构，内容越长、改动越多，LLM 越容易漏段、错配、格式异常或生成不可应用的 patch。

本方案将预览、应用、回滚从 LLM 输出中剥离出来。LLM 只负责生成修改后的内容或调用编辑工具，代码负责保存修订、生成 diff、校验应用和记录回滚依据。

## 2. 目标

实现一个稳定的单文件 AI 修订机制：

```txt
正式笔记内容
  ↓
Agent 生成草稿
  ↓
保存暂存修订
  ↓
代码生成 diff 预览
  ↓
用户确认应用
  ↓
hash 校验后写入正式笔记
  ↓
支持安全回滚
```

需要满足：

```txt
1. Agent 不直接修改正式笔记文件
2. 预览 diff 由代码生成
3. 应用前校验 base_hash
4. 回滚前校验 applied_hash
5. apply 失败不能破坏正式文件
6. 同一文件同一会话只保留一个 pending 预览
7. 历史记录可追溯
8. 自动模式也走同一套流程
```

## 3. 不做的内容

第一版不做这些功能：

```txt
1. 多文件统一预览
2. 三方合并
3. 局部回滚
4. 实时多人协同编辑
5. git 仓库级版本管理
6. 基于 diff patch 的正式应用
```

第一版只做单文件暂存修订，保证稳定即可。

## 4. 核心设计

新增一种 Agent 修改类型：

```txt
file_revision
```

它代表一次完整的文件级暂存修订。

Agent 生成或修改草稿后，调用工具提交 `draft_content`。系统读取正式文件当前内容作为 `base_content`，计算 `base_hash`，保存一条暂存修订记录，再由代码比较 `base_content` 和 `draft_content` 生成 diff 预览。

diff 只用于展示，不用于应用。

真正应用时，系统重新读取正式文件当前内容，计算 `current_hash`。只有当：

```txt
current_hash === base_hash
```

才允许把 `draft_content` 原子写入正式文件。

## 5. 数据模型

### 5.1 operation_set 表

用于记录一次 Agent 修订。

```sql
CREATE TABLE agent_operation_set (
  id VARCHAR(64) PRIMARY KEY,
  conversation_id VARCHAR(64) NOT NULL,
  agent_run_id VARCHAR(64),
  note_id VARCHAR(64) NOT NULL,
  file_path TEXT NOT NULL,

  type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,

  parent_operation_set_id VARCHAR(64),
  sequence_no INTEGER NOT NULL DEFAULT 0,

  base_hash VARCHAR(128) NOT NULL,
  draft_hash VARCHAR(128) NOT NULL,
  applied_hash VARCHAR(128),

  base_content LONGTEXT NOT NULL,
  draft_content LONGTEXT NOT NULL,

  error_message TEXT,

  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  applied_at DATETIME,
  discarded_at DATETIME,
  rolled_back_at DATETIME
);
```

其中 `type` 第一版固定为：

```txt
file_revision
```

`status` 可选：

```txt
pending
applied
discarded
superseded
stale
apply_failed
rolled_back
rollback_conflict
```

### 5.2 字段说明

```txt
id：本次修订记录 ID
conversation_id：所属会话 ID
agent_run_id：所属 Agent 执行 ID
note_id：笔记 ID
file_path：笔记文件路径
type：修订类型，第一版为 file_revision
status：当前状态
parent_operation_set_id：上一次修订 ID
sequence_no：同一会话内的修订序号
base_hash：生成预览时正式文件的 hash
draft_hash：草稿内容 hash
applied_hash：成功应用后的正式文件 hash
base_content：生成预览时的正式内容
draft_content：Agent 修改后的草稿内容
error_message：失败原因
```

## 6. hash 规则

统一使用 SHA-256。

计算 hash 前需要做内容规范化：

```txt
1. 换行符统一为 LF
2. 去除 UTF-8 BOM
3. 不自动 trim 正文内容
```

不要去除首尾空格。Markdown 内容里的空格可能是有效内容。

示例：

```ts
function normalizeContent(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex');
}
```

## 7. Agent 工具设计

### 7.1 preview_file_revision

Agent 用它提交一次文件修订预览。

请求参数：

```ts
interface PreviewFileRevisionInput {
  conversationId: string;
  agentRunId?: string;
  noteId: string;
  filePath: string;
  draftContent: string;
  parentOperationSetId?: string;
}
```

返回参数：

```ts
interface PreviewFileRevisionResult {
  operationSetId: string;
  status: 'pending' | 'applied' | 'apply_failed';
  baseHash: string;
  draftHash: string;
  diffHunks: DiffHunk[];
  message?: string;
}
```

处理流程：

```txt
1. 读取正式文件当前内容 current_content
2. 规范化 current_content，得到 base_content
3. 规范化 draftContent，得到 draft_content
4. 计算 base_hash 和 draft_hash
5. 查找同一 conversation_id + note_id + file_path 下是否存在 pending 记录
6. 如果存在，将旧 pending 标记为 superseded
7. 保存新的 operation_set，状态为 pending
8. 代码生成 diff hunks
9. 返回 operation_set_id 和 diff hunks

自动确认模式不得由 LLM 通过工具参数决定；由 Agent Loop 根据真实 `approvalMode` 在预览创建后调用 `apply_file_revision`。
```

### 7.2 apply_file_revision

用于应用预览。

请求参数：

```ts
interface ApplyFileRevisionInput {
  operationSetId: string;
}
```

返回参数：

```ts
interface ApplyFileRevisionResult {
  operationSetId: string;
  status: 'applied' | 'stale' | 'apply_failed';
  appliedHash?: string;
  message?: string;
}
```

处理流程：

```txt
1. 查询 operation_set
2. 校验状态必须是 pending
3. 读取正式文件当前内容
4. 计算 current_hash
5. 如果 current_hash !== base_hash：
   - 状态改为 stale
   - 不修改正式文件
   - 返回 stale
6. 如果一致：
   - 使用临时文件写入 draft_content
   - rename 覆盖正式文件
   - 重新读取正式文件并计算 applied_hash
   - 更新状态为 applied
   - 保存 applied_hash 和 applied_at
```

### 7.3 discard_file_revision

用于废弃预览。

请求参数：

```ts
interface DiscardFileRevisionInput {
  operationSetId: string;
}
```

处理流程：

```txt
1. 查询 operation_set
2. 只有 pending 或 stale 可以废弃
3. 状态改为 discarded
4. 不修改正式文件
```

### 7.4 rollback_file_revision

用于回滚已应用的修订。

请求参数：

```ts
interface RollbackFileRevisionInput {
  operationSetId: string;
}
```

返回参数：

```ts
interface RollbackFileRevisionResult {
  operationSetId: string;
  status: 'rolled_back' | 'rollback_conflict';
  message?: string;
}
```

处理流程：

```txt
1. 查询 operation_set
2. 校验状态必须是 applied
3. 校验 applied_hash 存在
4. 读取正式文件当前内容
5. 计算 current_hash
6. 如果 current_hash !== applied_hash：
   - 状态改为 rollback_conflict
   - 不修改正式文件
   - 返回冲突
7. 如果一致：
   - 使用临时文件写回 base_content
   - 状态改为 rolled_back
   - 保存 rolled_back_at
```

### 7.5 get_file_revision_diff

用于重新打开预览时获取 diff。

请求参数：

```ts
interface GetFileRevisionDiffInput {
  operationSetId: string;
}
```

处理流程：

```txt
1. 查询 operation_set
2. 使用 base_content 和 draft_content 重新生成 diff hunks
3. 返回给前端展示
```

第一版可以不持久化 diff hunks，避免数据冗余。

## 8. diff 生成

推荐在 Node 侧使用 `diff` 或 `diff-match-patch`。

建议第一版输出结构：

```ts
interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'context' | 'insert' | 'delete';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}
```

展示规则：

```txt
1. 按行展示新增、删除、上下文
2. 相邻修改合并为一个 hunk
3. 每个 hunk 前后保留 3 行上下文
4. 超长 diff 默认折叠
5. Markdown 标题可以作为辅助展示信息
```

前端只展示 diff，不负责判断是否能应用。

## 9. 前端改造

### 9.1 新增 file_revision 卡片

现有 Agent 操作卡片继续使用 `operation_set_id`。

当类型为 `file_revision` 时，展示：

```txt
1. 文件名
2. 状态
3. diff 预览
4. 应用按钮
5. 废弃按钮
6. 回滚按钮
7. 错误提示
```

不同状态展示规则：

```txt
pending：显示应用、废弃
applied：显示已应用、回滚
discarded：显示已废弃
superseded：显示已被新预览替代
stale：显示文件已变化，需要重新生成
apply_failed：显示应用失败原因
rolled_back：显示已回滚
rollback_conflict：显示无法安全回滚
```

### 9.2 自动模式展示

自动模式仍然生成 operation_set。

如果应用成功：

```txt
展示「已自动应用」
允许用户点击查看 diff
允许用户回滚
```

如果应用失败：

```txt
展示「自动应用失败」
保留 diff
提示文件已变化或写入失败
```

### 9.3 同一文件 pending 处理

当同一会话里同一文件已有 pending 记录，新预览生成时默认把旧的改为：

```txt
superseded
```

前端可以展示：

```txt
该预览已被新的修订替代
```

不要物理删除旧记录。

## 10. 后端服务设计

建议拆成这些服务：

```txt
FileContentService
RevisionService
DiffService
AtomicWriteService
AgentToolService
```

### 10.1 FileContentService

职责：

```txt
1. 根据 note_id 或 file_path 读取正式内容
2. 处理编辑器当前内容和磁盘内容的一致性
3. 处理文件不存在、文件移动、文件权限错误
```

### 10.2 RevisionService

职责：

```txt
1. 创建 operation_set
2. 查询 operation_set
3. 修改状态
4. 保存 base/draft/applied hash
5. 处理 supersede 规则
```

### 10.3 DiffService

职责：

```txt
1. 根据 base_content 和 draft_content 生成 diff hunks
2. 控制上下文行数
3. 控制超长 diff 展示
```

### 10.4 AtomicWriteService

职责：

```txt
1. 写入临时文件
2. fsync
3. rename 覆盖正式文件
4. 写入失败时不破坏原文件
```

### 10.5 AgentToolService

职责：

```txt
1. 暴露 preview_file_revision
2. 暴露 apply_file_revision
3. 暴露 discard_file_revision
4. 暴露 rollback_file_revision
5. 暴露 get_file_revision_diff
```

## 11. Agent 行为规则

需要在 Agent system prompt 或工具说明里加入规则：

```txt
1. 修改笔记时不得直接写正式文件
2. 修改完成后必须调用 preview_file_revision
3. 预览内容不得由 LLM 自己生成
4. 不要生成 old/new patch 数组
5. 自动模式下也必须先生成 revision，再由 Agent Loop 根据真实审批模式调用 apply
6. 当 apply 返回 stale 或失败时，停止继续写入，并向用户说明文件未被修改
7. 当存在 pending 预览时，继续修改默认基于最新 pending 的 draft_content
```

注意：第一版如果还没做“基于 pending 继续修改”，可以先让新预览直接 supersede 旧 pending。

## 12. 手动模式流程

```txt
用户：帮我改这篇笔记
Agent：读取笔记内容
Agent：生成 draft_content
Agent：调用 preview_file_revision
系统：保存 base_content + draft_content
系统：代码生成 diff hunks
前端：展示 diff 卡片
用户：点击应用
系统：校验 current_hash === base_hash
系统：写入 draft_content
系统：记录 applied_hash
前端：展示已应用
```

## 13. 自动模式流程

```txt
用户：直接帮我改掉
Agent：读取笔记内容
Agent：生成 draft_content
Agent：调用 preview_file_revision
系统：保存 revision
系统：生成 diff
Agent Loop：根据真实自动确认模式立即 apply
系统：成功则写入，失败则保留记录
前端：展示自动应用结果
```

自动模式不能绕过 revision。否则回滚和追溯会断掉。

## 14. 回滚流程

```txt
用户：点击回滚
系统：读取 operation_set
系统：读取当前正式文件
系统：计算 current_hash
系统：比较 current_hash 和 applied_hash
一致：写回 base_content
不一致：标记 rollback_conflict，不修改文件
```

不要在 hash 不一致时自动覆盖。

## 15. 文件写入要求

正式写入必须满足：

```txt
1. 不直接覆盖原文件
2. 先写临时文件
3. 临时文件写完后 rename
4. 写入失败时原文件保持不变
5. 写入后重新读取并计算 hash
```

伪流程：

```txt
target.md
target.md.tmp-{operationSetId}
```

写入过程：

```txt
1. write tmp
2. fsync tmp
3. rename tmp -> target
4. read target
5. calculate applied_hash
```

Electron 桌面端和 Web 部署都应该走同一套写入服务。

## 16. 编辑器未保存内容处理

这是必须处理的问题。

Agent 修改前，正式内容来源必须和用户当前看到的内容一致。

推荐规则：

```txt
1. 如果编辑器有未保存内容，先自动保存
2. 保存成功后再生成 base_content
3. 保存失败则禁止 Agent 修改
```

否则会出现：

```txt
用户看到的是 A'
磁盘里是 A
Agent 基于 A 生成预览
用户点击应用后覆盖 A'
```

## 17. 文件异常处理

### 17.1 文件不存在

```txt
preview：失败，不创建 revision
apply：标记 apply_failed
rollback：标记 rollback_conflict
```

### 17.2 文件被移动

第一版直接失败。

后续可以通过 note_id 重新解析路径，但不要在第一版做复杂处理。

### 17.3 文件权限不足

```txt
apply_failed
```

错误信息要保留到 `error_message`。

### 17.4 draft_content 为空

允许为空，但需要前端提醒：

```txt
该修订会清空文件内容
```

### 17.5 base_content 和 draft_content 完全相同

可以创建 revision，但状态建议直接标记：

```txt
discarded
```

或返回：

```txt
no_change
```

第一版建议返回 `no_change`，不生成卡片。

## 18. 状态流转

```txt
pending -> applied
pending -> discarded
pending -> superseded
pending -> stale
pending -> apply_failed

applied -> rolled_back
applied -> rollback_conflict

stale -> discarded
apply_failed -> discarded
rollback_conflict -> applied
```

说明：

```txt
1. stale 代表正式文件已经变化，不能应用
2. apply_failed 代表写入过程失败
3. rollback_conflict 代表应用后文件又被修改，不能安全回滚
4. superseded 代表被同一文件的新预览替代
```

## 19. 与现有 operation_set 的关系

现有操作可能是：

```txt
str_replace
insert
delete
```

新增：

```txt
file_revision
```

第一版可以保留旧类型，但 Agent 修改正文时优先使用 `file_revision`。

前端渲染时：

```txt
str_replace：老逻辑
file_revision：新 diff 卡片
```

后续稳定后，可以逐步减少旧 patch 类型在正文改写中的使用。

## 20. API 草案

### 创建预览

```http
POST /api/agent/revisions/preview
{
  "conversationId": "c_001",
  "agentRunId": "r_001",
  "noteId": "n_001",
  "filePath": "notes/demo.md",
  "draftContent": "# 修改后的内容",
  "parentOperationSetId": null
}
```

### 应用预览

```http
POST /api/agent/revisions/apply
{
  "operationSetId": "op_001"
}
```

### 废弃预览

```http
POST /api/agent/revisions/discard
{
  "operationSetId": "op_001"
}
```

### 回滚修订

```http
POST /api/agent/revisions/rollback
{
  "operationSetId": "op_001"
}
```

### 获取 diff

```http
GET /api/agent/revisions/{operationSetId}/diff
```

## 21. 开发顺序

### 第一阶段：最小可用版本

```txt
1. 新增 operation_set 表字段或新建 agent_operation_set 表
2. 实现 hash 计算
3. 实现 preview_file_revision
4. 实现代码 diff 生成
5. 前端支持 file_revision diff 卡片
6. 实现 apply_file_revision
7. 实现 discard_file_revision
```

这一阶段完成后，预览失败问题基本解决。

### 第二阶段：安全回滚

```txt
1. 应用成功后记录 applied_hash
2. 实现 rollback_file_revision
3. 前端展示回滚按钮
4. hash 不一致时展示 rollback_conflict
```

### 第三阶段：自动模式统一

```txt
1. Agent 自动修改也先生成 revision
2. preview 后立即 apply
3. apply 失败时保留 revision 和错误原因
4. 前端展示自动应用结果
```

### 第四阶段：优化体验

```txt
1. 超长 diff 折叠
2. 按 Markdown 标题分组
3. no_change 处理
4. 旧 pending 自动 supersede
5. 错误信息进入日志页面
```

## 22. 测试用例

### 22.1 正常预览

```txt
给一篇短文
Agent 改 1 处
生成 pending revision
前端展示 diff
正式文件未变化
```

### 22.2 大量碎片修改

```txt
给一篇长文
Agent 改 30 处以上
生成 diff 成功
不依赖 LLM 输出 old/new
```

### 22.3 应用成功

```txt
current_hash 等于 base_hash
写入 draft_content
状态变为 applied
记录 applied_hash
```

### 22.4 应用冲突

```txt
生成预览后，用户手动修改文件
再点击应用
current_hash 不等于 base_hash
状态变为 stale
正式文件不变
```

### 22.5 废弃预览

```txt
pending 状态点击废弃
状态变为 discarded
正式文件不变
```

### 22.6 自动模式成功

```txt
真实审批模式为自动确认
生成 revision
Agent Loop 立即 apply
状态为 applied
前端可查看 diff
```

### 22.7 自动模式失败

```txt
生成 revision 后模拟文件变化
apply 失败
状态为 stale 或 apply_failed
正式文件不变
```

### 22.8 回滚成功

```txt
应用后文件未再修改
点击回滚
current_hash 等于 applied_hash
写回 base_content
状态变为 rolled_back
```

### 22.9 回滚冲突

```txt
应用后用户又修改文件
点击回滚
current_hash 不等于 applied_hash
状态变为 rollback_conflict
正式文件不变
```

### 22.10 pending supersede

```txt
同一文件已有 pending
新预览生成
旧 pending 变为 superseded
新 revision 为 pending
```

## 23. 关键注意事项

```txt
1. diff 只能展示，不能用于正式应用
2. apply 必须用 base_hash 校验
3. rollback 必须用 applied_hash 校验
4. 旧 pending 不能物理删除
5. 自动模式不能绕过 revision
6. 写文件必须用临时文件 + rename
7. Agent 不再生成 old/new patch 作为预览依据
8. 编辑器未保存内容必须先保存
9. 文件变化时宁可失败，也不能覆盖
```

## 24. 最终结论

第一版按“单文件暂存修订”实现即可：

```txt
Agent 生成 draft_content
代码保存 base_content + draft_content
代码生成 diff 预览
应用时校验 base_hash
回滚时校验 applied_hash
```

这套设计已经足够解决 Notus 当前的预览失败问题，也能把应用和回滚变成可校验、可追溯的确定性流程。复杂的三方合并、多文件预览、局部回滚可以后续再加。
