# 知识库页 Chat 全流程业务文档

> 更新时间：2026-07-10
> 状态：已归档为兼容说明。

`/knowledge` 已跳转到 `/files`，不再存在独立知识库 Chat 页面。

原有单索引检索、`/api/chat`、来源定位和知识库会话数据继续保留为后端兼容能力。新的用户入口是文件工作区右侧 Notus Agent：Agent 需要工作区事实或语义材料时，按任务调用 `search_knowledge`，并可继续调用 `read_file` 读取完整 Markdown 正文。Agent 的单个检索调用由服务端扩展为原词优先的 3→5 查询计划，查询、命中和空结果都以任务级脱敏回执保存；最终资料/文件回执卡当前由代码开关暂时关闭，详细流程见 `docs/File_Workspace_Agent_Business_Flow.md`。

当前的完整业务流程见 `docs/File_Workspace_Agent_Business_Flow.md`。
