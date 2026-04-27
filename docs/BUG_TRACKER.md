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
| BUG-20260427-004 | 已修复 | 完成初始化引导后，在“未导入文件且未配置 LLM/Embedding”场景下出现通用前端异常页 | 新增的站内未保存守卫通过 `routeChangeStart + throw Error` 拦截导航；这类做法在 Next.js 客户端路由切换中存在冒泡为通用 `client-side exception` 的风险，尤其是在引导完成后的立即跳转链路里更容易放大 | 已收紧未保存守卫：移除全局 `routeChangeStart` 抛错式拦截，仅保留浏览器 `beforeunload` 兜底与页面中显式可控的导航拦截；同时把文件页“AI 创作”按钮补接到同一套显式守卫，避免回退行为缺口 | `npm run lint`、`npm run build` 通过；建议用户在“未配置模型、未导入文件”的真实引导完成路径再复测一次 `/setup -> /files` |
| BUG-20260427-001 | 已修复 | 文件页大纲误把正文或代码块中的伪标题显示为可跳转标题 | `pages/files/index.js` 原先通过简单正则扫描 Markdown `#` 行生成 TOC，没有区分真实标题节点与代码块/普通文本；点击后依赖渲染 DOM 标题索引，导致列表和实际可跳转节点不一致 | 已改为按编辑器真实渲染出的 `h1/h2/h3` 标题节点生成 TOC，并继续用同一批真实标题节点同步滚动高亮与跳转，避免伪标题进入大纲 | `npm run lint`、`npm run build` 通过；仍建议在包含代码块、引用与长文档的真实笔记中继续回归点击跳转体验 |
| BUG-20260427-002 | 已修复 | 文档或创作内容未保存时，切换文件/页面仍使用浏览器原生确认框，且离开策略不统一 | `/files` `/knowledge` `/canvas` 均直接使用 `window.confirm` 和 `beforeunload`，无法提供“保存并继续 / 丢弃 / 取消”的一致站内体验 | 已新增共享未保存弹窗与 guard，站内切换文件、顶部导航、引用跳转与创作页切换统一改为“保存并继续 / 不保存离开 / 取消”；浏览器刷新/关闭仍保留 `beforeunload` 兜底 | `npm run lint`、`npm run build` 通过；仍建议在浏览器里继续回归文件切换、顶部导航、知识库引用跳转和创作页离开流程 |
| BUG-20260427-003 | 已修复 | 点击保存时偶发 `Converting circular structure to JSON` 报错 | 当前页面级保存函数既支持直接传入内容，也被按钮 `onClick` 直接引用；点击按钮时 React 事件对象会被当作待保存内容进入 `JSON.stringify`，从而序列化 DOM/React Fiber 循环引用失败 | 已统一保存函数返回值与调用签名，顶部保存按钮改为无参包装调用，不再把 React 事件对象透传给保存请求体 | `npm run lint`、`npm run build` 通过；需在浏览器中继续复核顶部保存按钮、快捷键保存与创作页自动保存场景 |
| BUG-20260426-001 | 已修复 | 懒猫部署后 Next.js 已启动，但健康检查访问 `127.0.0.1:3000/api/health` 失败 | 最终根因是打包阶段误用了本机 macOS 构建产物：`lzc-dist/notus/node_modules/better-sqlite3/build/Release/better_sqlite3.node` 被确认是 `Mach-O 64-bit bundle arm64`，容器内 Linux 在 `notus/lib/db.js:initDb()` 初始化数据库时加载原生模块失败，`/api/health` 因 `runtime.init.failed` 返回 503；同时 `lzc-dist/notus/server.js` 也会读取 `process.env.HOSTNAME` 作为监听地址，需要显式覆盖为 `0.0.0.0` | 一并修复两处：`lzc/run.sh` 显式导出 `HOSTNAME=0.0.0.0` 与 `HOST=0.0.0.0`；`lzc/build-package.sh` 改回强制使用 Linux amd64 的 Node 20 容器镜像重新构建，避免把 Darwin 原生模块打进 `.lpk` | 已完成 `sh -n lzc/run.sh`、`sh -n lzc/build-package.sh`；重新打包后需确认产物中的 `better_sqlite3.node` 为 Linux ELF，并在懒猫环境复测启动与健康检查 |
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
| BUG-20260424-011 | 已修复 | 打开文件后即使没有手动修改，编辑器仍会在短时间后自动保存 | `WysiwygEditor` 在外部 `value` 同步到 Tiptap 时，程序性 `setContent` 会触发页面层 `onChange`；`/files` 与 `/knowledge` 的自动保存逻辑又没有判断内容是否真的变化，并且变更处理函数刻意忽略了依赖，存在旧文件闭包被保存定时器复用的风险 | 为编辑器增加外部同步保护，屏蔽 `setContent` 触发的伪更新；`/files` 与 `/knowledge` 新增“当前内容 / 已持久化内容”双 ref 比对，只有真实变更才进入自动保存；切换文件和卸载时清理旧定时器，避免旧闭包继续提交保存 | `npm run lint`、`npm run build` 通过；需在浏览器中再次打开未修改文件确认不再出现“已保存并索引到知识库”提示 |
| BUG-20260424-012 | 已修复 | 文档编辑必须改为纯手动保存，不能再使用定时自动保存 | `/files` 与 `/knowledge` 仍保留“内容变化后 1.2 秒自动保存”的产品策略；同时 `/canvas` 的 AI 应用修改会在已有 `file_id` 时通过 `/api/agent/apply` 直接写回文件，绕过显式保存 | 删除 `/files` 与 `/knowledge` 的自动保存定时器，仅保留脏状态；顶部栏新增统一“保存”按钮并保留 `Mod+S`；为切文件、搜索跳转、路由切换和刷新页补充未保存确认；`/api/agent/apply` 改为只返回应用后的内存结果，不再直接写文件，创作页仅在“保存文章”时落盘 | `npm run lint`、`npm run build` 通过；开发服务保活后需在浏览器中复测文件页、知识库页和创作页的手动保存体验 |
| BUG-20260424-013 | 已修复 | 模型配置 UI、知识库/创作页模型来源、AI 输入框和侧边文件树体验与设计要求不一致 | 设置页与引导页各自维护一套旧式 LLM 表单，且 profile 只存在浏览器本地；知识库与创作页的模型下拉是写死数组；输入框未对齐设计稿；侧边文件树每次刷新都会先回到空态/加载态；本轮回归又暴露出 Embedding 配置仍要求手填 provider / dim，且提示文案与按钮布局不符合预期 | 新增服务端持久化 `llm_configs` 与增删改查接口；设置页和引导页改为 LLM 卡片 + 测试后方可保存的弹窗流；知识库页和创作页改为从 LLM 配置读取模型并随请求传 `llm_config_id`；共享输入框重做为 Claude 风格空态/吸底双形态，保留模型菜单、加号菜单、拖拽/粘贴附件与停止生成；文件树增加 sessionStorage 缓存与后台刷新；Embedding 配置去掉用户手填 provider / dim，改为测试时自动识别；知识库与创作页的参考来源/风格来源下拉改为显示已选状态并支持再次点击取消选择 | `npm run lint`、`npm run build` 通过；开发服务仍可访问，`http://127.0.0.1:3001` 返回 `HTTP/1.1 200 OK` |
