# AgentSkill与MCP全量受控管理

## 目标

让 Agent 使用专用工具管理 Skill 与 MCP，禁止把 Skill 伪造成笔记工作区文件。

## 交付口径

- Skill 支持列表、详情、草稿创建与校验、确认安装、受管全文修订、启停、Git 更新和卸载；外部扫描 Skill 只允许停用。
- MCP 支持列表、脱敏详情、新增、修改、测试、启停和确认删除。Header、环境变量和密钥值不进入 Tool 回执、SSE 或日志。
- Skill 安装、覆盖、卸载及 MCP 删除通过资源确认卡暂停同一 Agent session；取消不落盘，Skill 草稿保留 24 小时。
- Agent 没有真实 Tool 回执时不得声称资源已安装、删除或可用。
