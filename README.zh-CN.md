[**English**](README.md) **| 简体中文**

<p align="center"><img src="notus/public/notus-logo.svg" width="112" alt="Notus 标志" /></p>

<p align="center">本地优先的 Markdown 知识工作区，内置 AI Agent，面向写作、调研与可审阅文件修改。</p>

---

## 目录

- [是什么](#%E6%98%AF%E4%BB%80%E4%B9%88)
- [核心能力](#%E6%A0%B8%E5%BF%83%E8%83%BD%E5%8A%9B)
- [写入控制与任务安全](#%E5%86%99%E5%85%A5%E6%8E%A7%E5%88%B6%E4%B8%8E%E4%BB%BB%E5%8A%A1%E5%AE%89%E5%85%A8)
- [数据与隐私](#%E6%95%B0%E6%8D%AE%E4%B8%8E%E9%9A%90%E7%A7%81)
- [运行平台](#%E8%BF%90%E8%A1%8C%E5%B9%B3%E5%8F%B0)
- [本地运行](#%E6%9C%AC%E5%9C%B0%E8%BF%90%E8%A1%8C)
- [构建与打包](#%E6%9E%84%E5%BB%BA%E4%B8%8E%E6%89%93%E5%8C%85)
- [项目结构](#%E9%A1%B9%E7%9B%AE%E7%BB%93%E6%9E%84)
- [链接](#%E9%93%BE%E6%8E%A5)

---

## 是什么

Notus 以 Markdown 文件为工作区中心。你可以编辑笔记、检索自己的资料、让 AI Agent 调研或写作，并在内容写入笔记前查看每一项文件修改。

---

## 核心能力

### 编辑与管理 Markdown

- 富文本编辑器，支持 Markdown 双向转换、代码高亮、表格、大纲、文件搜索。
- 文件保存在本地工作区，改动增量进入知识库索引。
- 可浏览持久化文件树，按标题或路径搜索笔记，从搜索结果或修改预览直接打开文件。
- 编辑器与 AI 面板的分栏宽度、开关状态、当前文件和快捷键均保存在本地，下次打开自动恢复。
- 可选将笔记标题同步到 Markdown 一级标题与文件名；文件名冲突时保留已保存正文并提示。
- 粘贴或插入图片时，可选写入本地资源目录，或上传到阿里云 OSS、腾讯云 COS、Cloudflare R2。
- 导入文档后可进入知识库；Agent 对话也支持解析附件、图片和明确粘贴的 URL。

### 检索知识库

- 混合检索：向量搜索 + FTS5 关键词 + 标题路径匹配 + 分段聚合 + 条件重排。
- 回答附带可追溯引用，方便回到原始笔记核对。
- Agent 按任务需要读取文件、分析目录或检索知识库，不把编辑器当前打开的文件当作默认上下文。
- 文件和目录 Mention 可限定检索范围；目录分批分析，不会因一个引用读取整个工作区。
- 证据不足时，任务自动规划多条检索查询；同一任务内重复调研复用缓存。笔记、附件、URL 与联网搜索始终保留来源边界。

### 在对话中使用文档、图片和 URL

- 支持 PDF、DOCX、Markdown、纯文本和可读取网页作为对话材料；附件与图片输入分开处理。
- 支持粘贴或上传图片进行视觉分析；图片摘要和受控引用保留在同一对话的后续上下文中。
- 需要把对话图片整理进笔记时，Agent 生成文字和图片 diff，校验目标文件版本，应用时按图床设置写入图片。
- 历史对话可按标题或消息内容搜索、导出；重新打开已保存对话时，可恢复待处理任务和此前工具记录。

### AI Agent 写作与调研

- 无需打开文件即可开始对话；输入 `@` 可引用文件、目录或已启用的 Skill。
- Agent 任务通过持久化队列在后台执行，保留 SSE 更新、可恢复 checkpoint、工具记录和对话级任务历史。
- 新建或切换对话不会取消原任务；回到原对话后，状态、工具记录和中断入口均恢复。
- 任务需要信息时主动提问；涉及文件写入时生成 Markdown diff，支持自动应用、手动确认或回滚。
- Agent 可在受控预览中创建、修改、重命名和移动 Markdown 文件或目录；当前不提供删除工具。
- 改写消息或重试 AI 回复从原消息位置继续，不产生重复对话分支。
- 模型请求失败或等待用户回答时，可从已保存 checkpoint 继续，无需重新开始。
- 联网搜索按任务单独开启，支持 Firecrawl、Tavily、Exa、智谱 Web Search。
- 模型下拉支持按模型名、Provider 或配置名搜索；一项任务可结合文本、附件、图片、本地笔记和联网调研。

### 扩展 Agent

- Skill 可从本地目录、HTTPS Git 仓库、ZIP 压缩包或 Agent 草稿安装，可在设置中启停、更新和重新扫描；已启用 Skill 可从 `@` 菜单选择。
- 所有运行环境支持 Streamable HTTP MCP；Electron 桌面端还支持 stdio MCP。Header 和环境变量以密钥保存，不出现在列表、工具回执或日志中。
- Notus 也可作为 Streamable HTTP MCP Server，向外部 Agent 提供选定的笔记读写工具；写入可设为自动应用或等待 diff 确认。
- `soul.md`、`memory.md`、`style.md` 保存长期偏好、写作风格和人格参考，均可查看历史并回滚。
- 外供 MCP Token 与 Server 配置分开管理；Token 只暴露用户启用的工具，数据库只保存 Token 哈希；写入操作还会校验笔记当前哈希。

---

## 写入控制与任务安全

- 可为符合条件的写入选择自动应用，也可让每次文件修改都等待人工查看。
- 每项写入预览在应用前比对目标文件当前版本；文件已变更时回到预览，不静默覆盖。
- Agent 的提问以内嵌卡片出现；回答后恢复同一项任务。
- 待确认、待回答、可恢复失败和已中断任务均保留在对话历史中。
- 任务事件先持久化再通过 SSE 推送，刷新页面、浏览器断线或应用重启后仍可恢复工具记录和正式回复。
- 发送前的任务输入保存在浏览器 IndexedDB，文本、Mention、附件和图片元数据均可在浏览器中恢复。

---

## 数据与隐私

- Markdown 文件是唯一真相来源；SQLite 在本地保存索引、对话、预览和任务状态。
- 编辑和本地知识库检索不需要 Notus 托管账号。
- 模型调用、联网搜索、对象存储和 MCP 连接均为可选能力，使用你自行配置的服务商与凭据。
- 密钥不写入 API 响应、Agent 事件、工具回执或日志。
- Skill 文件、MCP 返回、网页和附件均按不可信任务材料处理，不能扩大文件权限或覆盖 Agent 安全规则。

---

## 运行平台

| 运行方式 | 说明 |
| --- | --- |
| Web | Next.js standalone 产物 |
| 桌面端 | macOS 与 Windows 的 Electron 应用 |
| 懒猫 | 保留兼容运行能力 |

Web 与桌面端共用同一份 Next.js standalone 产物。stdio MCP 等平台能力由平台层决定，不在业务界面中依赖运行环境判断。

---

## 本地运行

### 环境要求

- Node.js 20.19.x
- npm

### 启动开发环境

```bash
npm install

# 启动 Web 开发服务
npm run dev:web

# Electron 连接已运行的 http://127.0.0.1:3000
npm run dev:desktop

# 同时启动 Web 与 Electron
npm run dev:desktop:all
```

需要配置模型或搜索服务时，将 `notus/.env.local.example` 复制为 `notus/.env.local` 后填写对应参数；支持的配置也可在应用设置中管理。

---

## 构建与打包

```bash
# 检查并构建 Web 应用
npm run lint:web
npm run build:web

# 运行仓库测试
npm run test:all

# 导出 Web standalone 目录
npm run dist:web

# 准备或打包 Electron
npm run build:desktop
npm run dist:desktop

# 指定桌面端安装包
npm run dist:desktop:mac:x64
npm run dist:desktop:mac:arm64
npm run dist:desktop:win:x64

# 打包懒猫安装包
npm run dist:lpk
```

| 产物 | 输出路径 |
| --- | --- |
| Web standalone | `web-dist/` |
| Electron 安装包 | `desktop/dist/` |
| 懒猫安装包 | 仓库根目录 |

---

## 项目结构

```text
notus/     Next.js 页面、组件、API Routes 与核心业务库
desktop/   Electron 主进程、预加载桥接与打包脚本
docs/      产品、技术与业务流程文档
```

---

## 链接

- 官网：[notus.hejiajun.com](https://notus.hejiajun.com/)
- GitHub：[github.com/dnwwdwd/Notus](https://github.com/dnwwdwd/Notus)
- 许可证：[Apache-2.0](LICENSE)

欢迎提交 Issue 和 Pull Request。提交前请阅读 `AGENTS.md`，并遵循仓库中的代码、测试与文档约定。
