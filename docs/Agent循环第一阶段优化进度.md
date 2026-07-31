# Agent Loop 细节优化（第一批）进度文档

更新时间：2026-06-24

## 1. 文档目的

本文件专门记录 Agent Loop 细节优化第一批的完整问题范围、分组依赖、当前排查/修复状态和后续执行顺序。  
本批问题的前提是：Agent Loop 主流程已验收通过，本轮处理的是权限、日志、确认/回滚机制和 UI 细节问题。

## 2. 总体分组与当前状态

| 分组 | 范围 | 依赖关系 | 当前状态 | 说明 |
|---|---|---|---|---|
| A 组 | 权限 bug + 日志缺失，问题 1a/1b | 独立，优先修 | 已排查并已修复 | 已完成代码、文档、验证和远端推送 |
| B 组 | 回滚粒度 + 确认机制 + 自动应用 bug，问题 3/4/5/6 | 四个问题强依赖，必须整体设计和整体实现 | 已设计并已实现，待真实 Loop 烟测 | 已落地 prompt 底部常驻 diff 卡片、文件级状态机、自动确认/手动确认语义和应用不续跑 |
| C 组 | 页面跳转优化 + 确认模式选择框 + 搜索引擎/联网开关，问题 2/7/8 | UI 细节，建议在 B 组后处理 | 已排查并已实现，待浏览器截图确认 | 已落地 Canvas 路由加载骨架、自动/手动分段控件、搜索引擎单选和联网开关实时保存 |

## 3. 问题总表

| 编号 | 分组 | 问题 | 类型 | 当前状态 | 本次是否已修 |
|---|---|---|---|---|---|
| 1a | A | `create_note` 新建同目录文件时报 `PATH_NOT_AUTHORIZED` | bug | 已修复 | 是 |
| 1b | A | Agent Loop 工具调用、轮次、报错无法在日志页追溯 | bug | 已修复 | 是 |
| 2 | C | 从文件页/知识库页跳转到创作页时，“开始新创作/生成文章大纲”停留过久 | 性能/体验 bug | 已修复 | 是 |
| 3 | B | 顶部 Agent Loop 卡片承担任务级整体回滚，粒度过粗且干扰主编辑区 | 机制设计 bug | 已修复 | 是 |
| 4 | B | 每个 prompt 完成后缺少常驻对话底部 diff 卡片和文件级应用/回滚状态 | 机制设计 bug | 已修复 | 是 |
| 5 | B | 自动应用/手动应用语义与实际执行不一致，需要改为自动确认/手动确认 | 机制设计 bug | 已修复 | 是 |
| 6 | B | 点击“应用修改”会触发二次 Agent 工作/总结，效率低且行为错误 | bug | 已修复 | 是 |
| 7 | C | 自动/手动确认选择框 UI 不符合新业务语义，仍是下拉框且图标不直观 | UI bug/体验问题 | 已修复 | 是 |
| 8 | C | 搜索引擎选择和联网开关不符合预期：疑似多选、提示文案过窄、开关不实时保存 | UI/配置 bug | 已修复 | 是 |

## 4. A 组已完成记录

### 4.1 问题 1a：`create_note` 路径权限报错

现象：

```json
{"error":"PERMISSION_DENIED","message":"PATH_NOT_AUTHORIZED: typora_files/Notus历代版本功能.md"}
```

排查结论：

- 前端 Loop 任务此前默认把当前 `.md` 文件路径放入 `authorized_paths`。
- `isPathSafe()` 原先只支持精确文件命中或授权目录前缀命中。
- 当 Agent 调用 `create_note` 新建 `typora_files/Notus历代版本功能.md` 时，如果授权项是 `typora_files/当前文章.md`，后端会认为目标不在授权范围内。
- Windows `\` 与 POSIX `/` 混用也需要统一 normalize，避免误判。

已修复：

- 新增无数据库副作用的路径规则模块 `notus/lib/agentPathRules.js`。
- `validateWrite()` 现在按操作类型调用 `isPathSafe(targetPath, authorizedPaths, operation)`。
- `create` 支持授权文件父目录内新建文件，兼容旧任务；`modify` 不因授权当前文件而扩大到同目录其他文件。
- 创作页和知识库页默认授权路径改为当前文件所在目录。
- 新增 `notus/tests/agent-session-paths.test.js` 覆盖目录授权、文件父目录新建、Windows 分隔符和绝对路径拒绝。

验证：

- `npm --prefix notus run test:agent-session` 通过。
- `npm run lint:web` 通过。
- `npm run build:web` 通过。
- `git diff --check` 通过。

### 4.2 问题 1b：Agent Loop 日志无法在日志页面追溯

排查结论：

- 后端已有 `agent_run_logs` 表和 `logToolCall()` 记录链路。
- 主要缺口在日志页没有读取 Agent Loop session/run_logs。
- 历史会话列表也没有提供进入某个会话 Agent Loop 日志的入口。

已修复：

- 新增 `GET /api/agent/sessions`，支持按最近 session 查询，并支持 `conversation_id` 过滤。
- `GET /api/agent/sessions/:id` 支持无 token 只读模式，返回去敏 session、`run_logs`、快照数量和预览集合。
- 设置页日志新增 “Agent Loop 执行日志” 区块，按 session 和轮次展示工具调用。
- 日志条目展示工具名、结果摘要、失败状态和耗时；失败条目高亮。
- 会话历史抽屉增加 Agent Loop 日志入口，按 `conversation_id` 跳转到日志页。

验证：

- `npm --prefix notus run test:agent-session` 通过。
- `npm run lint:web` 通过。
- `npm run build:web` 通过。
- `git diff --check` 通过。

## 5. B 组已完成范围

B 组四个问题共享同一套“任务 diff 卡片”和“确认/回滚状态机”，不能拆开单独实现。

### 5.1 已确认根因

1. `preview_patch_files` 原先把 session 置为 `waiting_confirm`，必须等用户应用后才能继续 Loop。
2. 前端 `applyOperationSet()` 默认再次调用 `/api/agent/loop/start` 续跑，导致点击“应用修改”触发二次 LLM。
3. `/api/agent/loop/apply` 和 `applyPreviewWithConflictCheck()` 只支持 operation set 整体应用，不支持文件级状态。
4. UI 只能通过顶部 `AgentSessionCard` 和 `DiffDialog` 展示任务级状态，无法把 diff 卡片常驻到 prompt 消息底部。

### 5.2 已落地状态机

文件级状态记录在 `canvas_operation_sets.pathes_json` 的每个 patch 上：

```text
pending
  ├─ apply_file        -> applied
  ├─ auto_apply_all    -> auto_applied
  ├─ rollback_file     -> rolled_back
  └─ next_prompt       -> discarded

applied / auto_applied
  └─ rollback_file     -> rolled_back
```

operation set 状态由文件状态聚合为 `pending / applied / cancelled / partial`。

### 5.3 已实现内容

- 主对话顶部不再渲染 `AgentTaskConfirmCard` 和 `AgentSessionCard`。
- `preview_patch_files` 不再作为应用确认等待点；自动确认模式由后端直接 `apply_all`，手动确认模式生成待处理 diff 卡片。
- 每个 prompt 完成后，assistant 消息底部挂载常驻 `AgentDiffCard`，按文件展示 diff、状态、应用和回滚按钮。
- `/api/agent/loop/apply` 支持 `apply_file / rollback_file / discard_file / discard_pending / apply_all`。
- 点击文件级“应用修改”或“回滚修改”只调用 `/api/agent/loop/apply`，不再触发 `/api/agent/loop/start`。
- 发出下一条 prompt 前，会对当前对话仍为 `pending/failed` 的文件调用 `discard_pending`。
- `auto_apply/manual` 兼容迁移为 `auto_confirm/manual_confirm`，C 组再处理选择框视觉。

验证状态：

- `node --check notus/lib/canvasOperationSets.js` 通过。
- `node --check notus/lib/agentTools.js` 通过。
- `node --check notus/lib/agentLoop.js` 通过。
- `node --check notus/pages/api/agent/loop/apply.js` 通过。
- `node --check notus/pages/api/agent/loop/start.js` 通过。
- `node --check notus/pages/api/conversations/[id].js` 通过。
- `node --check notus/hooks/useAgentLoopController.js` 通过。
- `git diff --check` 通过，仅提示 Windows 下 LF/CRLF 工作区转换。
- `npm run lint:web` 通过。
- `npm run build:web` 通过。
- `npm --prefix notus run test:agent-session` 通过。
- `npm --prefix notus run test:knowledge-routing` 通过。

## 6. C 组已完成范围

### 6.1 问题 2：跳转到创作页时初始化停留过久

排查结论：

- `/canvas?fileId=...` 初始进入时 `article` 仍为空，原 `!article` 分支直接渲染 `CanvasEntry`，所以短时间内会露出“开始一篇新的创作 / 生成大纲”。
- 路由同步和文件加载本身是异步流程，不应让“已有目标文件”进入新建创作空态。

已修复：

- 新增 `getCanvasRouteFileId()`，优先从 `router.query.fileId` 和 `router.asPath` 判断当前是否正在打开已有文档。
- 新增 `CanvasRouteLoading` 骨架态；当存在 `fileId` 且 `article` 尚未就绪时，显示“正在打开文档…”工作区骨架，不再显示新建创作入口。
- 文件列表加载完成后若目标文件不存在，显示“未找到要打开的文档”，并提供返回创作首页按钮。

### 6.2 问题 7：自动/手动确认选择框 UI 调整

已修复：

- `AgentConfirmModeSelect` 不再渲染下拉框，改为输入框工具栏内的双选项分段控件。
- 可见文字只保留“自动 / 手动”，说明文案移入 tooltip。
- 自动确认使用 `zap` 闪电图标，手动确认使用 `hand` 手型图标，不再使用 wand/eye/设置类图标。
- 控件使用 `radiogroup` / `role="radio"` 暴露当前选择状态。

### 6.3 问题 8：搜索引擎选择框 + 联网开关优化

排查结论：

- `AgentInput` 原先使用 `selectedSearchProviders` 数组，搜索引擎菜单天然支持多选。
- 输入框启用联网时检查的是 `api_key_set`，弹窗文案也把 API Key 当成前置条件。
- 设置页 `Toggle` 只调用 `patchConfig({ enabled })` 修改本地状态，必须点击底部“保存”才写入 `/api/settings/search-providers`。

已修复：

- `AgentInput` 内部状态改为单个 `selectedSearchProvider`，菜单改为单选 `radiogroup`；提交时仍兼容传出单元素 `searchProviders` 数组。
- 启用联网只检查 `searchConfig.enabled`，未开启时提示“需要开启联网搜索功能才能使用，请前往设置 → 搜索配置 → 启用联网搜索”，不再强制要求 API Key。
- 设置页“启用联网搜索”开关通过 `onChange` 立即调用 `/api/settings/search-providers` 保存，仅该开关实时保存；服务商、模式、结果数和 API Key 仍由底部“保存”按钮提交。

验证状态：

- `node --check notus/pages/canvas.js` 通过。
- `node --check notus/components/AgentWorkspace/AgentWorkspace.js` 通过。
- `node --check notus/components/Settings/SettingsScreen.js` 通过。
- `npm run lint:web` 通过。
- `npm run build:web` 通过。
- `npm --prefix notus run test:agent-session` 通过。
- `npm --prefix notus run test:knowledge-routing` 通过。
- `git diff --check` 通过，仅提示 Windows 下 LF/CRLF 工作区转换。

## 7. 后续执行顺序

1. B 组已完成代码落地和本地静态验证，仍需要浏览器真实 Loop 烟测。
2. C 组已完成代码落地，仍需要浏览器截图/交互确认。
3. 最后按完整自查清单验收。

## 8. 完整自查清单

- [x] `create_note` 在授权目录下能正常创建文件，不报 `PATH_NOT_AUTHORIZED`。
- [x] 执行一次 Loop 后，日志页面能看到按轮次展示的工具调用记录，报错条目高亮。
- [x] 自动确认模式下，Agent 完成后文件直接写入，对话底部出现“已自动应用”状态的 diff 卡片。
- [x] 手动确认模式下，Agent 完成后 diff 卡片出现，逐文件操作，点击立即生效。
- [x] 点击“应用修改”后，不触发任何 LLM 调用。
- [x] 第 N+1 条 prompt 发出时，第 N 条未处理的文件修改自动废弃。
- [x] 顶部不再出现 Agent Loop 卡片。
- [x] 联网搜索开关实时保存，不依赖“保存”按钮。

## 9. 本次已经完成的事项

- A 组已排查。
- A 组已修复。
- A 组已通过本地验证。
- A 组相关实现文档已同步。
- A 组代码已推送到 GitLab 和 GitHub。
- B 组状态机已输出。
- B 组代码已实现。
- B 组文档已同步。
- C 组问题已排查。
- C 组代码已实现。
- C 组文档已同步。

## 10. 本次尚未完成的事项

- B 组还未做浏览器真实 Loop 烟测。
- C 组截图/确认未完成。
