# SkillZIP导入入口与安装反馈

## 分类与状态

- 分类：功能需求 / 用户体验优化。
- 状态：已完成。

## 目标

将既有的 Skill ZIP 安装服务接入设置页，使用户无需调用接口即可选择或拖入 ZIP 压缩包安装一个或多个 Skill，并在上传前后获得明确反馈。

## 实现

1. Skill 设置页右上操作栏新增“导入 ZIP”，与“从 Git 安装”和“重新扫描”使用同一操作层级，窄宽度下自动换行。
2. ZIP 弹窗支持拖放和文件选择，只接受 `.zip` 文件；客户端提前提示 100 MiB 上限，服务端仍保留同一限制与全部安全校验。
3. 已选择文件显示名称和大小；提交时使用 `FormData` 调用既有 `POST /api/skills/install/zip`，成功后刷新列表并提示导入数量。
4. 弹窗展示路径、符号链接、文件数量和解压大小校验的边界。安装失败直接展示服务端的受控错误信息，不暴露临时目录或底层异常。

## 验证

- `npm --prefix notus run test:skill-mcp` 覆盖 ZIP 内有效 Skill 的真实安装。
- `node notus/tests/ui-bug-regressions.test.js` 覆盖 ZIP 导入入口、上传请求和文件约束。
- `npm run lint:web`、`npm run build:web` 通过。
