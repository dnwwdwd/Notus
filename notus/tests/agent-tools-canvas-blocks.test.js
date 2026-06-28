const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function runTests() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-canvas-blocks-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempDir;

  [
    '../lib/db',
    '../lib/config',
    '../lib/files',
    '../lib/conversations',
    '../lib/canvasOperationSets',
    '../lib/agentSession',
    '../lib/agentTools',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const { createFile } = require('../lib/files');
  const { ensureConversation } = require('../lib/conversations');
  const { createSession, updateSessionStatus } = require('../lib/agentSession');
  const { getOperationSetById } = require('../lib/canvasOperationSets');
  const { getInteractionById } = require('../lib/conversationInteractions');
  const { executeAskQuestionCard, executePreviewCanvasBlocks } = require('../lib/agentTools');

  const file = createFile('draft.md', '第一段\n\n第二段');
  const conversation = ensureConversation({
    kind: 'canvas',
    title: '块级测试',
    fileId: file.id,
  });
  const session = createSession({
    goal: '用户任务：@b1 改得更清楚',
    authorizedPaths: [file.path],
    authorizedOps: ['modify'],
    conversationId: conversation.id,
  });
  updateSessionStatus(session.sessionId, 'running');

  const result = await executePreviewCanvasBlocks({
    edits: [
      { block_ref: '@b1', new: '第一段（已改写）' },
    ],
  }, session.sessionId);

  assert.ok(result.operation_set_id);
  assert.strictEqual(result.operation_count, 1);
  const set = getOperationSetById(result.operation_set_id);
  assert.strictEqual(set.patches.length, 0);
  assert.strictEqual(set.operations.length, 1);
  assert.ok(set.operations[0].old.includes('第一段'));
  assert.strictEqual(set.operations[0].new, '第一段（已改写）');

  const questionCard = executeAskQuestionCard({
    title: '提问卡片',
    intro: '先确认两个问题。',
    questions: [
      {
        id: 'target_reader',
        label: '读者是谁？',
        type: 'single_select',
        options: [
          { id: 'internal', label: '内部团队' },
          { id: 'public', label: '公开读者' },
        ],
      },
      {
        id: 'tone',
        label: '语气要求？',
        type: 'text_input',
      },
    ],
  }, session.sessionId);

  assert.strictEqual(questionCard.question_card_requested, true);
  assert.strictEqual(questionCard.question_count, 2);
  assert.ok(questionCard.interaction_id);
  const interaction = getInteractionById(questionCard.interaction_id);
  assert.strictEqual(interaction.source, 'agent_loop');
  assert.strictEqual(interaction.payload.title, '提问卡片');
  assert.strictEqual(interaction.payload.questions.length, 2);

  console.log('agent tools canvas block tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
