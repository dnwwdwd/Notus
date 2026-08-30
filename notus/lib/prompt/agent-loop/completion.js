function buildCompletionModule(_session, options = {}) {
  const correction = String(options.completionCorrection || '').trim();
  return {
    id: 'completion.contract',
    priority: 110,
    applies: true,
    maxTokens: 1_000,
    content: [
      '## 完成条件',
      '只有任务契约要求的来源、产物和外部操作有真实运行时事实时，才能报告完成。调用过工具不等于任务完成；工具结果未知时必须停止并说明需要核实。',
      correction,
    ].filter(Boolean).join('\n'),
  };
}

module.exports = { buildCompletionModule };
