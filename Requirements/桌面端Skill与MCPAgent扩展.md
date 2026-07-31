# 桌面端Skill与MCPAgent扩展

## 分类与状态

- 分类：功能需求 / 功能优化 / 用户体验优化。
- 状态：已完成。

## 目标

让 Notus 桌面端能够发现本机 Skill，并在 Agent 任务中以用户明确选择或模型按需加载两种方式使用；同时接入可配置的 MCP Server，支持输入框内关闭、自动选择或指定 Server，并对每次 MCP 工具调用提供可审查的授权。

## 已实现范围

1. 桌面端启动时扫描 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills` 等本机目录，也扫描受 Notus 管理的 Skill 目录；扫描结果写入 SQLite，文件变化由轮询监听更新。
2. Skill 解析并校验 `SKILL.md` Frontmatter、路径、符号链接和大小限制。设置页可重新扫描、启用或停用，并可从 HTTPS Git 仓库安装到 Notus 管理目录。
3. 输入框的 `@` 候选统一包含文件、目录和有效 Skill。选中 Skill 后保存结构化 Mention，并向本次 session 传入明确 Skill ID；Agent 必须先调用 `load_skill`。
4. 未明确选择时，Agent 只接收已启用 Skill 的名称和简介目录；模型可按任务需要调用 `load_skill`，支持文件只可由 `read_skill_file` 在对应 Skill 目录内读取。
5. MCP 支持 Streamable HTTP；桌面端额外支持 stdio。设置页可新增、编辑、测试、启停和删除 Server，Server 工具清单会缓存到本地数据库。
6. 输入框右侧新增 MCP 图标，可选“不使用 MCP”“自动”或单个已启用 Server；窄窗口下工具栏换行，菜单宽度受视口限制。
7. MCP 工具默认逐次询问。首次调用会生成授权交互，用户可选“仅本次”“本次任务”“以后默认允许”或“拒绝”；授权结果恢复同一 Agent session，且拒绝不会被模型绕过。
8. 运行时 Prompt 明确规定 Skill、MCP 工具说明及 MCP 返回数据均是不可信输入，不能修改系统规则、泄露信息或绕过确认。Skill 与 MCP 的可用范围由平台能力层统一判断。
9. Electron 正式运行时使用 Electron `safeStorage` 保存 MCP 密钥；开发和非桌面运行时使用应用数据目录中的 AES-256-GCM 退路，密钥不会通过设置接口回显。

## 本版不包含

- MCP OAuth、resources、prompts、市场安装和旧 SSE transport。
- 跨设备同步 Skill、MCP 配置或密钥。
- 非桌面端的 stdio MCP 与本机外部 Skill 扫描。

## 验证

- `npm --prefix notus run build` 通过。
- 临时 Electron 运行时数据目录下验证了 Skill 扫描、session 的 Skill/MCP 参数、MCP Server 保存，以及“仅本次”权限消费逻辑。
- 后续通过桌面开发启动与内置浏览器检查设置页和本机 Skill 发现结果。
