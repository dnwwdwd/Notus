function buildOutputModule() {
  return {
    id: 'output.final-only', priority: 40, applies: true, maxTokens: 1_000,
    evalCases: ['progress-final-separation'],
    content: '## 输出通道\n模型文本只表达任务进展或最终内容；服务端负责 progress、artifact、final 分流。最终答复只生成一次，不输出内部思考、票据、Cookie、密钥或完整工具原始结果。',
  };
}

module.exports = { buildOutputModule };
