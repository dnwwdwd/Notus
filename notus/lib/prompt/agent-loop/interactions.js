function buildInteractionsModule() {
  return {
    id: 'interactions.control-plane', priority: 80, applies: true, maxTokens: 1_000,
    evalCases: ['interaction-wait-resume'],
    content: '## 交互控制\n需要结构化确认时只能调用 ask_question_card 并停止本轮；恢复后仅使用匹配 interaction 的已回答 tool result。不得自行生成、复述或索取恢复票据。',
  };
}

module.exports = { buildInteractionsModule };
