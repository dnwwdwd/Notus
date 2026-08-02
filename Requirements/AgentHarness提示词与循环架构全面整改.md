# Agent Harness、提示词与循环架构全面整改

## 分类与状态

- 分类：功能优化 / 用户体验优化。
- 状态：已完成代码整改与自动化验收，待真实环境回归。
- 对应审查：`docs/Agent Harness、提示词与循环架构全面审查报告.md`。
- 对应方案：`docs/Agent Harness、提示词与循环架构整改方案.md`。

## 背景与目标

当前 Agent Loop 已能完成检索、工具调用、文件预览和会话持久化，但跨刷新恢复、并发接管、checkpoint 提交、长上下文、取消超时、Prompt 版本化、工具输入约束和验收基线仍有缺口。本需求把上述链路收口为可恢复、可并发保护、可预算、可追溯和可验收的 0.1.13 实现。

## 范围与非目标

- 实现 session 状态机、run lease、幂等 resume job、短期恢复票据和 checkpoint 两阶段提交。
- 实现统一上下文预算、overflow 重试、取消超时、SSE 心跳、Prompt Registry、动态材料 Envelope、工具 Schema 校验和 usage 累计。
- 取消 Loop 启动时的全库快照，改为按 operation set 保存写入基线。
- 修正测试漂移、API 运行时边界、响应式阈值和 0.1.13 版本文档。
- 不引入多用户登录系统；票据结构只预留 `owner_id`。
- 不开放删除文件或目录能力，不改变全 notes 工作区的非删除写入规则。
- 不恢复“已使用资料 / 文件变更”卡片开关，不执行发布、推送或 `.lpk` 打包。

## 影响分析

| 维度 | 已确认内容 |
|---|---|
| 写入入口 | Loop 启动/恢复、interaction 回答、取消、operation set 应用与回滚、数据库迁移和配置。 |
| 读取方与状态传播 | 文件工作区、SSE 控制器、会话详情、提问卡、Diff 卡、历史记录、Prompt、工具与运行日志。 |
| 刷新与恢复 | 会话详情返回脱敏 session、pending interaction、resume job 和限时票据；重复请求只返回同一 job。 |
| 失败、取消与回滚 | lease 冲突禁止重复运行；取消中止活动请求；新 checkpoint 提交前保留旧版；文件回滚使用 operation set 基线。 |
| 平台与安全边界 | Web、Electron、懒猫共用服务端状态机；票据不放 URL、日志或聊天正文；密钥、Cookie 和原始不可信材料继续脱敏。 |
| 已检查但不受影响 | 索引维度、对象存储路径、编辑器 Markdown 双向转换、文件标题绑定和 Agent 回执卡临时开关不改变。 |

## 行为验收矩阵

| 场景 | 前置条件 | 操作 | 预期结果 | 验证状态 |
|---|---|---|---|---|
| 刷新恢复 | Agent 正在等待提问回答 | 刷新后回答卡片 | 同一 session 继续，不依赖内存 token | 自动化通过，待实机 |
| 重复提交 | 同一 interaction 已回答 | 并发提交和续跑 | 只创建一个 job、一个 run | 自动化通过 |
| 长上下文 | 消息和工具结果超过软阈值 | 调用 LLM | 请求前压缩，overflow 只硬压缩重试一次 | 自动化通过 |
| 取消和超时 | LLM 或 MCP 正在等待 | 停止任务或超时 | 活动请求中止，session 终态一致 | 自动化通过，待真实 Provider |
| Loop 守卫 | 相同工具结果被其他成功工具隔开 | 连续运行 | 不误判死循环或连续失败 | 自动化通过 |
| 大工作区 | notes 含 1 万篇笔记 | 启动普通对话 | 不递归快照全库 | 自动化通过 |
| Prompt 注入 | Skill/MCP/Web 含越权文字 | 加载材料 | 不改变系统规则，密钥不进日志 | 离线 Eval 通过 |
| SSE 消息 | 多轮工具执行 | 查看进展和最终回复 | progress 不写入正文，final 只保存一次 | 自动化与构建通过 |

## 文档同步

- 已更新需求总台账、Bug 台账、项目进度、产品设计、产品技术实现、界面规范、Agent 循环架构、文件工作区 Agent 流程、业务逻辑、版本记录和文档地图。
- `AGENTS.md` 已增加 health Route 例外，`CLAUDE.md` 已完全同步。

## 实现与验证

- 代码与配置：已完成迁移 006、控制面、恢复 API、预算、取消、Prompt Registry、Envelope、工具校验、SSE v2、安全 API 和响应式阈值整改。
- 自动化验证：`npm run test:all`、`npm run lint:web`、`npm run build:web`、`npm run build:desktop` 已通过；离线 JSONL Eval 与 checkpoint 故障注入通过。
- 构建附带发现：生产依赖审计仍有 9 项风险，已单独记录为 BUG-20260801-001，不与本次 Harness 整改混合升级。
- 待实机回归：真实 LLM、Web、Electron、懒猫、对象存储和多提供商协议。
