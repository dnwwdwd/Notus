# Skill与MCP设置与任务级授权收敛

## 分类与状态

- 分类：功能优化 / 用户体验优化
- 状态：已完成

## 目标

简化 MCP 的授权边界和 Skill 安装入口，避免 Server 配置与任务授权并存；收紧设置页的信息层级。

## 实现

1. MCP Server 表单不再配置工具权限。AI 输入框选择指定 Server 或自动模式后，授权仅作用于当前任务；已停用 Server 不出现在输入菜单，失效的本地选择自动回退为关闭。
2. 旧 `tool_policy_json` 保留在数据库中兼容历史数据，但不再参与 MCP 调用；逐工具授权卡与持久化默认授权停止使用。
3. Skill 与 MCP 设置页改为右上操作栏和紧凑列表；设置标题栏显示当前功能名与图标。两个新增弹窗点击遮罩不会关闭。
4. Git 安装仅输入 HTTPS 仓库地址，依次尝试 `main` 和 `master`，要求仓库根目录存在 `SKILL.md`；最终目录与标识以 `SKILL.md` 的 `name` 为准，可与仓库名不同。
5. 模型设置导航、标题和 LLM 配置区统一使用机器人图标。

## 验证

- `npm run lint:web`
- `npm --prefix notus run test:skill-mcp`
- `npm run build:web`
