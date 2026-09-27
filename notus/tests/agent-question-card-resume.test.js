const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-question-card-resume-'));
  Object.assign(process.env, {
    NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root,
    DB_PATH: path.join(root, 'test.db'), NOTES_DIR: path.join(root, 'notes'),
    ASSETS_DIR: path.join(root, 'assets'), LOG_DIR: path.join(root, 'logs'),
    SESSION_DIR: path.join(root, 'session'),
  });

  const llmPath = require.resolve('../lib/llm');
  let modelCalls = 0;
  let resumedAnswer = null;
  require.cache[llmPath] = {
    id: llmPath, filename: llmPath, loaded: true,
    exports: {
      completeToolChat: async (request) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: [{ type: 'tool_use', id: 'question-1', name: 'ask_question_card', input: {
              title: '确认产品信息',
              questions: [
                { id: 'audience', label: '目标用户群体和货币', question: '目标用户群体和货币？', options: [{ id: 'domestic', label: '国内用户，人民币' }, { id: 'overseas', label: '海外用户，美元' }] },
                { id: 'delivery', label: '发卡方式', question: '如何采购和发货？', options: [{ id: 'manual', label: '手动采购和发卡' }, { id: 'automatic', label: '自动采购和发卡' }] },
                { id: 'payment', label: '支付方式', question: '付款方式？', options: [{ id: 'wallets', label: '支付宝和微信支付' }, { id: 'card', label: '信用卡' }] },
              ],
            } }],
            stopReason: 'tool_use',
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          };
        }
        const answerBlock = (request.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : [])
          .find((block) => block.type === 'tool_result' && block.tool_use_id === 'question-1');
        try { resumedAnswer = JSON.parse(answerBlock?.content || 'null'); } catch { resumedAnswer = null; }
        const answers = resumedAnswer?.answers || {};
        const hasAnswers = answers.audience?.value === '国内用户购买美区礼品卡（人民币收款）'
          && answers.delivery?.value === '手动采购 + 手动发卡'
          && answers.payment?.value === '支付宝 + 微信支付';
        const text = hasAnswers ? '已收到三项信息，我会据此撰写需求文档。' : '请先回答上面三个问题。';
        return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
      },
    },
  };

  const { ensureConversation } = require('../lib/conversations');
  const { createSession, getSession, updateSessionStatus } = require('../lib/agentSession');
  const { getInteractionById, normalizeInteractionResponse, updateInteractionWhen } = require('../lib/conversationInteractions');
  const { runAgentLoop } = require('../lib/agentLoop');
  const conversation = ensureConversation({ kind: 'canvas', title: '提问卡片续跑' });
  const { sessionId } = createSession({ goal: '请根据我回答的产品信息写需求文档', conversationId: conversation.id });
  updateSessionStatus(sessionId, 'running');
  const options = { sessionId, llmConfig: { llmContextWindowTokens: 60000 }, approvalMode: 'auto_confirm' };
  const waiting = await runAgentLoop(options);
  assert.strictEqual(waiting.status, 'waiting_interaction', JSON.stringify({ waiting, modelCalls }));
  const interaction = getInteractionById(waiting.interaction_id);
  const response = normalizeInteractionResponse(interaction, { answers: {
    audience: { value: '国内用户购买美区礼品卡（人民币收款）' },
    delivery: { value: '手动采购 + 手动发卡' },
    payment: { value: '支付宝 + 微信支付' },
  } });
  assert.strictEqual(response.resolution_status, 'resolved');
  updateInteractionWhen(interaction.id, ['pending'], { status: 'answered', response, answeredAt: new Date().toISOString() });
  updateSessionStatus(sessionId, 'queued_resume');
  const resumed = await runAgentLoop({ ...options, resumeInteractionId: interaction.id });
  assert.strictEqual(resumed.status, 'completed');
  assert.strictEqual(resumedAnswer?.answered, true, '模型必须看到卡片已回答状态');
  assert.strictEqual(resumedAnswer.answers.audience.value, '国内用户购买美区礼品卡（人民币收款）');
  assert.strictEqual(resumedAnswer.answers.delivery.value, '手动采购 + 手动发卡');
  assert.strictEqual(resumedAnswer.answers.payment.value, '支付宝 + 微信支付');
  assert.strictEqual(getSession(sessionId).status, 'completed');
  console.log('agent question card resume tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
