# Notus

> 一款支持 Web 与 Electron 桌面端的本地优先 AI 笔记应用，集文档编辑、知识库与 AI 创作于一体，完全开源，数据完全存储在本地。

![19a52fb571013aff9b36ff3e59f9616f](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/19a52fb571013aff9b36ff3e59f9616f.png)

## 为什么选择 Notus

Notus 的功能定位对标 NotebookLM 和 YouMind：把文档编辑、知识库问答与 AI 写作整合到一个工具里。但与它们不同的是：

- **完全开源、免费**：所有代码公开，欢迎 PR 和二次开发
- **数据完全本地化**：不依赖云端存储,无需担心数据泄露和隐私问题
- **多端支持**：Web、Electron 桌面端（macOS / Windows），并保留对懒猫运行时的兼容能力

![image-20260502184107035](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502184107035.png)
![image-20260502184129983](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502184129983.png)
![image-20260502184337281](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502184337281.png)
![image-20260502184558547](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502184558547.png)
![image-20260502184507823](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502184507823.png)
![image-20260502184528722](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502184528722.png)

## 核心功能

### 📝 文档编辑

Typora 拥有的功能 Notus 基本都有，可以彻底告别 Typora。

- **原生 Markdown 编辑器**：所见即所得，告别双栏预览
- **大纲导航**：标题树实时预览，一键定位任意章节
- **保存即索引**：改一处，知识库同步更新，无需手动操作

![image-20260502180605732](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502180605732.png)

### 📚 知识库

将导入的文档作为个人知识库，所有回答都基于文档内容，绝不捏造事实，减少大模型幻觉，做你的私人文档助理。

- **零幻觉**：命中阈值以下直接拒答，不瞎编
- **来源可查**：每条回答附出处，一键跳转原文
- **精准检索**：语义 + 关键词双路召回，换个说法也能找到，支持全文档匹配与置顶文档来源匹配

![image-20260502181509584](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502181509584.png)

### ✍️ AI 创作

以知识库为底层基建，AI 按照你的个人风格仿写。自动生成文章大纲，支持 @ 和 Prompt 改动指定文本块,而不是改动全文，避免改了 A 处又动了 B 处，避免撑爆上下文。

- **块级精准改写**：只动你指定的段落，其余一字不碰
- **先预览再应用**：红删绿增，确认后才写入文件
- **学你的风格**：自动从历史文章匹配写法，越用越像你

![image-20260502182642962](https://hejiajun-img-bucket.oss-cn-wuhan-lr.aliyuncs.com/img/image-20260502182642962.png)

### 🤖 Agent 工程

- **上下文管理**：超过上下文阈值时自动压缩上下文
- **用户意图识别**：在创作页面识别用户意图是改写文章还是单纯 Chat，匹配不同策略、调用不同工具；意图模糊时自动生成提问卡片询问用户，避免 AI 误解意图产生幻觉
- **工具调用**：内置工具供 AI 自我调用

## 项目结构

- `notus/`：Next.js 15 Pages Router 应用与全部业务 API
- `desktop/`：Electron 主进程、预加载桥接与桌面打包脚本
- `docs/Notus_PRD.md`：技术实现规范
- `docs/Notus_PDD.md`：产品设计文档
- `docs/PROGRESS.md`：当前实现进度
- `CLAUDE.md` / `AGENTS.md`：仓库协作说明

## 开发

```bash
# 安装依赖
npm install

# 只启动 Web 开发服务
npm run dev:web

# 只启动 Electron，并连接已经运行中的 http://127.0.0.1:3000
npm run dev:desktop

# 同时启动 Web 与桌面端，日常联调推荐用这个
npm run dev:desktop:all
```

## 构建

```bash
# 只构建 notus Web 应用
npm run build:web

# 导出 Web 可分发目录（standalone）
npm run dist:web

# 只准备 Electron 桌面资源
npm run build:desktop

# 按当前主机环境打包桌面安装包
npm run dist:desktop

# 打包 macOS Intel 安装包（dmg）
npm run dist:desktop:mac:x64

# 打包 macOS Apple Silicon 安装包（dmg）
npm run dist:desktop:mac:arm64

# 打包 Windows x64 安装包（exe）
npm run dist:desktop:win:x64

# 执行懒猫 .lpk 打包
npm run dist:lpk
```

## 产物位置

- `npm run dist:web`：输出到 `web-dist/`
- `npm run dist:desktop`：输出到 `desktop/dist/`
- `npm run dist:desktop:mac:x64`：输出 Intel Mac 使用的 `dmg`
- `npm run dist:desktop:mac:arm64`：输出 Apple Silicon Mac 使用的 `dmg`
- `npm run dist:desktop:win:x64`：输出 Windows x64 使用的 `exe`
- `npm run dist:lpk`：输出到仓库根目录，例如 `cloud.lazycat.app.notus-v0.1.2.lpk`

## 桌面端说明

- 桌面端当前新增运行时系统级快捷键 `Command+K` / `Ctrl+K`，可在应用仍在运行时唤起主窗口并直接打开搜索。
- 应用完全退出后，当前版本不支持通过快捷键重新启动应用。
- macOS 默认分发两种 `dmg`：Intel 设备下载 `x64`，Apple Silicon 设备下载 `arm64`。
- `npm run dist:desktop` 是按当前主机环境打包的通用入口，不保证一次生成全部架构产物。
- 跨平台或跨架构打包是否可用，取决于当前打包环境与 `electron-builder` 的限制。

## 链接

- 官网：https://notus.hejiajun.icu/
- 开源地址：https://github.com/dnwwdwd/Notus

## 贡献

欢迎 PR 或一起开发，对项目有任何想法或建议欢迎提 Issue 交流。如果觉得项目对你有帮助，欢迎点个 star ⭐️
