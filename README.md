# Notus

Notus 是一款支持 Web 与 Electron 桌面端的私人知识库与 AI 写作助手，保留对懒猫运行时的兼容能力。

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
