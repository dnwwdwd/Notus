function buildOutputModule() {
  return {
    id: 'output.final-only', priority: 40, applies: true, maxTokens: 1_000,
    evalCases: ['progress-final-separation'],
    content: '## 输出通道\n模型文本只表达面向用户的任务进展或最终内容；服务端负责 progress、artifact、final 分流。需要调用工具时，可先用一两句简短的“执行说明”告知要做的下一步，随后再调用工具；这不是隐藏推理，不要展开逐步思维过程。最终答复只生成一次，不输出内部思考、票据、Cookie、密钥或完整工具原始结果。',
  };
}

module.exports = { buildOutputModule };
