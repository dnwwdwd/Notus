# 放开Agent非删除文件系统写入范围

## 分类

功能优化

## 背景

用户要求 Agent 整理笔记库结构时具备全库非删除写入能力。此前 Agent session 会携带当前打开文档所在目录作为 `authorized_paths`，导致根目录下的目录重命名、跨目录移动文件和移动目录可能被误拒绝。

## 需求

1. Agent 可以在整个笔记库内创建、修改、重命名和移动文件或目录。
2. Agent 不开放删除文件和删除目录能力。
3. 侧边栏右键文件管理属于用户显式操作，继续直接应用并刷新文件树，不进入 DiffDialog。
4. Agent 文件级和文件系统操作继续按自动确认/手动确认处理：自动确认模式自动应用，手动确认模式进入消息摘要卡和 DiffDialog。
5. 移动目录或重命名目录时，目录下文件随目录一起移动，并更新文件记录与索引。

## 实现记录

1. `validateWrite()` 保留 session token、过期时间、会话状态、操作类型和删除禁用校验，取消 `authorized_paths` 对 `create/modify` 类写入的路径拦截。
2. Agent 系统提示从“当前任务授权写入范围”改为“当前任务写入能力”，明确全库非删除写入和自动/手动确认边界。
3. `preview_file_operations` 继续拒绝删除类操作；`rename_folder`、`move_folder`、`move_file` 和 `create_folder` 不再因当前文档目录授权被拒绝。
4. 新增 `notus/tests/agent-write-policy.test.js` 覆盖根目录目录重命名、移动文件、移动目录和删除拒绝。

## 验收

- Agent session 即使记录的 `authorized_paths` 为 `typora_files`，也能为根目录 `专利 -> 专利1` 生成 `rename_folder` 预览。
- Agent 可生成跨目录 `move_file` 和 `move_folder` 预览。
- Agent 删除目录或删除文件仍返回拒绝。
- 侧边栏目录新建、重命名、删除和文件移动仍直接应用，不进入 DiffDialog。
