# 图床与Skill设置交互收敛

## 分类与状态

- 分类：用户体验优化。
- 状态：已完成。

## 目标

让图床配置与搜索配置使用同一套服务商 Tab 交互；收敛 Skill 设置列表和 ZIP 导入界面中的非必要信息。

## 实现

1. 图床服务商 Tab 复用搜索配置的容器、选中态、尺寸和颜色规则。首次进入时优先展示个性化页当前选中的 OSS、COS 或 R2；本地存储时展示首项阿里云 OSS。
2. Skill 列表仅保留名称、描述和启停开关，不展示来源、管理归属或“有效”等状态文本。
3. ZIP 导入弹窗改为整块拖放或点击上传区域。未选择文件时只显示上传动作和 `100 MiB` 上限；已选择时在同一位置显示文件名和大小。

## 验证

- `node notus/tests/ui-bug-regressions.test.js`
- `npm --prefix notus run test:skill-mcp`
- `npm run lint:web`
- `git diff --check`
