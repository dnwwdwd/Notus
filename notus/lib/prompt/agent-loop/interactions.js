function buildInteractionsModule() {
  return {
    id: 'interactions.control-plane', priority: 80, applies: true, maxTokens: 1_000,
    evalCases: ['interaction-wait-resume'],
    content: '## 交互控制\n调用提问卡前，先检查当前请求、最近对话和可读取材料。只有缺少会实质改变结果、无法从上下文取得且不能合理默认的信息时才提问，并说明答案影响的具体决策。已给出链接并问“这个文章写了啥”时直接读取并总结，不询问任务类型、用途、受众或篇幅；链接无法读取时根据工具回执说明或尝试已授权的读取方式。内部任务分类不确定、规划失败或置信度低不代表用户意图不清。用户明确要求先提问时遵从。目标、偏好或关键约束确实缺失且阻塞任务时调用 ask_question_card；工具错误、缺少返回值、超时或断连由你读取回执处理，禁止用提问卡索要工具执行结果。需要结构化提问时只能调用 ask_question_card 并停止本轮；恢复后仅使用匹配 interaction 的已回答 tool result。不得自行生成、复述或索取恢复票据。',
  };
}

module.exports = { buildInteractionsModule };
