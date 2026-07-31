# NotusAgent单文件暂存修订与代码差异预览

## 分类

功能优化

## 需求描述

当前 Agent 在大规模、碎片化修改时依赖 LLM 输出 `old/new` patch，容易因漏段、格式异常或原文匹配失败导致预览无法生成。需要按 `docs/Agent暂存修订与代码差异预览方案.md` 落地第一版单文件暂存修订机制，让 LLM 只提交修改后的完整草稿，预览 diff、应用和回滚由代码负责。

## 实现要求

1. 新增 `file_revision` 类型的 operation set，保存 `base_content / draft_content / base_hash / draft_hash / applied_hash` 等修订元数据。
2. 新增 `preview_file_revision` Agent 工具，用于提交单个已有 Markdown 文件的完整 `draft_content`。
3. 预览 diff 由代码按 base/draft 生成，不再依赖 LLM 产出碎片化 `old/new`。
4. 应用前校验当前文件 hash 等于 `base_hash`，不一致时标记 stale 且不写文件。
5. 回滚前校验当前文件 hash 等于 `applied_hash`，不一致时标记 rollback_conflict 且不覆盖用户后续修改。
6. 同一会话同一文件只保留一个 pending `file_revision`，新预览生成时旧 pending 标记为 superseded。
7. 自动确认模式也必须先生成 revision，再走同一套 apply 流程。
8. 前端 DiffDialog 识别 `file_revision`，展示代码生成的 hunks，并支持应用、废弃和回滚。

## 落地记录

1. 新增 `notus/lib/fileRevisionDiff.js`，实现内容规范化、SHA-256 hash 和行级 diff hunk 生成。
2. 新增 `notus/lib/fileRevisions.js`，实现 preview/apply/discard/rollback，正式写入使用临时文件 + fsync + rename。
3. 扩展 `canvas_operation_sets`，新增 revision 元数据字段和状态；查询时只返回 diff 与元数据，不向前端暴露完整 base/draft 正文。
4. `agentTools` 新增 `preview_file_revision`；Agent Loop 自动确认模式纳入自动应用，失败时带回 `operation_set_id` 以保留 diff 卡片。
5. `/api/agent/loop/apply` 根据 operation set 类型分流到 file revision 的 apply/discard/rollback。
6. `AgentWorkspace` 与备用 `FileOperationDiffDialog` 支持 `file_revision` diff、状态文案、废弃预览和安全回滚。
7. 知识库页与创作页的 pending 废弃逻辑纳入 `file_revision`。

## 验证

1. `node -c notus/lib/fileRevisionDiff.js`
2. `node -c notus/lib/fileRevisions.js`
3. `node -c notus/lib/canvasOperationSets.js`
4. `node -c notus/lib/agentTools.js`
5. `node -c notus/lib/agentLoop.js`
6. `node -c notus/pages/api/agent/loop/apply.js`
7. `npm --prefix notus run test:agent-session`
