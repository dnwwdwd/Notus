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
| BUG-20260425-001 | 已修复 | Embedding 设置页与 LLM 配置页未强制“先测试连通性再保存” | Embedding 保存条件只依赖已识别维度，命中已知模型时可绕过真实测试；LLM 主要依赖前端弹窗状态，服务端接口未校验测试结果，编辑既有配置时也可直接保存 | 新增测试凭证校验链路：`/api/settings/test` 成功后签发一次性 `verification_token`，Embedding 设置页、初始化引导页与 LLM 配置弹窗都必须在当前配置测试通过后才能提交；服务端保存接口同步校验，防止绕过前端直接保存；“设为默认”保留为无需重复测试的轻量操作 | `npm run lint` 通过；本地烟测确认未携带测试凭证时，`PUT /api/settings` 与 `POST /api/settings/llm-configs` 都返回 `CONNECTIVITY_TEST_REQUIRED`；完整正向保存仍需浏览器中使用真实 API Key 复测 |
| BUG-20260420-001 | 已修复 | 引导页模型下拉只能选固定模型，不能手填，也没有远端模型获取 | UI 只接本地 `modelCatalog` 固定数组；没有统一 `/models` 接口 | 新增 `/api/models`，优先拉远端 `/models`，失败静默回退内置候选；引导页和设置页都支持候选选择 + 手动输入 | `npm run lint`、`npm run build` 通过；`/api/models` 烟测返回远端模型 |
| BUG-20260420-002 | 已修复 | 引导页和侧边栏导入 Markdown 文件夹时失败，缺少可定位日志 | 同时存在 API body 默认 1MB 限制、索引阶段错误误报为导入失败、缺少结构化日志 | `/api/files/import` body 上限调到 50MB；导入拆分为保存/索引阶段；文件已保存但索引失败时返回告警而不是导入失败；新增日志追踪 | 导入 API 烟测不再返回 413 或 SQL logic error，能返回逐文件告警 |
| BUG-20260420-003 | 已修复 | 新建文件报 `SQL logic error` | `chunks_fts` 是普通 FTS5 表，但删除触发器使用了 contentless/external content 的特殊 delete 写法 | 将 `chunks_ad/chunks_au` 改为 `DELETE FROM chunks_fts WHERE rowid = old.id`；新建/保存/导入与索引解耦 | 新建与导入烟测不再出现 `SQL logic error` |
| BUG-20260420-004 | 已修复 | 缺少日志系统，错误无法追踪 | 只有零散 `console.error`，没有请求 ID、持久化日志或查看入口 | 新增 `lib/logger.js` JSONL 日志、`x-request-id`、`/api/logs` 查询接口、设置页日志查看页 | `/api/logs` 烟测可查询最近日志 |
| BUG-20260420-005 | 已修复 | 新建文件时用户不应需要输入 `.md` 后缀 | UI placeholder 暗示要输入 `.md`，后端虽已能自动补齐但界面不明确 | 新建文件弹窗改为只提示文件名，并注明系统自动补 `.md` | UI 文案已更新；API 烟测 `path=api-create-after-fts-fix` 自动生成 `.md` |
| BUG-20260420-006 | 已缓解 | 当前通义多模态 embedding 索引仍提示维度不匹配 | 当前保存的模型是 `tongyi-embedding-vision-plus`，真实返回 1152 维，但旧配置中保存为 1024 维 | 修正通义多模态请求体；修正模型目录维度为 1152；设置页保存 embedding 模型/维度变化时会清索引并重置 vec 表 | 烟测中 SQL 错误消失，剩余告警明确显示“期望 1024，实际 1152”；需要保存正确维度或切换 1024 维模型后重建 |
| BUG-20260420-007 | 已修复 | 导入大 Markdown 文件时出现 embedding batch size invalid，且导入弹窗将索引告警当成失败并撑爆布局 | `lib/embeddings.js` 未对文本向量请求分批，单文件 chunk 过多会超过供应商单次 20 条限制；侧边栏把导入配置、进度、结果混在一个弹窗中，且直接展示超长 warning 文本 | 为文本 embedding 增加通用批处理，单次请求自动拆分为不超过 20 条并校验返回数量；导入流程拆为“选择文件”和“导入结果”两段；结果页按成功/跳过/失败分组，索引告警改为弱提示并记录日志，失败项支持一键重试，长文本改为自动换行避免撑爆弹窗 | `npm run lint`、`npm run build` 通过；需用户在真实导入场景下再确认失败项重试体验 |
| BUG-20260420-008 | 已修复 | 打开部分 Markdown 文件时 Tiptap 报错 `The editor view is not available` | `pages/files/index.js` 在编辑器尚未挂载完成时直接访问 `editor.view.dom`，getter 会抛异常 | 新增安全 `getEditorRoot` helper，TOC 滚动同步、标题跳转和引用定位全部改为安全访问；`WysiwygEditor` 改为在下一帧再上抛 `onEditorReady`，卸载时回传 `null`，避免父层拿到未挂载完成的 editor view | `npm run lint`、`npm run build` 通过；需用户用此前报错的 Markdown 文件再做一次页面烟测 |
| BUG-20260421-009 | 已修复 | 本地引导页索引大文档时，千问 embedding 会报 `batch size invalid`，不同模型的批量上限变化时也容易再次失败 | 之前的固定批次大小仍可能超过供应商真实限制；千问接口本地实测单次最多 10 条，而不同模型的实际限制并不稳定 | 为 `qwen/aliyun` 预设更保守的初始批次；当接口返回批量相关错误时，自动把当前批次二分重试，最小降到单条请求后再决定失败 | `npm run lint`、`npm run build` 通过；本地 `/api/index/rebuild` 已从失败恢复为 `indexed=1, failed=0` |
| BUG-20260421-010 | 已修复 | 本地 `/setup` 页面会反复显示“正在检查初始化状态…”，有时还会回到第一步 | 引导页第 3 步在内部调用 `refreshStatus()` 时触发了全局 `AppStatusGate` 的 loading 态，导致页面被卸载再挂载，形成循环；同时当前步骤只保存在组件内存里，开发环境重载后会回到初始步 | 将引导页内部状态刷新改为静默刷新，不再触发全局路由守卫；状态接口请求改为 `no-store`；为引导页增加基于 sessionStorage 与后端状态的步骤恢复逻辑 | `npm run lint`、`npm run build` 通过；重启开发服务后，`/setup` 不再持续卡在“检查初始化状态” |
| BUG-20260422-011 | 已修复 | 重建索引和切换 embedding 配置时会先清空旧索引，失败后知识库会出现整段不可用窗口 | 旧实现只有一套索引表；全量重建和 embedding 配置切换都会直接清空当前索引，再尝试重建 | 已改为 multi-generation 索引：主库新增 `index_generations / generation_file_results / generation_dirty_files / file_index_status`，每个 generation 使用独立索引库；重建和 embedding 配置变更都先构建新 generation，成功后再原子切换 `active_generation_id`；旧 active generation 在 rebuild 期间继续提供检索与增量更新 | `npm run lint`、`npm run build` 通过；代码路径已不再调用 `clearIndex()` 清空在线索引 |
| BUG-20260422-012 | 已修复 | 文件保存、文件监听、后台重试都会触发整文件重建和整文件向量化，缺少单文件串行化与去重，容易重复做重活 | 保存接口、watcher 和重试逻辑都直接调用同步索引函数，没有统一协调，也没有按文件串行化 | 新增进程内 `IndexCoordinator`：保存 / watcher / retry / agent apply / 导入 / 移动 / 重命名统一入队；同一路径只保留最新内容哈希；保存接口改为“写盘成功即返回”，索引在后台执行；watcher 改成只入队，不再直接跑索引 | `npm run lint`、`npm run build` 通过；保存接口已返回 `save_status='saved'` 与 `index_state='queued'`，运行时重试改为只队列 active generation 的失败文件 |
| BUG-20260422-013 | 已修复 | 当前索引状态模型把“处理中 / 仅向量失败但 FTS 可用 / 完全失败”混在一起，前端状态和实际检索能力不一致 | 旧模型只有 `files.indexed/index_error` 两个字段，无法表达 queued/running/degraded，导致状态展示和真实检索能力经常不一致 | 新增 `file_index_status` 作为 active generation 的真实状态源，状态拆分为 `queued/running/ready/degraded/failed`；`files.indexed/index_error` 仅保留为派生兼容字段；`/api/index/status` 返回 active / rebuild generation 汇总；`hybridSearch()` 只读 active generation，并在 query embedding 失败时显式返回 `retrieval_mode=fts_fallback` | `npm run lint`、`npm run build` 通过；设置页、索引页和文件相关接口已接入新状态字段 |
| BUG-20260423-014 | 已修复 | 知识库页“参考来源”和创作页“风格来源”界面已出现，但手动来源约束、实际引用回传和风格采样策略仍不完整 | 原实现把“用户指定来源”“模型实际使用来源”“风格样本”混在一起；创作 Agent 要等模型自己调用工具才会拿到样本，且工具层生成没有稳定看到风格提示；创作页也没有把实际来源落到消息里展示 | 创作 Agent 改为预采样风格样本：组合代表性段落采样与当前请求相关检索，筛掉过短/结构性/Markdown 噪声较高的片段，并先做五维风格分析后注入 system prompt；工具返回新样本后会重新合并样本并刷新 prompt，`generateOperation()` 也改为直接吃到风格画像与样本。知识库和创作页都新增手动模式空选择拦截；创作页补齐 `citation_kind/file_id/line_start/line_end` 等字段并展示可点击来源卡片，手动风格来源会标记为“风格” | `npm run lint`、`npm run build` 通过；知识库页检索状态数改为使用真实 chunk 数；`knowledge.js` 当前已无自动保存 timer 残留，保持手动保存逻辑 |
| BUG-20260424-011 | 已修复 | 打开文件后即使没有手动修改，编辑器仍会在短时间后自动保存 | `WysiwygEditor` 在外部 `value` 同步到 Tiptap 时，程序性 `setContent` 会触发页面层 `onChange`；`/files` 与 `/knowledge` 的自动保存逻辑又没有判断内容是否真的变化，并且变更处理函数刻意忽略了依赖，存在旧文件闭包被保存定时器复用的风险 | 为编辑器增加外部同步保护，屏蔽 `setContent` 触发的伪更新；`/files` 与 `/knowledge` 新增“当前内容 / 已持久化内容”双 ref 比对，只有真实变更才进入自动保存；切换文件和卸载时清理旧定时器，避免旧闭包继续提交保存 | `npm run lint`、`npm run build` 通过；需在浏览器中再次打开未修改文件确认不再出现“已保存并索引到知识库”提示 |
| BUG-20260424-012 | 已修复 | 文档编辑必须改为纯手动保存，不能再使用定时自动保存 | `/files` 与 `/knowledge` 仍保留“内容变化后 1.2 秒自动保存”的产品策略；同时 `/canvas` 的 AI 应用修改会在已有 `file_id` 时通过 `/api/agent/apply` 直接写回文件，绕过显式保存 | 删除 `/files` 与 `/knowledge` 的自动保存定时器，仅保留脏状态；顶部栏新增统一“保存”按钮并保留 `Mod+S`；为切文件、搜索跳转、路由切换和刷新页补充未保存确认；`/api/agent/apply` 改为只返回应用后的内存结果，不再直接写文件，创作页仅在“保存文章”时落盘 | `npm run lint`、`npm run build` 通过；开发服务保活后需在浏览器中复测文件页、知识库页和创作页的手动保存体验 |
| BUG-20260424-013 | 已修复 | 模型配置 UI、知识库/创作页模型来源、AI 输入框和侧边文件树体验与设计要求不一致 | 设置页与引导页各自维护一套旧式 LLM 表单，且 profile 只存在浏览器本地；知识库与创作页的模型下拉是写死数组；输入框未对齐设计稿；侧边文件树每次刷新都会先回到空态/加载态；本轮回归又暴露出 Embedding 配置仍要求手填 provider / dim，且提示文案与按钮布局不符合预期 | 新增服务端持久化 `llm_configs` 与增删改查接口；设置页和引导页改为 LLM 卡片 + 测试后方可保存的弹窗流；知识库页和创作页改为从 LLM 配置读取模型并随请求传 `llm_config_id`；共享输入框重做为 Claude 风格空态/吸底双形态，保留模型菜单、加号菜单、拖拽/粘贴附件与停止生成；文件树增加 sessionStorage 缓存与后台刷新；Embedding 配置去掉用户手填 provider / dim，改为测试时自动识别；知识库与创作页的参考来源/风格来源下拉改为显示已选状态并支持再次点击取消选择 | `npm run lint`、`npm run build` 通过；开发服务仍可访问，`http://127.0.0.1:3001` 返回 `HTTP/1.1 200 OK` |
