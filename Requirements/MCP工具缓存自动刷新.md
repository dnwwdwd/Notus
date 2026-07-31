# MCP工具缓存自动刷新

## 分类与状态

- 分类：功能优化。
- 状态：已完成。

## 目标

避免 MCP Server 的工具变化后，Agent 长期依据旧缓存自动选择或调用已过期的工具定义。

## 实现

1. MCP 工具缓存有效期固定为 5 分钟。
2. Agent 任务选择已启用的指定 Server 或自动模式 Server 前，服务端会刷新过期缓存；刷新失败不阻断当前任务，仍可使用上次成功缓存。
3. 设置页“测试连接”继续立即刷新工具缓存。

## 验证

- `npm --prefix notus run test:skill-mcp`
- `node notus/tests/platform.test.js`
- `npm run lint:web`
- `npm run build:web`
- `git diff --check`
