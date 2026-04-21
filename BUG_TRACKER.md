# Notus Bug 台账

> 作用：记录每个 bug 的描述、影响范围、根因、修复方案、当前状态与验证结果。  
> 维护规则：每次发现 bug、开始修 bug、完成修复或验证失败时，都必须更新本文件。

## 状态约定

- `待定位`：已收到现象，尚未确认根因。
- `修复中`：已有明确方向，正在改代码。
- `已修复`：代码已调整，并通过本地验证。
- `已缓解`：问题不再阻断主流程，但仍有外部配置或后续验证项。
- `待验证`：需要真实环境、真实 API Key 或用户数据继续确认。

## 当前记录

| ID | 状态 | 问题 | 根因 / 发现 | 修复情况 | 验证 |
|----|------|------|-------------|----------|------|
| BUG-20260420-001 | 已修复 | 引导页模型下拉只能选固定模型，不能手填，也没有远端模型获取 | UI 只接本地 `modelCatalog` 固定数组；没有统一 `/models` 接口 | 新增 `/api/models`，优先拉远端 `/models`，失败静默回退内置候选；引导页和设置页都支持候选选择 + 手动输入 | `npm run lint`、`npm run build` 通过；`/api/models` 烟测返回远端模型 |
| BUG-20260420-002 | 已修复 | 引导页和侧边栏导入 Markdown 文件夹时失败，缺少可定位日志 | 同时存在 API body 默认 1MB 限制、索引阶段错误误报为导入失败、缺少结构化日志 | `/api/files/import` body 上限调到 50MB；导入拆分为保存/索引阶段；文件已保存但索引失败时返回告警而不是导入失败；新增日志追踪 | 导入 API 烟测不再返回 413 或 SQL logic error，能返回逐文件告警 |
| BUG-20260420-003 | 已修复 | 新建文件报 `SQL logic error` | `chunks_fts` 是普通 FTS5 表，但删除触发器使用了 contentless/external content 的特殊 delete 写法 | 将 `chunks_ad/chunks_au` 改为 `DELETE FROM chunks_fts WHERE rowid = old.id`；新建/保存/导入与索引解耦 | 新建与导入烟测不再出现 `SQL logic error` |
| BUG-20260420-004 | 已修复 | 缺少日志系统，错误无法追踪 | 只有零散 `console.error`，没有请求 ID、持久化日志或查看入口 | 新增 `lib/logger.js` JSONL 日志、`x-request-id`、`/api/logs` 查询接口、设置页日志查看页 | `/api/logs` 烟测可查询最近日志 |
| BUG-20260420-005 | 已修复 | 新建文件时用户不应需要输入 `.md` 后缀 | UI placeholder 暗示要输入 `.md`，后端虽已能自动补齐但界面不明确 | 新建文件弹窗改为只提示文件名，并注明系统自动补 `.md` | UI 文案已更新；API 烟测 `path=api-create-after-fts-fix` 自动生成 `.md` |
| BUG-20260420-006 | 已缓解 | 当前通义多模态 embedding 索引仍提示维度不匹配 | 当前保存的模型是 `tongyi-embedding-vision-plus`，真实返回 1152 维，但旧配置中保存为 1024 维 | 修正通义多模态请求体；修正模型目录维度为 1152；设置页保存 embedding 模型/维度变化时会清索引并重置 vec 表 | 烟测中 SQL 错误消失，剩余告警明确显示“期望 1024，实际 1152”；需要保存正确维度或切换 1024 维模型后重建 |
| BUG-20260420-007 | 已修复 | 导入大 Markdown 文件时出现 embedding batch size invalid，且导入弹窗将索引告警当成失败并撑爆布局 | `lib/embeddings.js` 未对文本向量请求分批，单文件 chunk 过多会超过供应商单次 20 条限制；侧边栏把导入配置、进度、结果混在一个弹窗中，且直接展示超长 warning 文本 | 为文本 embedding 增加通用批处理，单次请求自动拆分为不超过 20 条并校验返回数量；导入流程拆为“选择文件”和“导入结果”两段；结果页按成功/跳过/失败分组，索引告警改为弱提示并记录日志，失败项支持一键重试，长文本改为自动换行避免撑爆弹窗 | `npm run lint`、`npm run build` 通过；需用户在真实导入场景下再确认失败项重试体验 |
| BUG-20260420-008 | 已修复 | 打开部分 Markdown 文件时 Tiptap 报错 `The editor view is not available` | `pages/files/index.js` 在编辑器尚未挂载完成时直接访问 `editor.view.dom`，getter 会抛异常 | 新增安全 `getEditorRoot` helper，TOC 滚动同步、标题跳转和引用定位全部改为安全访问；`WysiwygEditor` 改为在下一帧再上抛 `onEditorReady`，卸载时回传 `null`，避免父层拿到未挂载完成的 editor view | `npm run lint`、`npm run build` 通过；需用户用此前报错的 Markdown 文件再做一次页面烟测 |
