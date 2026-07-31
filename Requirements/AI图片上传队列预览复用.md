# AI图片上传队列预览复用

## 分类

用户体验优化。

## 交付

- AI 输入区中待发送图片的 chip 可点击预览；解析附件维持原有文件信息展示和移除行为。
- 预览复用笔记编辑器已有的全屏图片预览组件，统一使用页面根节点 portal、顶栏覆盖层、图片名称、计数、左右切换、Esc 关闭和点击遮罩关闭。
- 同一预览内只遍历当前上传队列中的图片，保持用户选择顺序；移除正在预览的图片或清空发送队列时关闭预览，并释放本地对象 URL。
- 编辑器文档图片继续使用同一共享组件，避免两套预览样式和键盘行为分叉。

## 验证

- `node notus/tests/editor-image-preview-support.test.js`
- `node notus/tests/ui-bug-regressions.test.js`
- `npm --prefix notus run lint`
- `npm run build:web`

## 状态

已完成。
