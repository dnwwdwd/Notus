# Skill手动更新与ZIP覆盖导入

## 分类与状态

- 分类：功能优化。
- 状态：已完成。

## 目标

让 Notus 已通过 Git 安装的受管 Skill 可安全手动更新；ZIP 导入也可在用户明确确认后覆盖同名 Skill。

## 实现

1. 仅当前安装记录为 Git 且含仓库 URL 的受管 Skill 显示“更新”操作；更新始终由用户点击触发，不做后台检查或自动同步。
2. 更新请求重新拉取仓库 `main`，失败回退 `master`；新旧 `SKILL.md` 的 `name` 必须一致。
3. 替换使用 staging 和备份目录完成可回滚交换。克隆、校验、交换、索引或记录失败时保留旧版本和启停状态。
4. ZIP 导入弹窗提供默认关闭的“覆盖同名受管 Skill”选项；开启时才使用 `replace` 冲突策略。
5. 私有 Git 凭据不在本期设置页管理，因此手动更新仅支持可匿名拉取的 HTTPS 仓库。

## 验证

- `npm --prefix notus run test:skill-mcp`
- `node notus/tests/platform.test.js`
- `npm run lint:web`
- `npm run build:web`
- `git diff --check`
