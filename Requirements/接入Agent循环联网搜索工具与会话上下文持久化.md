# 接入Agent循环联网搜索工具与会话上下文持久化

## 分类

功能优化

## 需求描述

将输入框联网搜索从“配置与参数记录”升级为真实 Agent Loop tool use：

- 输入框联网开关打开时，后端向 Agent Loop 注入 `web_search` 工具；关闭时不注入，模型不可感知联网工具。
- `web_search` 可在同一任务中重复调用不同关键词。
- 支持 Firecrawl、Tavily、Exa、智谱四个搜索服务商，运行时只调用用户当前选择的一个 provider。
- Firecrawl 允许无 API Key 使用；Tavily、Exa、智谱未配置 API Key 时，输入框选择该 provider 会弹窗引导配置。
- 弹窗跳转到 `/settings/search?provider=<provider>`，设置页自动切换到对应 provider tab。
- 联网搜索结果作为同一会话的上下文进行管理和持久化，后续同会话仅在联网开关打开时按预算拼入 Agent system prompt。

## 落地记录

- 新增联网搜索 SDK 调用层，使用 `firecrawl`、`@tavily/core`、`exa-js`、`openai` 官方 npm 依赖调用 Firecrawl、Tavily、Exa、智谱；Notus 仅统一返回标题、URL、正文、摘要和耗时，不手写维护各 Provider 的 HTTP 请求细节。
- `agent_sessions` 新增联网搜索开关、provider、模式、结果数和工具 profile 字段；知识库页联网问答走只读 Agent Loop，避免暴露写入工具。
- 新增 `web_search_context` 持久化消息类型，保存每次成功搜索的截断全文、URL、provider、query 和 session 元数据。
- Agent Loop 仅在 `web_search_enabled=true` 且 provider 可用时注入 `web_search`；关闭时不加载历史联网上下文。
- 输入框 provider 下拉会拦截未配置 API Key 的服务商并打开配置弹窗；Firecrawl 不要求 Key。
- 设置页搜索配置支持读取 `provider` query 参数并切换 tab，API Key 占位文案区分 Firecrawl 可选 Key 和其他 provider 必填 Key。

## 状态

已完成
