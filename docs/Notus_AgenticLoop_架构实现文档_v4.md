# Notus Agentic Loop 架构实现文档

> v4.1 · 面向开发者的完整实现规范
> 覆盖：架构分层、文件权限系统、数据库、核心模块、Prompt Engineering、API、错误处理
>
> **v4.0 相对 v3.0 变更说明：**
> - 修复 续跑字段名不一致：`saveMessagesCheckpoint` 第四参数统一为 `appliedToolUseId`，`loadMessagesCheckpoint` 返回字段对齐
> - 修复 `apply` 接口 SSE 机制：明确职责拆分——`apply` 只做写入+更新状态返回 JSON，前端收到后重新调用 `/start` 携带 `session_id` 续跑
> - 修复 `search_knowledge` 限制设计：任务确认卡默认值改为按场景动态推荐，支持用户在确认卡上调整（3/5/不限制）
> - 修复 `analyze_folder` 安全边界：补充 `max_files` 上限（默认 200），防止遍历超大目录
> - 修复 索引更新缺失：新建/修改文件后触发增量索引，明确同步/异步策略
> - 修复 `messages_checkpoint` 大小：存入前执行 `compactMessages` 压缩，并记录预期大小范围
> - 修复 回滚删除新建文件缺少冲突检测：删除前检查文件是否被外部修改，有修改则提示用户确认
>
> **v4.1 相对 v4.0 变更说明（2026-06-24）：**
> - 移除预览生成后的 `waiting_preview_confirm` 主流程暂停；`preview_patch_files` 生成 operation set 后，Loop 按自动确认/手动确认规则直接完成。
> - `/api/agent/loop/apply` 不再承担“应用后续跑”职责；应用、回滚、废弃只更新文件和 patch 状态，不触发 LLM。
> - 任务确认卡和顶部 session/回滚卡从主流程移除，文件变更统一展示在对应助手消息底部的常驻 diff 卡片。
> - 回滚粒度从任务级整体回滚调整为文件级 patch 回滚；未处理 patch 在下一条 prompt 发出前自动标记为 `discarded`。

---

## 一、功能概述

### 1.1 目标

将现有 canvasAgent 的"单轮规划 + 执行"升级为真正的 **Agentic Loop**：用户给出目标，Agent 自主决定调用哪些工具、调用多少轮，直到达成目标或触发终止条件。

### 1.2 与现有能力的关系

| 维度 | 现有 canvasAgent | Agentic Loop |
|------|-----------------|-------------|
| 输入 | 具体指令（"把第三段改成…"） | 模糊目标（"把读书笔记整理成文章"） |
| 执行 | 一次规划 + 一批操作 | 多轮 tool call，自主决策下一步 |
| 知识库 | 用户手动指定参考文件 | Agent 主动调用 `search_knowledge` tool |
| 写入 | 单文件块级 diff | 修改已有文件走批量预览，新建文件即时落盘 |
| 撤销 | 无 | 文件级 patch 应用/回滚/废弃（自动确认仍保留回滚入口） |
| 用户感知 | 即时操作，无过程可见 | 实时工具链可视化 + 任务进度 |

### 1.3 写入策略

**修改已有文件**：必须通过 `preview_patch_files` 生成批量预览。自动确认模式由服务端在 Loop 完成前自动落盘；手动确认模式在对话底部 diff 卡片中逐文件应用或回滚。

**新建文件**：通过 `create_note` 即时写入磁盘，不走预览流程。理由：新建文件不存在覆盖风险，且每次新建都打断 loop 等待确认会破坏 Agent 执行的连续性。新建的文件路径会记录在 `created_files` 字段，回滚时一并处理（含冲突检测）。

**其他硬性边界：**
- Agent **只能在用户授权范围内写入**，不访问外部网络、不执行系统命令
- **删除权限永远不开放**，当前阶段直接拒绝 delete 操作
- **读取不受授权路径限制**：`search_knowledge` 和 `read_file` 可访问全库内容，授权路径只限制写入。这是有意的设计决策：限制读取会严重削弱检索能力，而读取本身不会造成数据损坏
- `search_knowledge` 单次任务调用上限由前端启动参数传入（默认值见 §1.4）
- Loop 软提示上限 **15 轮**，硬上限 **30 轮**（详见 §2.4）

### 1.4 `search_knowledge` 调用上限设计

固定 3 次对于"检查全库孤立笔记"等需要分批检索的复杂任务明显不够。当前由前端按任务场景传入推荐值，后续可在可见会话设置中调整：

| 任务类型 | 推荐上限 | 说明 |
|---------|---------|------|
| 单文件整理/改写 | 3 次 | 只需少量参考 |
| 跨文件主题提炼 | 5 次 | 需要多角度检索 |
| 全库分析/孤立笔记 | 不限制 | 需要按目录分批检索 |

**不限制时的保护措施：**
- 连续 3 次返回结果完全相同（哈希相同）→ 触发死循环检测，停止 loop
- 每次 `search_knowledge` 消耗的 token 会在进度日志中累计展示
- 总 token 超过 llmConfig 中配置的 token budget 80% 时，触发 context 压缩

---

## 二、架构设计

### 2.1 整体分层

```
┌─────────────────────────────────────────────────────────────┐
│                        前端 UI 层                             │
│  AgentTaskPanel  ToolChainVisualizer  BatchPreviewModal      │
│  TaskConfirmCard  AgentSessionBadge                          │
└───────────────────────────┬─────────────────────────────────┘
                            │ SSE / REST
┌───────────────────────────▼─────────────────────────────────┐
│                    API 层 pages/api/agent/                    │
│  loop/start.js   loop/cancel.js   loop/apply.js             │
│  sessions/[id].js   sessions/[id]/rollback.js               │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                   lib/agentLoop.js（新）                      │
│  runAgentLoop()        主循环控制器                           │
│  checkTermination()    终止条件判断（含异常检测）              │
│  compactMessages()     Context window 管理                   │
└──────────┬──────────────────────────────┬───────────────────┘
           │                              │
┌──────────▼──────────┐      ┌────────────▼──────────────────┐
│  lib/agentSession.js │      │     lib/agentTools.js         │
│  （新）               │      │     （新）                     │
│                      │      │                               │
│  createSession()     │      │  search_knowledge（轻量版）    │
│  validateWrite()     │      │  read_file                    │
│  snapshotFiles()     │      │  create_note                  │
│  rollbackSession()   │      │  preview_patch_files          │
│  saveCheckpoint()    │      │  analyze_folder               │
│  loadCheckpoint()    │      │  check_links                  │
│  logToolCall()       │      │                               │
│  checkToolLimit()    │      │                               │
└──────────────────────┘      └───────────────────────────────┘
                                          │
                              ┌───────────▼───────────────────┐
                              │   lib/indexer.js（现有）        │
                              │   triggerIncrementalIndex()    │
                              └───────────────────────────────┘
```

### 2.2 新增文件清单

```
lib/
├── agentLoop.js           # 主循环控制器
├── agentSession.js        # session 管理、权限校验、快照、checkpoint、轨迹记录
├── agentTools.js          # 工具定义 + 执行器
├── agentLoopPrompt.js     # Loop 专用 Prompt 模板
└── agentSessionCleaner.js # 历史 waiting_confirm / 过期 session 清理定时任务

pages/api/agent/
├── loop/
│   ├── start.js           # 启动 loop（SSE，硬上限暂停后可继续）
│   ├── cancel.js          # 取消正在运行的 loop
│   └── apply.js           # 文件级应用/回滚/废弃（只做写入+状态更新，返回 JSON）
└── sessions/
    ├── [id].js            # 查询 session 状态（断线重连重建 UI）
    └── [id]/rollback.js   # 历史任务级回滚兼容接口
```

### 2.3 数据库新增表

```sql
-- Agent 任务会话
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id      INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  -- pending / running / waiting_confirm / completed / cancelled / failed
  goal                 TEXT NOT NULL,
  authorized_paths     TEXT NOT NULL DEFAULT '[]',
  authorized_ops       TEXT NOT NULL DEFAULT '["modify","create"]',  -- 不含 delete
  created_files        TEXT NOT NULL DEFAULT '[]',    -- JSON，agent 新建的文件路径列表
  loop_count           INTEGER NOT NULL DEFAULT 0,
  soft_limit           INTEGER NOT NULL DEFAULT 15,
  hard_limit           INTEGER NOT NULL DEFAULT 30,
  search_knowledge_limit INTEGER,                     -- NULL 表示不限制
  tool_call_counts     TEXT NOT NULL DEFAULT '{}',
  consecutive_fails    TEXT NOT NULL DEFAULT '{}',
  last_tool_results    TEXT NOT NULL DEFAULT '{}',    -- 工具结果哈希，用于死循环检测
  messages_checkpoint  TEXT,                          -- 压缩后的 messages JSON，暂停续跑用
  checkpoint_tool_use_id TEXT,                        -- 触发暂停的 tool_use_id，续跑时构造 tool_result
  waiting_since        DATETIME,                      -- 硬上限或历史 waiting_confirm 的时间
  session_token        TEXT UNIQUE NOT NULL,
  expires_at           DATETIME,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 任务级文件快照（loop 开始前打）
CREATE TABLE IF NOT EXISTS agent_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,
  content      TEXT NOT NULL,
  file_hash    TEXT NOT NULL,   -- SHA-256，用于乐观锁校验和回滚冲突检测
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON agent_snapshots(session_id);

-- Loop 运行轨迹（断线重连重建 UI 用）
CREATE TABLE IF NOT EXISTS agent_run_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  loop_index   INTEGER NOT NULL,
  tool_name    TEXT,
  tool_input   TEXT,
  tool_result  TEXT,            -- 结果摘要（不存完整内容）
  thinking     TEXT,            -- 模型 thinking 文本，流式拼接后存储
  status       TEXT NOT NULL DEFAULT 'success',  -- success / failed / permission_denied
  duration_ms  INTEGER,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_runlogs_session ON agent_run_logs(session_id, loop_index);

-- 关联现有表（通过迁移脚本执行，见 §2.5）
-- canvas_operation_sets 新增 agent_session_id 字段
```

### 2.4 Loop 轮次设计

**软提示上限：15 轮。硬停止上限：30 轮。**

| 任务复杂度 | 典型轮次 | 举例 |
|-----------|---------|------|
| 简单整理 | 3～5 轮 | 把某篇笔记改写成文章 |
| 中等检索+写入 | 6～10 轮 | 跨多篇笔记提炼主题、生成新文档 |
| 复杂分析 | 10～15 轮 | 分析全库孤立笔记并补全链接 |
| 超出 15 轮 | 软提示，继续跑 | 进度日志插入提示条 |
| 超出 30 轮 | 强制暂停询问 | 用户可选择续跑 +10 轮或停止 |

**终止条件（按优先级）：**

```
1. 目标达成    模型输出 end_turn 且无待执行 tool_use
2. 死循环检测  同一工具连续 3 次返回结果哈希完全相同
3. 连续失败    同一工具连续失败 2 次
4. 无进展检测  连续 2 轮没有调用任何工具（模型卡住）
5. 硬上限      loop_count >= hard_limit（30 轮），强制暂停询问用户
```

**软提示逻辑（不打断 loop）：**

```javascript
if (loopIndex === session.soft_limit ||
   (loopIndex > session.soft_limit && (loopIndex - session.soft_limit) % 5 === 0)) {
  onStream({ type: 'soft_limit_notice', loop_index: loopIndex });
}
```

### 2.5 数据库迁移策略

新表通过 `CREATE TABLE IF NOT EXISTS` 在应用启动时自动创建。

对已有表的修改通过版本化迁移脚本管理：

```javascript
// lib/migrations/005_agent_loop.js
module.exports = {
  version: 5,
  up(db) {
    // SQLite ADD COLUMN 不支持外键约束，外键关联在应用层校验
    db.prepare(`
      ALTER TABLE canvas_operation_sets ADD COLUMN agent_session_id INTEGER
    `).run();
  },
  down(db) {
    // SQLite 不支持 DROP COLUMN，down 迁移为 no-op
  }
};
```

迁移运行器在应用启动时检查 `schema_version` 表，按版本号顺序执行未执行的迁移。

### 2.6 `waiting_confirm` 超时清理

```javascript
// lib/agentSessionCleaner.js
function startSessionCleaner() {
  setInterval(() => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stale = db.prepare(`
      SELECT id FROM agent_sessions
      WHERE status = 'waiting_confirm' AND waiting_since < ?
    `).all(oneHourAgo);

    for (const { id } of stale) {
      db.prepare(`
        UPDATE agent_sessions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(id);
    }
  }, 10 * 60 * 1000); // 每 10 分钟检查一次
}
```

---

## 三、文件权限系统

### 3.1 设计原则

- **令牌化授权**：Agent 拿到的是本次任务的有限写权限，不是工作区的全局权限
- **任务级粒度**：每次任务单独授权，任务结束后 token 自动过期（24 小时）
- **操作类型分离**：modify 和 create 独立控制，delete 永远不在授权范围内
- **目录级新建**：新建文件授权到目录粒度，不授权到具体文件名；兼容旧任务只授权当前 `.md` 文件时，仅允许在该文件父目录中新建，不扩大同目录其他文件的修改权限
- **读取不受限**：检索和读取可访问全库，只有写入受 `authorized_paths` 约束
- **系统层拦截**：校验函数与 Agent 逻辑完全解耦，Agent 绕不过去

### 3.2 `lib/agentSession.js` 完整实现

```javascript
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');

// ─── Session 生命周期 ────────────────────────────────────────────

function createSession({
  goal,
  authorizedPaths,
  authorizedOps = ['modify', 'create'],
  conversationId,
  softLimit = 15,
  hardLimit = 30,
  searchKnowledgeLimit = 5,  // null 表示不限制，默认 5（中等任务）
}) {
  const safeOps = authorizedOps.filter(op => op !== 'delete');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    INSERT INTO agent_sessions
      (goal, authorized_paths, authorized_ops, session_token, expires_at,
       soft_limit, hard_limit, search_knowledge_limit, conversation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    goal,
    JSON.stringify(authorizedPaths),
    JSON.stringify(safeOps),
    token,
    expiresAt,
    softLimit,
    hardLimit,
    searchKnowledgeLimit,
    conversationId ?? null
  );

  return { sessionId: result.lastInsertRowid, token };
}

function getSession(sessionId) {
  const row = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId);
  if (!row) throw new Error(`Session ${sessionId} not found`);
  return {
    ...row,
    authorized_paths:  JSON.parse(row.authorized_paths),
    authorized_ops:    JSON.parse(row.authorized_ops),
    created_files:     JSON.parse(row.created_files),
    tool_call_counts:  JSON.parse(row.tool_call_counts),
    consecutive_fails: JSON.parse(row.consecutive_fails),
    last_tool_results: JSON.parse(row.last_tool_results),
    // search_knowledge_limit 保持原始值（number 或 null）
  };
}

function updateSessionStatus(sessionId, status) {
  const extra = status === 'waiting_confirm' ? ', waiting_since = CURRENT_TIMESTAMP' : '';
  db.prepare(`
    UPDATE agent_sessions SET status = ?${extra}, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(status, sessionId);
}

function updateSessionLoopCount(sessionId, loopCount) {
  db.prepare('UPDATE agent_sessions SET loop_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(loopCount, sessionId);
}

// ─── 权限校验 ────────────────────────────────────────────────────

function validateWrite(token, targetPath, operation) {
  const row = db.prepare('SELECT * FROM agent_sessions WHERE session_token = ?').get(token);
  if (!row) return { valid: false, reason: 'INVALID_TOKEN' };
  if (new Date(row.expires_at) < new Date()) return { valid: false, reason: 'TOKEN_EXPIRED' };
  if (!['running', 'waiting_confirm'].includes(row.status))
    return { valid: false, reason: 'SESSION_NOT_ACTIVE' };
  if (operation === 'delete') return { valid: false, reason: 'DELETE_NEVER_ALLOWED' };

  const authorizedOps = JSON.parse(row.authorized_ops);
  if (!authorizedOps.includes(operation))
    return { valid: false, reason: `OPERATION_NOT_AUTHORIZED: ${operation}` };

  const authorizedPaths = JSON.parse(row.authorized_paths);
  if (!isPathSafe(targetPath, authorizedPaths, operation))
    return { valid: false, reason: `PATH_NOT_AUTHORIZED: ${targetPath}` };

  return { valid: true };
}

/**
 * 路径安全检查
 * 已知限制：未解析符号链接，本地单用户场景风险极低，后续可用 fs.realpathSync 加固
 */
function normalizeAgentPath(value) {
  return path.normalize(String(value || '').replace(/\\/g, '/')).replace(/\\/g, '/').replace(/^\/+/, '');
}

function getAgentPathDir(value) {
  const normalized = normalizeAgentPath(value);
  if (!normalized || !normalized.includes('/')) return '';
  return normalized.slice(0, normalized.lastIndexOf('/'));
}

function isPathSafe(targetPath, authorizedPaths, operation = 'modify') {
  const normalized = normalizeAgentPath(targetPath);
  if (!normalized) return false;
  if (normalized.includes('..')) return false;
  if (path.isAbsolute(String(targetPath || ''))) return false;

  return authorizedPaths.some(authPath => {
    const normalizedAuth = normalizeAgentPath(authPath);
    if (normalizedAuth === '') return true;
    if (normalized === normalizedAuth) return true;
    if (normalized.startsWith(`${normalizedAuth}/`)) return true;

    if (operation === 'create' && normalizedAuth.toLowerCase().endsWith('.md')) {
      const authDir = getAgentPathDir(normalizedAuth);
      return authDir ? getAgentPathDir(normalized) === authDir : !normalized.includes('/');
    }

    return false;
  });
}

// ─── 新建文件追踪 ─────────────────────────────────────────────────

function trackCreatedFile(sessionId, filePath) {
  return db.transaction(() => {
    const row = db.prepare('SELECT created_files FROM agent_sessions WHERE id = ?').get(sessionId);
    const files = JSON.parse(row.created_files);
    if (!files.includes(filePath)) {
      files.push(filePath);
      db.prepare('UPDATE agent_sessions SET created_files = ? WHERE id = ?')
        .run(JSON.stringify(files), sessionId);
    }
  })();
}

// ─── 快照管理 ────────────────────────────────────────────────────

async function snapshotFiles(sessionId, notesDir) {
  const session = getSession(sessionId);
  const existingPaths = new Set(
    db.prepare('SELECT file_path FROM agent_snapshots WHERE session_id = ?')
      .all(sessionId).map(r => r.file_path)
  );

  const insert = db.prepare(
    'INSERT INTO agent_snapshots (session_id, file_path, content, file_hash) VALUES (?, ?, ?, ?)'
  );

  const filesToSnapshot = [];
  for (const authPath of session.authorized_paths) {
    const absPath = path.join(notesDir, authPath);
    if (!fs.existsSync(absPath)) continue;

    if (fs.statSync(absPath).isDirectory()) {
      for (const f of getAllMdFiles(absPath)) {
        const relPath = path.relative(notesDir, f);
        if (existingPaths.has(relPath)) continue;
        const content = fs.readFileSync(f, 'utf8');
        filesToSnapshot.push({
          filePath: relPath, content,
          hash: crypto.createHash('sha256').update(content).digest('hex')
        });
      }
    } else if (!existingPaths.has(authPath)) {
      const content = fs.readFileSync(absPath, 'utf8');
      filesToSnapshot.push({
        filePath: authPath, content,
        hash: crypto.createHash('sha256').update(content).digest('hex')
      });
    }
  }

  db.transaction((files) => {
    for (const { filePath, content, hash } of files) insert.run(sessionId, filePath, content, hash);
  })(filesToSnapshot);

  return { snapshotCount: filesToSnapshot.length };
}

/**
 * 回滚整个任务：
 * 1. 恢复快照文件内容（修改过的文件还原）
 * 2. 处理 agent 新建的文件（含冲突检测）
 *
 * 新建文件回滚冲突检测：
 * - 如果新建文件在任务结束后被用户手动修改（hash 与新建时不同），不直接删除
 * - 返回 conflicts 列表，由调用方决定是否强制删除
 */
async function rollbackSession(sessionId, notesDir, forceDeleteCreated = false) {
  const session = getSession(sessionId);
  const snapshots = db.prepare('SELECT * FROM agent_snapshots WHERE session_id = ?').all(sessionId);
  let restoredCount = 0;
  const errors = [];
  const conflicts = [];  // 新建文件被外部修改，需要用户确认

  // 1. 恢复修改过的文件
  for (const snap of snapshots) {
    try {
      const absPath = path.join(notesDir, snap.file_path);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, snap.content, 'utf8');
      restoredCount++;
    } catch (err) {
      errors.push({ path: snap.file_path, error: err.message });
    }
  }

  // 2. 处理 agent 新建的文件
  for (const filePath of session.created_files) {
    const absPath = path.join(notesDir, filePath);
    if (!fs.existsSync(absPath)) continue;

    // 检查文件是否被外部修改（通过 frontmatter created_by 标识的原始内容做对比）
    // 简化实现：检查文件 mtime 是否晚于 session created_at
    const stat = fs.statSync(absPath);
    const sessionCreatedAt = new Date(session.created_at);
    const fileModifiedAt = stat.mtime;
    const wasExternallyModified = fileModifiedAt > sessionCreatedAt;

    if (wasExternallyModified && !forceDeleteCreated) {
      conflicts.push(filePath);
      continue;
    }

    try {
      fs.unlinkSync(absPath);
      restoredCount++;
    } catch (err) {
      errors.push({ path: filePath, error: err.message });
    }
  }

  const hasConflicts = conflicts.length > 0;
  if (!hasConflicts && errors.length === 0) updateSessionStatus(sessionId, 'cancelled');

  return { restoredCount, errors, conflicts };
}

// ─── Messages Checkpoint ─────────────────────────────────────────

/**
 * 保存 messages 快照到数据库，供续跑时恢复
 *
 * 存入前执行 compactMessages 压缩，控制存储体积
 * 预期大小：压缩后通常 10～50KB（20 轮以内），100KB 以内属于正常范围
 *
 * 字段统一说明：
 * - appliedToolUseId：触发暂停的 preview_patch_files tool_use_id
 *   续跑时需要把这个 id 的 tool_result 构造为 { applied: true } 追加到 messages
 */
function saveMessagesCheckpoint(sessionId, messages, lastResponseContent, appliedToolUseId) {
  // 压缩后再存，防止 messages 过大
  const compacted = compactMessagesForStorage(messages);
  const checkpoint = {
    messages: compacted,
    last_response_content: lastResponseContent,
    saved_at: new Date().toISOString()
  };
  db.prepare(`
    UPDATE agent_sessions
    SET messages_checkpoint = ?, checkpoint_tool_use_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(checkpoint), appliedToolUseId, sessionId);
}

/**
 * 读取 checkpoint，用于续跑时恢复 messages 上下文
 * 返回字段与 saveMessagesCheckpoint 完全对齐
 */
function loadMessagesCheckpoint(sessionId) {
  const row = db.prepare(
    'SELECT messages_checkpoint, checkpoint_tool_use_id FROM agent_sessions WHERE id = ?'
  ).get(sessionId);
  if (!row?.messages_checkpoint) return null;

  const cp = JSON.parse(row.messages_checkpoint);
  return {
    messages: cp.messages,
    lastResponseContent: cp.last_response_content,  // 暂停前那轮的 assistant response content
    appliedToolUseId: row.checkpoint_tool_use_id,   // 用于构造 tool_result
  };
}

function clearMessagesCheckpoint(sessionId) {
  db.prepare(`
    UPDATE agent_sessions
    SET messages_checkpoint = NULL, checkpoint_tool_use_id = NULL
    WHERE id = ?
  `).run(sessionId);
}

/**
 * 存储前的压缩版本：比运行时更激进，中间轮次的 tool_result 全部替换为摘要
 * 失败的 tool_result 仍然保留（防止模型重复失败路径）
 */
function compactMessagesForStorage(messages) {
  const recentCount = 6; // 存储时只保留最近 3 轮完整
  const keep = messages.slice(-recentCount);
  const compress = messages.slice(0, -recentCount);

  return compress.map(msg => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(block => {
          if (block.type === 'tool_result') {
            const parsed = safeParseJSON(block.content);
            if (parsed?.error) return block; // 失败记录不压缩
            return {
              ...block,
              content: JSON.stringify({ _compacted: true, summary: buildCompactSummary(parsed) })
            };
          }
          return block;
        })
      };
    }
    return msg;
  }).concat(keep);
}

// ─── 工具调用管控 ────────────────────────────────────────────────

function checkAndIncrementToolCount(sessionId, toolName) {
  return db.transaction(() => {
    const row = db.prepare(
      'SELECT tool_call_counts, search_knowledge_limit FROM agent_sessions WHERE id = ?'
    ).get(sessionId);
    const counts = JSON.parse(row.tool_call_counts);
    const current = counts[toolName] ?? 0;

    // search_knowledge 的上限来自 session 配置（null 表示不限制）
    const limit = toolName === 'search_knowledge'
      ? row.search_knowledge_limit  // null = 不限制
      : TOOL_HARD_LIMITS[toolName]; // 其他工具的硬限制

    if (limit !== null && limit !== undefined && current >= limit) {
      return { allowed: false, count: current };
    }

    counts[toolName] = current + 1;
    db.prepare('UPDATE agent_sessions SET tool_call_counts = ? WHERE id = ?')
      .run(JSON.stringify(counts), sessionId);
    return { allowed: true, count: current + 1 };
  })();
}

// 非 search_knowledge 工具的硬限制（不可配置）
const TOOL_HARD_LIMITS = {};

function logToolCall({ sessionId, loopIndex, toolName, toolInput, toolResult, thinking = null, status = 'success', durationMs }) {
  db.prepare(`
    INSERT INTO agent_run_logs
      (session_id, loop_index, tool_name, tool_input, tool_result, thinking, status, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, loopIndex, toolName,
    JSON.stringify(toolInput),
    JSON.stringify(summarizeToolResult(toolName, toolResult)),
    thinking,
    status,
    durationMs
  );
}

function detectDeadloop(sessionId, toolName, toolResult) {
  return db.transaction(() => {
    const row = db.prepare('SELECT last_tool_results FROM agent_sessions WHERE id = ?').get(sessionId);
    const lastResults = JSON.parse(row.last_tool_results);
    const resultHash = crypto.createHash('md5').update(JSON.stringify(toolResult)).digest('hex');

    if (!lastResults[toolName]) {
      lastResults[toolName] = { hash: resultHash, count: 1 };
    } else if (lastResults[toolName].hash === resultHash) {
      lastResults[toolName].count++;
    } else {
      lastResults[toolName] = { hash: resultHash, count: 1 };
    }

    db.prepare('UPDATE agent_sessions SET last_tool_results = ? WHERE id = ?')
      .run(JSON.stringify(lastResults), sessionId);
    return lastResults[toolName].count >= 3;
  })();
}

function recordToolFail(sessionId, toolName) {
  return db.transaction(() => {
    const row = db.prepare('SELECT consecutive_fails FROM agent_sessions WHERE id = ?').get(sessionId);
    const fails = JSON.parse(row.consecutive_fails);
    fails[toolName] = (fails[toolName] ?? 0) + 1;
    db.prepare('UPDATE agent_sessions SET consecutive_fails = ? WHERE id = ?')
      .run(JSON.stringify(fails), sessionId);
    return fails[toolName] >= 2;
  })();
}

function resetToolFail(sessionId, toolName) {
  return db.transaction(() => {
    const row = db.prepare('SELECT consecutive_fails FROM agent_sessions WHERE id = ?').get(sessionId);
    const fails = JSON.parse(row.consecutive_fails);
    fails[toolName] = 0;
    db.prepare('UPDATE agent_sessions SET consecutive_fails = ? WHERE id = ?')
      .run(JSON.stringify(fails), sessionId);
  })();
}

// ─── 辅助函数 ─────────────────────────────────────────────────────

function getAllMdFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...getAllMdFiles(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

function summarizeToolResult(toolName, result) {
  if (result?.error) return { error: result.error, message: result.message };
  switch (toolName) {
    case 'search_knowledge':
      return { result_count: result.results?.length ?? 0, remaining_calls: result.remaining_calls };
    case 'read_file':
      return { char_count: result.content?.length ?? 0, file_path: result.file_path };
    case 'create_note':
      return { created_path: result.path };
    case 'preview_patch_files':
      return { file_count: result.patch_count ?? 0, operation_set_id: result.operation_set_id };
    case 'analyze_folder':
      return { file_count: result.file_count ?? 0 };
    case 'check_links':
      return { orphan_count: result.orphan_count ?? 0, broken_count: result.broken_count ?? 0 };
    default:
      return { ok: true };
  }
}

function buildCompactSummary(result) {
  if (result?.result_count !== undefined) return `检索到 ${result.result_count} 条结果`;
  if (result?.char_count !== undefined) return `已读取文件（${result.char_count} 字）`;
  if (result?.created_path) return `已创建 ${result.created_path}`;
  return '操作已完成';
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

module.exports = {
  createSession, getSession, updateSessionStatus, updateSessionLoopCount,
  validateWrite, trackCreatedFile, snapshotFiles, rollbackSession,
  saveMessagesCheckpoint, loadMessagesCheckpoint, clearMessagesCheckpoint,
  checkAndIncrementToolCount, logToolCall, detectDeadloop, recordToolFail, resetToolFail,
};
```

---

## 四、工具层实现

### 4.1 工具定义格式（Anthropic tool_use）

全部工具定义在 `lib/agentTools.js` 中，通过 `buildToolDefinitions(session)` 构建后传入 LLM。

### 4.2 `preview_patch_files` 唯一性约束

**Prompt 层约束：** system prompt 明确要求 `preview_patch_files` 必须是该轮唯一工具调用。

**代码层约束（执行前检测）：**

```javascript
function validateToolUseBlock(toolUseBlocks) {
  const hasPreview = toolUseBlocks.some(t => t.name === 'preview_patch_files');
  if (hasPreview && toolUseBlocks.length > 1) {
    return {
      error: true,
      errorToolUseId: toolUseBlocks.find(t => t.name === 'preview_patch_files').id,
      message: 'preview_patch_files 必须是该轮的唯一工具调用，请在下一轮单独调用它。'
    };
  }
  return { error: false };
}
```

违规时将错误作为 tool result 返回给模型，loop 继续下一轮让模型重新规划。

### 4.3 search_knowledge（轻量版）

```javascript
{
  name: "search_knowledge",
  description: "在用户的笔记知识库中检索相关内容。需要查找笔记信息时调用。可以用不同查询词多次调用，剩余调用次数会在结果中返回。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      scope_paths: { type: "array", items: { type: "string" }, description: "可选，限定检索范围" },
      top_k: { type: "integer", default: 5 }
    },
    required: ["query"]
  }
}

async function executeSearchKnowledge({ query, scope_paths, top_k = 5 }, sessionId) {
  const { allowed, count } = checkAndIncrementToolCount(sessionId, 'search_knowledge');
  if (!allowed) return { error: 'SEARCH_LIMIT_REACHED', message: '知识库检索已达本次任务上限' };

  const session = getSession(sessionId);
  const limit = session.search_knowledge_limit;
  const remaining = limit === null ? '不限' : limit - count;

  const chunks = await hybridSearch(query, { topK: Math.min(top_k, 10), scopePaths: scope_paths });

  return {
    call_index: count,
    remaining_calls: remaining,
    results: chunks.map(c => ({
      file_title: c.file_title,
      file_path: c.file_path,
      heading_path: c.heading_path,
      content: c.content.length > 800
        ? c.content.slice(0, 800) + '…[已截断，如需完整内容请用 read_file]'
        : c.content,
      score: Math.round(c.score * 100) / 100
    }))
  };
}
```

### 4.4 create_note

新建文件即时写入，通过 `trackCreatedFile` 追踪，写入后触发增量索引。

```javascript
async function executeCreateNote({ path: filePath, content, title }, sessionId, notesDir) {
  const session = getSession(sessionId);
  const check = validateWrite(session.session_token, filePath, 'create');
  if (!check.valid) return { error: check.reason, path: filePath };

  const absPath = path.join(notesDir, filePath);
  if (fs.existsSync(absPath)) return { error: 'FILE_ALREADY_EXISTS', path: filePath };

  const finalContent = title
    ? `---\ntitle: ${title}\ncreated_by: notus_agent\n---\n\n${content}`
    : content;

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, finalContent, 'utf8');

  trackCreatedFile(sessionId, filePath);

  // 触发增量索引（异步，不阻塞 loop 继续执行）
  // Agent 在同一任务的后续轮次用 read_file 读全文，不依赖索引
  // 新文件的索引会在后台完成，任务结束后即可被检索到
  triggerIncrementalIndex(filePath, notesDir).catch(err =>
    console.warn(`[AgentLoop] 增量索引失败（非致命）: ${filePath}`, err.message)
  );

  return { path: filePath, created: true };
}
```

### 4.5 preview_patch_files

触发后 loop 暂停，apply 时做乐观锁校验。

```javascript
async function executePreviewPatchFiles({ patches }, sessionId) {
  const session = getSession(sessionId);
  for (const patch of patches) {
    const check = validateWrite(session.session_token, patch.file_path, 'modify');
    if (!check.valid) return { error: check.reason, path: patch.file_path };
  }

  const operationSet = await createOperationSet({
    agent_session_id: sessionId,
    patches,
    conversation_id: session.conversation_id,
  });

  return { operation_set_id: operationSet.id, patch_count: patches.length };
}

/**
 * apply 时乐观锁校验：确认文件在 preview 生成后未被外部修改
 * 对比当前 hash 与快照时的 hash
 */
async function applyPreviewWithConflictCheck(operationSetId, sessionId, notesDir) {
  const snapshots = db.prepare(
    'SELECT * FROM agent_snapshots WHERE session_id = ?'
  ).all(sessionId);

  const conflicts = [];
  for (const snap of snapshots) {
    const absPath = path.join(notesDir, snap.file_path);
    if (!fs.existsSync(absPath)) continue;
    const currentContent = fs.readFileSync(absPath, 'utf8');
    const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');
    if (currentHash !== snap.file_hash) conflicts.push(snap.file_path);
  }

  if (conflicts.length > 0) return { conflict: true, conflicting_files: conflicts };

  await applyOperationSet(operationSetId);

  // apply 后触发增量索引（异步）
  const patchedFiles = await getPatchedFilePaths(operationSetId);
  for (const filePath of patchedFiles) {
    triggerIncrementalIndex(filePath, notesDir).catch(err =>
      console.warn(`[AgentLoop] 增量索引失败（非致命）: ${filePath}`, err.message)
    );
  }

  return { conflict: false };
}
```

### 4.6 analyze_folder

```javascript
{
  name: "analyze_folder",
  description: "分析目录下的文件结构，返回文件列表、标题和基本元信息。",
  input_schema: {
    type: "object",
    properties: {
      folder_path: { type: "string", description: "目录路径，空字符串表示根目录" },
      include_content_preview: { type: "boolean", default: false }
    },
    required: ["folder_path"]
  }
}

const ANALYZE_FOLDER_MAX_FILES = 200; // 防止遍历超大目录

async function executeAnalyzeFolder({ folder_path, include_content_preview = false }, sessionId, notesDir) {
  const absPath = path.join(notesDir, folder_path || '');
  if (!fs.existsSync(absPath)) return { error: 'FOLDER_NOT_FOUND', path: folder_path };

  const allMdFiles = getAllMdFiles(absPath);

  // 超出上限时截断并告知模型，让它缩小检索范围
  const truncated = allMdFiles.length > ANALYZE_FOLDER_MAX_FILES;
  const mdFiles = truncated
    ? allMdFiles.slice(0, ANALYZE_FOLDER_MAX_FILES)
    : allMdFiles;

  const files = mdFiles.map(f => {
    const relPath = path.relative(notesDir, f);
    const content = fs.readFileSync(f, 'utf8');
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const result = {
      path: relPath,
      title: titleMatch?.[1] ?? path.basename(f, '.md')
    };
    if (include_content_preview) result.preview = content.slice(0, 100);
    return result;
  });

  return {
    folder_path,
    file_count: files.length,
    total_count: allMdFiles.length,
    truncated,  // 告知模型是否被截断，让它决定是否分批处理
    truncate_limit: ANALYZE_FOLDER_MAX_FILES,
    files
  };
}
```

### 4.7 check_links

```javascript
{
  name: "check_links",
  description: "检查内部链接，找出孤立笔记（无入链也无出链）和断链。",
  input_schema: {
    type: "object",
    properties: {
      scope_path: { type: "string", description: "检查范围，空字符串表示全库" }
    },
    required: ["scope_path"]
  }
}

async function executeCheckLinks({ scope_path }, sessionId) {
  const result = await checkInternalLinks(scope_path);
  return {
    orphan_count: result.orphans.length,
    orphans: result.orphans,
    broken_count: result.brokenLinks.length,
    broken_links: result.brokenLinks
  };
}
```

---

## 五、主循环控制器

### 5.1 `lib/agentLoop.js`

```javascript
const NOTES_DIR = process.env.NOTES_DIR;

async function runAgentLoop({ sessionId, llmConfig, onStream, signal }) {
  const session = getSession(sessionId);

  const { snapshotCount } = await snapshotFiles(sessionId, NOTES_DIR);
  onStream({ type: 'snapshot_done', snapshot_count: snapshotCount });

  updateSessionStatus(sessionId, 'running');

  const tools = buildToolDefinitions(session);
  const systemPrompt = buildLoopSystemPrompt(session);

  // 尝试从 checkpoint 恢复（用于 preview 暂停后续跑）
  const checkpoint = loadMessagesCheckpoint(sessionId);
  let messages;

  if (checkpoint) {
    // 续跑：恢复上次暂停时的 messages，追加 preview 的 tool_result（已 apply）
    messages = checkpoint.messages;
    messages.push({ role: 'assistant', content: checkpoint.lastResponseContent });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: checkpoint.appliedToolUseId,  // 字段名与 saveMessagesCheckpoint 对齐
        content: JSON.stringify({ applied: true, message: '修改已写入文件' })
      }]
    });
    clearMessagesCheckpoint(sessionId);
  } else {
    messages = [{ role: 'user', content: buildInitialUserMessage(session.goal, session) }];
  }

  let loopIndex = session.loop_count;
  let noToolRounds = 0;
  let thinkingBuffer = '';

  while (true) {
    if (signal?.aborted) {
      updateSessionStatus(sessionId, 'cancelled');
      onStream({ type: 'cancelled' });
      return;
    }

    loopIndex++;
    updateSessionLoopCount(sessionId, loopIndex);
    onStream({ type: 'loop_start', loop_index: loopIndex });

    if (loopIndex === session.soft_limit ||
       (loopIndex > session.soft_limit && (loopIndex - session.soft_limit) % 5 === 0)) {
      onStream({ type: 'soft_limit_notice', loop_index: loopIndex });
    }

    if (loopIndex > session.hard_limit) {
      updateSessionStatus(sessionId, 'waiting_confirm');
      onStream({ type: 'loop_done', reason: 'hard_limit_reached', loop_index: loopIndex });
      return;
    }

    const compactedMessages = compactMessages(messages);
    const response = await callLLMWithRetry({ system: systemPrompt, messages: compactedMessages, tools, llmConfig });
    const { textBlocks, toolUseBlocks, stopReason } = parseResponse(response);

    thinkingBuffer = textBlocks.map(b => b.text).join('\n');
    for (const block of textBlocks) {
      onStream({ type: 'thinking', text: block.text, loop_index: loopIndex });
    }

    if (stopReason === 'end_turn' && toolUseBlocks.length === 0) {
      logToolCall({ sessionId, loopIndex, toolName: null, toolInput: null, toolResult: null, thinking: thinkingBuffer, status: 'success', durationMs: 0 });
      updateSessionStatus(sessionId, 'completed');
      onStream({ type: 'loop_done', reason: 'goal_achieved', loop_index: loopIndex });
      return;
    }

    if (toolUseBlocks.length === 0) {
      noToolRounds++;
      if (noToolRounds >= 2) {
        updateSessionStatus(sessionId, 'failed');
        onStream({ type: 'loop_done', reason: 'no_progress', loop_index: loopIndex });
        return;
      }
    } else {
      noToolRounds = 0;
    }

    // preview_patch_files 唯一性校验
    const validationResult = validateToolUseBlock(toolUseBlocks);
    if (validationResult.error) {
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: validationResult.errorToolUseId, content: validationResult.message, is_error: true }]
      });
      continue;
    }

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      if (!TOOL_EXECUTORS[toolUse.name]) {
        const result = { error: 'UNKNOWN_TOOL', tool_name: toolUse.name };
        toolResults.push({ tool_use_id: toolUse.id, content: JSON.stringify(result), is_error: true });
        onStream({ type: 'tool_done', tool_name: toolUse.name, failed: true, loop_index: loopIndex });
        continue;
      }

      onStream({ type: 'tool_start', tool_name: toolUse.name, tool_input_summary: summarizeInput(toolUse), loop_index: loopIndex });

      const startTime = Date.now();
      const result = await executeToolSafely(toolUse, session);
      const duration = Date.now() - startTime;
      const failed = !!result?.error;

      logToolCall({
        sessionId, loopIndex,
        toolName: toolUse.name,
        toolInput: toolUse.input,
        toolResult: result,
        thinking: thinkingBuffer,
        status: failed ? 'failed' : 'success',
        durationMs: duration
      });
      thinkingBuffer = '';

      onStream({ type: 'tool_done', tool_name: toolUse.name, result_summary: summarizeToolResult(toolUse.name, result), loop_index: loopIndex, failed });

      if (failed) {
        const shouldStop = recordToolFail(sessionId, toolUse.name);
        if (shouldStop) {
          updateSessionStatus(sessionId, 'failed');
          onStream({ type: 'loop_done', reason: 'consecutive_tool_failure', tool_name: toolUse.name, loop_index: loopIndex });
          return;
        }
      } else {
        resetToolFail(sessionId, toolUse.name);
        if (detectDeadloop(sessionId, toolUse.name, result)) {
          updateSessionStatus(sessionId, 'failed');
          onStream({ type: 'loop_done', reason: 'deadloop_detected', tool_name: toolUse.name, loop_index: loopIndex });
          return;
        }
      }

      toolResults.push({ tool_use_id: toolUse.id, content: JSON.stringify(result) });

      // preview_patch_files 生成 operation set（此时必是当轮唯一 tool call，已通过唯一性校验）
      if (toolUse.name === 'preview_patch_files' && !result.error) {
        const applied = approvalMode === 'auto_confirm'
          ? await applyPreviewWithConflictCheck(result.operation_set_id, sessionId, { auto: true })
          : null;
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ ...result, applied }) }]
        });
        updateSessionStatus(sessionId, 'completed');
        onStream({ type: 'loop_done', reason: 'goal_achieved', loop_index: loopIndex, operation_set_id: result.operation_set_id });
        return;
        // 后续用户点击 diff 卡片只调用 /apply 更新文件与 patch 状态，不再续跑 Loop
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content }))
    });
  }
}

async function executeToolSafely(toolUse, session) {
  try {
    if (['create_note', 'preview_patch_files'].includes(toolUse.name)) {
      const targetPaths = extractTargetPaths(toolUse);
      for (const p of targetPaths) {
        const op = toolUse.name === 'create_note' ? 'create' : 'modify';
        const check = validateWrite(session.session_token, p, op);
        if (!check.valid) return { error: 'PERMISSION_DENIED', path: p, reason: check.reason };
      }
    }
    return await TOOL_EXECUTORS[toolUse.name](toolUse.input, session.id, NOTES_DIR);
  } catch (err) {
    return { error: 'TOOL_EXECUTION_ERROR', message: err.message };
  }
}
```

### 5.2 Context Window 管理

```javascript
function compactMessages(messages, tokenBudget = 60000) {
  const estimated = estimateTokens(messages);
  if (estimated < tokenBudget * 0.7) return messages;

  const recentCount = 8; // 保留最近 4 轮完整内容
  const keep = messages.slice(-recentCount);
  const compress = messages.slice(0, -recentCount);

  return compress.map(msg => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(block => {
          if (block.type === 'tool_result') {
            const parsed = safeParseJSON(block.content);
            if (parsed?.error) return block; // 失败记录保留，防止模型重复失败路径
            return {
              ...block,
              content: JSON.stringify({ _compacted: true, summary: buildCompactSummary(parsed) })
            };
          }
          return block;
        })
      };
    }
    return msg;
  }).concat(keep);
}
```

### 5.3 SSE 连接管理

```javascript
// pages/api/agent/loop/start.js
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const controller = new AbortController();
  res.on('close', () => controller.abort()); // SSE 断开时自动停止 loop

  const onStream = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const { session_id, goal, authorized_paths, authorized_ops,
            conversation_id, soft_limit, hard_limit, search_knowledge_limit } = req.body;

    let sessionId = session_id;

    if (sessionId) {
      // 续跑模式：session_id 存在，直接从 checkpoint 恢复
      const session = getSession(sessionId);
      if (!['waiting_confirm', 'running'].includes(session.status)) {
        return res.status(400).json({ error: 'SESSION_NOT_RESUMABLE' });
      }
      onStream({ type: 'session_resumed', session_id: sessionId });
    } else {
      // 首次启动
      const { sessionId: newId, token } = createSession({
        goal, authorizedPaths: authorized_paths, authorizedOps: authorized_ops,
        conversationId: conversation_id, softLimit: soft_limit, hardLimit: hard_limit,
        searchKnowledgeLimit: search_knowledge_limit
      });
      sessionId = newId;
      onStream({ type: 'session_created', session_id: sessionId, session_token: token });
    }

    await runAgentLoop({ sessionId, llmConfig: getLLMConfig(req), onStream, signal: controller.signal });
  } catch (err) {
    onStream({ type: 'error', error: err.message, code: err.code ?? 'UNKNOWN' });
  } finally {
    res.end();
  }
}
```

### 5.4 LLM 调用与重试

```javascript
async function callLLMWithRetry({ system, messages, tools, llmConfig }, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLM({ system, messages, tools, llmConfig });
    } catch (err) {
      lastError = err;
      if (err.status === 429) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      if ((err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') && attempt < maxRetries) continue;
      throw err;
    }
  }
  throw lastError;
}
```

---

## 六、Prompt Engineering

### 6.1 System Prompt

```
你是 Notus 工作区的 AI 协作 Agent，帮助用户完成本地笔记工作区内的知识整理和创作任务。

## 工作原则

**只用工具获取信息。** 需要了解笔记内容时，通过 search_knowledge 或 read_file 工具获取，不能凭记忆假设用户笔记里有什么内容。

**先了解再行动。** 在生成写入预览前，充分检索和阅读相关笔记，确保输出基于用户真实内容。

**谨慎调用写入工具。**
- preview_patch_files 调用后会立即暂停等待用户确认，用户确认后才继续
- preview_patch_files 必须单独作为该轮的唯一工具调用，不能与任何其他工具同时出现
- 在完全准备好所有修改内容后再一次性调用

**告知你的进展。** 每轮开始时用一两句话说明接下来要做什么。

## 工具使用约束

- search_knowledge：剩余调用次数在每次结果中返回，合理分配
- 写入工具只能操作授权范围内的文件
- 禁止删除文件

## 知识库搜索策略

第一次：宽泛关键词获取全局概览
第二次（如需要）：针对第一次线索，更具体的词深挖
后续（如不限制）：每次用不同角度的词，避免重复相同查询
检索后若信息不足，如实说明，不要编造内容

## analyze_folder 使用说明

当目录文件数超过 200 时，结果会被截断（truncated=true），你可以通过指定子目录路径分批分析。

## 任务完成时的输出格式

**任务完成**
已完成：[具体说明]
文件变更：[创建/修改了哪些文件]
未完成：[如有，说明原因]

## 当前任务授权写入范围

{{authorized_paths_list}}
```

### 6.2 初始 User Message

```javascript
function buildInitialUserMessage(goal, session) {
  const limitText = session.search_knowledge_limit === null
    ? '不限制'
    : `${session.search_knowledge_limit} 次`;

  return `请帮我完成以下任务：

${goal}

写入授权范围：
${session.authorized_paths.map(p => `- ${p}`).join('\n')}

知识库检索上限：${limitText}

请先说明执行计划，然后开始执行。`;
}
```

---

## 七、API 设计

### 7.1 启动 Loop / 硬上限继续执行

`/start` 主要承担首次启动职责；硬上限暂停后可继续执行：

- 首次启动：不传 `session_id`，创建新 session，开始 loop
- 继续执行：传入 `session_id`（状态为 `waiting_confirm` 且 reason 为硬上限），从 checkpoint 恢复继续 loop

文件级预览应用不再通过 `/start` 续跑；用户点击 diff 卡片后只调用 `/api/agent/loop/apply` 更新文件和 patch 状态。

```
POST /api/agent/loop/start

Body（首次启动）: {
  goal: string,
  authorized_paths: string[],
  authorized_ops?: string[],
  conversation_id?: number,
  soft_limit?: number,           // 默认 15
  hard_limit?: number,           // 默认 30
  search_knowledge_limit?: number | null  // null=不限制，默认 5
}

Body（继续执行）: {
  session_id: number             // 仅此字段，其他忽略
}

→ SSE：
  { type: 'session_created', session_id, session_token }  // 首次启动
  { type: 'session_resumed', session_id }                 // 硬上限继续执行
  { type: 'snapshot_done', snapshot_count }
  { type: 'loop_start', loop_index }
  { type: 'soft_limit_notice', loop_index }
  { type: 'thinking', text, loop_index }
  { type: 'tool_start', tool_name, tool_input_summary, loop_index }
  { type: 'tool_done', tool_name, result_summary, loop_index, failed }
  { type: 'loop_done', reason, loop_index, operation_set_id? }
    reason: 'goal_achieved' | 'hard_limit_reached' | 'consecutive_tool_failure'
          | 'deadloop_detected' | 'no_progress'
  { type: 'cancelled' }
  { type: 'error', error, code }
```

### 7.2 取消 Loop

```
POST /api/agent/loop/cancel

Body: { session_id: number }
→ { success, status }
```

### 7.3 文件级应用 / 回滚 / 废弃（只做写入和状态更新，不触发 SSE）

```
POST /api/agent/loop/apply

Body: {
  session_id: number,
  operation_set_id: number,
  action: 'apply_file' | 'rollback_file' | 'discard_file' | 'discard_pending' | 'apply_all' | 'extend',
  patch_index?: number,
  file_path?: string,
  extra_loops?: number,        // action='extend' 时有效，默认 10
  force?: boolean              // 强制覆盖冲突文件，默认 false
}

action='apply_file'
  → 校验当前文件存在唯一 old 文本
  → 无冲突：写入文件，patch.status = 'applied'
    返回 { success: true, operation_set }
  → 有冲突且 force=false：
    返回 { conflict: true, conflicting_files: string[] }
    前端展示冲突文件，由用户决定是否强制覆盖

action='rollback_file'
  → 已应用 patch 使用 new -> old 恢复，未应用 patch 直接标记 rolled_back
  → 返回 { success: true, operation_set }

action='discard_file' / action='discard_pending'
  → 未处理 patch 标记 discarded，不写磁盘
  → 返回 { success: true, operation_set }

action='apply_all'
  → 兼容旧整体应用入口，逐个应用 pending patch
  → 返回 { success: true, operation_set }

action='extend'
  → 更新 hard_limit += extra_loops（默认 +10）
  → 返回 { success: true, new_hard_limit: number }
  → 前端收到后调用 POST /start（传入 session_id）续跑 loop
```

**前端逐文件确认流程：**

```
用户点击"应用修改"或"回滚修改"
  → POST /apply { action: 'apply_file' | 'rollback_file', operation_set_id, patch_index, ... }
  → 收到 { success: true, operation_set }
  → 更新对话底部 diff 卡片状态，不调用 LLM，不调用 /start
```

### 7.4 查询 Session（断线重连重建 UI / 日志页追溯）

```
GET /api/agent/sessions?limit=20&logs_limit=100&conversation_id=...

→ {
    sessions: [{
      ...safeSession,
      run_logs: AgentRunLog[],    // 按 session 和 loop_index 展示工具调用
      snapshots_count: number,
      operation_sets: OperationSet[]
    }]
  }
```

该列表接口供设置页日志视图使用。历史抽屉中包含 Agent Loop 的会话会根据 `agent_session_count` 显示日志入口，点击后带 `conversation_id` 跳转到日志页过滤。

```
GET /api/agent/sessions/:id

→ {
    session: AgentSession,
    run_logs: AgentRunLog[],    // 含 thinking，前端据此重建 ToolChainVisualizer
    snapshots_count: number,
    operation_sets: OperationSet[]
  }
```

断线重连后，前端调用单 session 接口根据 `run_logs` 和 `session.status` 重建 UI 状态。无 token 的 GET 只返回去敏后的只读 session、日志和预览集合，不暴露 `session_token`、checkpoint 消息和工具上下文；需要写入、应用或回滚的接口仍然必须带 token。

### 7.5 历史任务级回滚兼容接口

```
POST /api/agent/sessions/:id/rollback

Body: { force?: boolean }   // true=强制删除被外部修改的新建文件

→ {
    success: boolean,
    restored_count: number,
    errors: [{ path, error }],
    conflicts: string[]     // 新建文件被外部修改，需要用户确认是否强制删除
  }
```

---

## 八、索引更新策略

### 8.1 问题背景

Agent 新建或修改文件后，这些文件需要重新进入索引 pipeline（向量索引 + FTS5）才能被后续的 `search_knowledge` 检索到。如果同一任务的后续轮次想检索刚刚新建的内容，需要注意时机。

### 8.2 策略

**新建文件（`create_note`）：** 触发异步增量索引，不阻塞 loop。

Agent 在同一任务的后续轮次如果需要读刚刚新建的文件，应该用 `read_file`（直接读磁盘，不走索引），而不是 `search_knowledge`（走索引，可能还没建好）。在 system prompt 中明确这一点。

**修改文件（`preview_patch_files` apply 后）：** 同样触发异步增量索引。

**索引完成时机：** 用户确认 apply 后的几秒内后台完成，任务结束后即可被检索。

### 8.3 `lib/indexer.js` 新增接口

```javascript
/**
 * 对单个文件触发增量索引（复用现有 pipeline，只处理变化的文件）
 * @param {string} relPath   相对 notesDir 的路径
 * @param {string} notesDir
 * @returns {Promise<void>}
 */
async function triggerIncrementalIndex(relPath, notesDir) {
  // 复用现有增量索引逻辑（SHA-256 hash 比对，只重建变化文件）
  await indexFile(relPath, notesDir);
}
```

当前主流程不再把该接口作为用户入口；对话底部 diff 卡片通过 `/api/agent/loop/apply` 的 `rollback_file` 实现文件级回滚。该接口仅保留给历史 session、调试或未来管理员级恢复工具使用。

### 8.4 System Prompt 补充说明

```
## 新建文件后的读取方式

如果你刚刚用 create_note 新建了一个文件，在同一任务中想读取它的内容，
请用 read_file 而不是 search_knowledge——新建文件的索引需要时间更新，
search_knowledge 可能还检索不到刚刚创建的内容。
```

---

## 九、错误处理

| 场景 | 处理方式 | 前端感知 |
|------|---------|---------|
| LLM 调用失败（非 429） | 重试 1 次，仍失败转 `failed` | SSE error |
| LLM 429 Rate Limit | 指数退避重试（1s/2s/4s），最多 3 次 | 透明 |
| 畸形 tool call（未知工具名） | 返回 UNKNOWN_TOOL 给模型 | tool_done.failed=true |
| Tool 执行异常 | 返回 error 对象给模型，模型决定换策略 | tool_done.failed=true |
| 同一工具连续失败 2 次 | 停止，转 `failed` | loop_done reason=consecutive_tool_failure |
| 死循环（结果连续 3 次相同） | 停止，转 `failed` | loop_done reason=deadloop_detected |
| 无进展（连续 2 轮无 tool call） | 停止，转 `failed` | loop_done reason=no_progress |
| preview_patch_files 非唯一 | 返回错误给模型，loop 继续 | 透明 |
| apply 时文件被外部修改 | 返回冲突文件列表，等用户决策 | conflict 响应 |
| 回滚时新建文件被外部修改 | 返回 conflicts，等用户确认是否强制删除 | conflicts 数组 |
| search_knowledge 超限 | 返回 SEARCH_LIMIT_REACHED，模型继续 | tool_done result_summary |
| 权限校验失败 | 返回 PERMISSION_DENIED，loop 继续 | tool_done.failed=true |
| Context 超限 | compactMessages() 压缩（保留失败记录） | 透明 |
| 软上限（15 轮） | 插入提示，loop 继续 | soft_limit_notice 事件 |
| 硬上限（30 轮） | 暂停，转 waiting_confirm | loop_done reason=hard_limit_reached |
| 历史 waiting_confirm 超时（1 小时） | 定时任务自动 cancel，不回滚 | 下次查询 session 时感知 |
| SSE 断开 | signal.abort() 停止 loop | loop 停止 |
| 断线重连 | GET sessions/:id 重建 UI | ToolChainVisualizer 从 run_logs 恢复 |
| 用户取消 | 立即停止，展示是否回滚选项 | cancelled 事件 |
| 回滚部分失败 | 列出失败文件，不中断其他文件回滚 | errors 数组 |
| 增量索引失败 | 非致命，打印 warning，loop 继续 | 透明（任务不因索引失败而中止） |

---

## 十、已知限制（Known Limitations）

**符号链接穿越：** `isPathSafe` 未解析 symlink，本地单用户场景风险极低。后续可在 `isPathSafe` 中用 `fs.realpathSync()` 加固。

**API 无认证：** 依赖 session_token 作为唯一凭证，单用户本地部署可接受，网络暴露场景需加认证层。

**read-then-write 并发：** 所有计数器操作已用 SQLite transaction 保证原子性，单用户场景足够。

**`analyze_folder` 仅遍历 .md 文件：** 非 Markdown 文件（图片、附件等）不在返回结果中，如有需要后续扩展。

---

## 十一、未来扩展点

**任务模板：** goal + authorized_paths + search_knowledge_limit 预设包，用户一键启动

**任务拆分：** 硬上限触发时，Agent 主动建议拆分为多个子 session，共享同一 conversation

**并行 tool call：** 模型输出多个无依赖 tool_use 时并行执行（preview_patch_files 仍保持唯一性约束）

**任务回放：** 基于 agent_run_logs 逐步回放执行轨迹

**符号链接加固：** `isPathSafe` 引入 `fs.realpathSync()` 解析
