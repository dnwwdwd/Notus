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

  const { createFile, getFileByPath } = require('../lib/files');
  const { appendConversationMessage, ensureConversation } = require('../lib/conversations');
  const { createSession, getSession, updateSessionStatus } = require('../lib/agentSession');
  const { getOperationSetById } = require('../lib/canvasOperationSets');
  const { getInteractionById } = require('../lib/conversationInteractions');
  const {
    applyPreviewWithConflictCheck,
    executeAskQuestionCard,
    executeCreateNote,
    executePreviewCanvasBlocks,
    executeToolSafely,
    rollbackPreviewPatchFile,
  } = require('../lib/agentTools');

  const file = createFile('draft.md', '第一段\n\n- 第二段');
  const conversation = ensureConversation({
    kind: 'canvas',
    title: '块级测试',
    fileId: file.id,
  });
  const session = createSession({
    goal: [
      '用户任务：@b1 改得更清楚',
      '',
      '当前打开文档：draft.md',
      '',
      '当前创作页文本块快照（用户可用 @b1、@b2 指定块；如需按块改写，优先调用 preview_canvas_blocks）：',
      '',
      '@b1 (paragraph, block_id=b_1)',
      '第一段',
      '',
      '@b2 (list, block_id=b_2)',
      '- 第二段',
    ].join('\n'),
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

  const patchFallback = await executeToolSafely({
    name: 'preview_patch_files',
    input: {
      patches: [
        { file_path: file.path, old: '第一段', new: '第一段（文件级改写）' },
      ],
    },
  }, getSession(session.sessionId));
  assert.strictEqual(patchFallback.error, 'CANVAS_BLOCK_TOOL_REQUIRED');

  const outOfScope = await executePreviewCanvasBlocks({
    edits: [
      { block_ref: '@b2', new: '第二段（不应被允许）' },
    ],
  }, session.sessionId);
  assert.strictEqual(outOfScope.error, 'BLOCK_SCOPE_VIOLATION');
  assert.deepStrictEqual(outOfScope.allowed_block_refs, ['@b1']);

  const noExplicitBlockSession = createSession({
    goal: [
      '用户任务：请润色这篇文章',
      '',
      '当前打开文档：draft.md',
      '',
      '当前创作页文本块快照（用户可用 @b1、@b2 指定块；如需按块改写，优先调用 preview_canvas_blocks）：',
      '',
      '@b1 (paragraph, block_id=b_1)',
      '第一段',
      '',
      '@b2 (list, block_id=b_2)',
      '- 第二段',
    ].join('\n'),
    authorizedPaths: [file.path],
    authorizedOps: ['modify'],
    conversationId: conversation.id,
  });
  updateSessionStatus(noExplicitBlockSession.sessionId, 'running');
  const unrestrictedPatch = await executeToolSafely({
    name: 'preview_patch_files',
    input: {
      patches: [
        { file_path: file.path, old: '第一段', new: '第一段（文件级改写）' },
      ],
    },
  }, getSession(noExplicitBlockSession.sessionId));
  assert.notStrictEqual(unrestrictedPatch.error, 'CANVAS_BLOCK_TOOL_REQUIRED');

  const createPreviewSession = createSession({
    goal: '用户任务：新建一篇介绍 Notus 的文档',
    authorizedPaths: [file.path],
    authorizedOps: ['modify', 'create'],
    conversationId: conversation.id,
  });
  updateSessionStatus(createPreviewSession.sessionId, 'running');
  const createPreview = await executeCreateNote({
    path: 'notus-intro.md',
    title: 'Notus 介绍',
    content: '# Notus 介绍\n\n这是新建文档正文。',
  }, createPreviewSession.sessionId);
  assert.ok(createPreview.operation_set_id);
  assert.strictEqual(createPreview.preview, true);
  assert.strictEqual(getFileByPath('notus-intro.md'), null);

  const appliedCreate = await applyPreviewWithConflictCheck(createPreview.operation_set_id, createPreviewSession.sessionId, {
    approvalMode: 'manual_confirm',
  });
  assert.strictEqual(appliedCreate.success, true);
  const createdFile = getFileByPath('notus-intro.md');
  assert.ok(createdFile);
  assert.ok(createdFile.content.includes('Notus 介绍'));

  const rolledBackCreate = await rollbackPreviewPatchFile(createPreview.operation_set_id, createPreviewSession.sessionId, {
    patchIndex: 0,
  });
  assert.strictEqual(rolledBackCreate.success, true);
  assert.strictEqual(getFileByPath('notus-intro.md'), null);

  appendConversationMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '请读取并分析已上传的文件。',
    meta: {
      agent_loop: true,
      attachments: [{ name: 'profile.pdf', type: 'application/pdf', size: 1234 }],
      parsed_attachments: [{ source: 'profile.pdf', type: 'pdf', status: 'success' }],
    },
  });
  const attachmentReadSession = createSession({
    goal: '用户任务：请读取并分析已上传的文件。',
    authorizedPaths: [file.path],
    authorizedOps: ['modify'],
    conversationId: conversation.id,
  });
  updateSessionStatus(attachmentReadSession.sessionId, 'running');
  const blockedQuestionCard = await executeToolSafely({
    name: 'ask_question_card',
    input: {
      title: '确认写入位置',
      questions: [
        { id: 'target', label: '要把 PDF 加入自我介绍文档的哪个位置？', type: 'text_input' },
      ],
    },
  }, getSession(attachmentReadSession.sessionId));
  assert.strictEqual(blockedQuestionCard.error, 'QUESTION_CARD_REQUIRES_EXPLICIT_WRITE_INTENT');

  appendConversationMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '根据附件写一份摘要',
    meta: {
      agent_loop: true,
      attachments: [{ name: 'summary.pdf', type: 'application/pdf', size: 2345 }],
      parsed_attachments: [{ source: 'summary.pdf', type: 'pdf', status: 'success' }],
    },
  });
  const attachmentSummarySession = createSession({
    goal: '用户任务：根据附件写一份摘要',
    authorizedPaths: [file.path],
    authorizedOps: ['modify'],
    conversationId: conversation.id,
  });
  updateSessionStatus(attachmentSummarySession.sessionId, 'running');
  const genericSummaryQuestionCard = await executeToolSafely({
    name: 'ask_question_card',
    input: {
      title: '确认写入位置',
      questions: [
        { id: 'target', label: '要把摘要加入当前文档的哪个位置？', type: 'text_input' },
      ],
    },
  }, getSession(attachmentSummarySession.sessionId));
  assert.strictEqual(genericSummaryQuestionCard.error, 'QUESTION_CARD_REQUIRES_EXPLICIT_WRITE_INTENT');

  appendConversationMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '把这个 PDF 加入当前文档',
    meta: {
      agent_loop: true,
      attachments: [{ name: 'profile.pdf', type: 'application/pdf', size: 1234 }],
      parsed_attachments: [{ source: 'profile.pdf', type: 'pdf', status: 'success' }],
    },
  });
  const attachmentWriteSession = createSession({
    goal: '用户任务：把这个 PDF 加入当前文档',
    authorizedPaths: [file.path],
    authorizedOps: ['modify'],
    conversationId: conversation.id,
  });
  updateSessionStatus(attachmentWriteSession.sessionId, 'running');
  const allowedQuestionCard = await executeToolSafely({
    name: 'ask_question_card',
    input: {
      title: '确认写入位置',
      questions: [
        { id: 'target', label: '要把 PDF 加入当前文档的哪个位置？', type: 'text_input' },
      ],
    },
  }, getSession(attachmentWriteSession.sessionId));
  assert.ok(allowedQuestionCard.interaction_id);

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
