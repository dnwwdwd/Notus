# 图床配置改用服务商标签页并优先阿里云OSS

## 分类与状态

- 分类：用户体验优化。
- 状态：已完成。

## 目标

将图床配置页从三套表单纵向同时展示改为服务商 Tab，缩短配置页面并让阿里云 OSS 成为默认首项；同时将 LPK 版本升级一个补丁版本。

## 实现

1. 图床页使用共享 `SegmentedTabs` 在阿里云 OSS、腾讯云 COS、Cloudflare R2 之间切换，阿里云 OSS 排在首位并作为初始选中项。
2. 每次只渲染当前服务商的参数表单。各图床原有独立保存、密钥脱敏、当前上传位置保护和 API 数据模型保持不变。
3. 根项目、Web 应用和 `package.yml` 的版本统一从 `0.1.9` 升至 `0.1.10`，随后重新生成 LPK。

## 验证

- `node notus/tests/ui-bug-regressions.test.js`
- `npm --prefix notus run test:object-storage`
- `npm run lint:web`
- `npm run build:web`
- `npm run dist:lpk`
