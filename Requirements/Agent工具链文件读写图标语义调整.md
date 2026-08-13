# Agent 工具链文件读写图标语义调整

## 分类与状态

- 分类：用户体验优化。
- 状态：已完成（自动化与本地 Web Mock 验证）。
- 对应台账：`REQ-20260810-002`。

## 范围

- `read_file`、`read_global_agent_file` 显示带文本行的文件读取图标。
- `create_note`、`preview_patch_files`、`preview_file_revision`、`preview_file_operations`、`update_global_agent_file` 显示文件编辑图标。
- 名称含 `skill` 或 `mcp` 的工具优先显示 `Icons.skill`、`Icons.mcp`，因此读取 Skill 文件和调用 MCP 不会落入通用文件图标。
- 已核查：不存在“长文自动分段生成并合并写回”的功能，因此没有可移除的实现；继续保留无法保证完整 `draft_content` 时不调用全文修订写入的安全兜底。

## 影响分析与验收

| 维度 | 结论 |
|---|---|
| 写入入口与持久化 | 仅 `ToolTraceIcon` 的前端映射变化，不改变工具调用、文件写入、预览、确认、SSE 或会话持久化。 |
| 读取方 | Web、Electron、懒猫共用 `AgentWorkspace`，均显示相同语义图标。 |
| 失败边界 | 失败、等待和取消状态图标仍优先于工具语义图标。 |
| 已检查但不受影响 | Agent 输出预算、全文修订策略、附件解析、Skill/MCP 权限与资源管理、累计 Diff 均不改变。 |

| 场景 | 操作 | 预期结果 | 验证状态 |
|---|---|---|---|
| 读取工作区或全局 Agent 文件 | 展开工具链 | 显示带文本行的文件图标。 | 自动化断言通过；本地 Mock 已验证。 |
| 新建、修改或预览文件 | 展开工具链 | 显示文件编辑图标。 | 自动化断言通过；本地 Mock 已验证。 |
| 读取 Skill 文件、调用 MCP | 展开工具链 | 分别保留 Skill 与服务器机架图标。 | 自动化断言通过；本地 Mock 已验证。 |

## 文档与验证

- 已同步：`docs/产品设计说明.md`、`docs/产品技术实现说明.md`、`docs/界面设计规范.md`、`docs/文件工作区Agent业务流程.md`。
- 已检查未更新：`docs/业务逻辑升级说明.md`、`docs/项目进度.md`、`docs/知识库对话业务流程.md`、`docs/Bug台账.md`，原因是本次不改变业务流程、里程碑、知识库路径或既有缺陷行为。
- 验证命令和本地 Web Mock 结果补充在本次交付中；未调用真实 Provider，不伪造真实工具结果。
