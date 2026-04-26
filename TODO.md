# Notus TODO & Bug Tracker

> 更新时间：2026-04-26

## 当前口径

- 文件页是主 Markdown 编辑入口。
- 知识库页默认是问答页；只有选中文件时才显示左侧文章编辑器。
- 知识库页和创作页都支持手动指定参考来源。
- 创作页点击侧边栏文件时，应在当前页基于对应文章进入创作，不跳回文件页。
- 快捷键统一在设置页维护，界面内默认不直接展示提示。

---

## Bug 台账

### P0 — 数据丢失风险

- [ ] **Canvas 无自动保存**
  - 文件: `notus/pages/canvas.js`
  - 问题: `handleSaveArticle()` 仅手动触发，意外关闭页面会丢失所有块级编辑内容
  - 修复: 添加 30s 自动保存 + `beforeunload` 拦截

- [ ] **Setup Step 3 竞态条件**
  - 文件: `notus/pages/setup.js`
  - 问题: `runInitialSetupPipeline()` 在网络延迟时可能被重复触发，导致重复导入
  - 修复: 使用 `useRef` 原子标志或 `isMounted` 保护

### P1 — 核心流程问题

- [ ] **Settings Embedding API Key 保存后被清空**
  - 文件: `notus/components/Settings/SettingsScreen.js`（`handleSave` 函数，第 292 行）
  - 问题: 保存成功后将 `embApiKey` 重置为空字符串，用户后续修改其他配置时需重新输入完整 Key
  - 修复: 保存成功后不清空 Key 值，仅在 placeholder 提示"已保存，留空不修改"

- [ ] **Files 重试时未清除损坏缓存**
  - 文件: `notus/pages/files/index.js`（error retry 逻辑，第 373 行）
  - 问题: 文件加载失败后重试时，`cachedContent` 未被清空，若上次返回损坏数据则重试仍读取损坏缓存
  - 修复: 重试前调用 `setCachedContent(fileId, undefined)`

- [ ] **Files 保存状态竞态**
  - 文件: `notus/pages/files/index.js`（`handleSave` 函数，第 278 行）
  - 问题: `setSaveState('saving')` 在 `await` 前同步执行，`persistedContentRef` 是异步更新的，极短时间内再次修改可能显示"已保存"但内容实际已脏
  - 修复: 在 `await fetch(...)` resolved 之后再更新 `persistedContentRef.current`

### P2 — 体验缺陷

- [ ] **Sidebar 搜索无 debounce**
  - 文件: `notus/components/Layout/Sidebar.js`（第 23 行 `filterTree`）
  - 问题: `filterTree()` 每次按键都递归遍历全树，文件数 > 1000 时明显卡顿
  - 修复: 使用 `useDeferredValue` 或 300ms debounce

- [ ] **Canvas 块拖拽排序无防抖**
  - 文件: `notus/pages/canvas.js`
  - 问题: 拖拽后立即标脏，若 AI 同时修改块内容可能导致顺序与内容错位
  - 修复: 添加防抖（500ms），拖拽稳定后再触发 dirty 标记

- [ ] **Setup Step 1 无必填字段标识**
  - 文件: `notus/pages/setup.js`
  - 问题: 进入 Step 1 时没有明确标注哪些字段必填，只有点击"下一步"时才报错
  - 修复: 在必填字段标签旁加 `*` 标识，blur 时做即时验证

### P3 — 待验证

- [ ] **sqlite-vec aarch64 预编译验证** — 懒猫微服为 ARM 架构，需在真实设备验证 `.so` 可正常加载
- [ ] **`.lpk` 实机打包与部署验证** — `lzc/build-package.sh` 脚本已写，未在真实懒猫设备上运行过
- [ ] **Embedding API Key 真实实测** — 阿里千问、字节豆包、OpenAI 均需用真实密钥验证，尤其是多模态路径
- [ ] **真实 OIDC 登录** — 当前 `login.js` 是演示自动跳转，需接入懒猫 OIDC 单点登录

---

## 文档同步原则

- 若页面行为与旧需求不一致，以当前页面实现为准。
- 更新 PDD / PRD / PROGRESS 时，要同步清理过时表述，不保留并列口径。
