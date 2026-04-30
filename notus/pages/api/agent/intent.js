const { ensureRuntime } = require('../../../lib/runtime');
const { getFileById } = require('../../../lib/files');
const { buildCanvasIntentPrompt } = require('../../../lib/prompt');
const { completeChat } = require('../../../lib/llm');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { user_input: userInput, article_id: articleId } = req.body || {};
  if (!userInput) return res.status(400).json({ error: 'user_input is required', code: 'USER_INPUT_REQUIRED' });

  try {
    const article = articleId ? getFileById(articleId) : null;
    const reply = await completeChat(buildCanvasIntentPrompt(userInput, article), {
      responseFormat: { type: 'json_object' },
      taskType: 'canvas_intent',
    });
    const parsed = JSON.parse(reply.message?.content || '{}');
    return res.status(200).json({
      intent: parsed.intent === 'knowledge' ? 'knowledge' : 'canvas',
      confidence: Number(parsed.confidence || 0.6),
    });
  } catch (error) {
    const fallback = /@b\d+|改写|润色|扩写|压缩|插入|删除/.test(userInput) ? 'canvas' : 'knowledge';
    return res.status(200).json({ intent: fallback, confidence: 0.4 });
  }
}
