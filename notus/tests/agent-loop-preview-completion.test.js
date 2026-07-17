const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-loop-preview-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.LOG_DIR = path.join(tempRoot, 'logs');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');
  process.env.CANVAS_ENABLE_STYLE_EXTRACTION = 'false';

  [
    '../lib/db',
    '../lib/config',
    '../lib/files',
    '../lib/conversations',
    '../lib/canvasOperationSets',
    '../lib/agentSession',
    '../lib/agentTools',
    '../lib/fileRevisions',
    '../lib/fileRevisionDiff',
    '../lib/agentLoop',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const llmPath = require.resolve('../lib/llm');
  const originalLlm = require.cache[llmPath];
  let llmCallCount = 0;
  let modelDraftContent = '';
  let continuationMode = false;
  let continuationCallCount = 0;
  let continuationDraftContent = '';
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: {
      completeToolChat: async (request = {}) => {
        llmCallCount += 1;
        if (continuationMode) {
          assert.ok(String(request.system || '').includes('new-version.md'), '承接改写应收到上一轮真实创建文件的路径');
          assert.ok(
            !(request.tools || []).some((tool) => tool.name === 'create_note'),
            '承接改写不能继续暴露 create_note，避免误建第二个文件'
          );
          continuationCallCount += 1;
          if (continuationCallCount === 1) {
            return {
              content: [{ type: 'tool_use', id: 'toolu_read_created', name: 'read_file', input: { path: 'new-version.md' } }],
              stopReason: 'tool_use',
            };
          }
          return {
            content: [{ type: 'tool_use', id: 'toolu_rewrite_created', name: 'preview_file_revision', input: { file_path: 'new-version.md', draft_content: continuationDraftContent } }],
            stopReason: 'tool_use',
          };
        }
        return {
          content: [
            { type: 'text', text: '准备生成全文修订预览。<thinking>这里是内部推理，不应展示。</thinking>' },
            {
              type: 'tool_use',
              id: 'toolu_revision_1',
              name: 'preview_file_revision',
              input: {
                file_path: 'case.md',
                draft_content: modelDraftContent,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    },
  };

  try {
    const { createFile, getFileByPath } = require('../lib/files');
    const { ensureConversation } = require('../lib/conversations');
    const { createSession, getSession, updateSessionStatus } = require('../lib/agentSession');
    const { createOperationSet, getOperationSetById } = require('../lib/canvasOperationSets');
    const { runAgentLoop } = require('../lib/agentLoop');

    const file = createFile('case.md', '# Title\n\nalpha\n');
    modelDraftContent = getFileByPath('case.md').content.replace('alpha', 'alpha changed');
    const conversation = ensureConversation({
      kind: 'canvas',
      title: 'Agent Loop Preview Completion Test',
      fileId: file.id,
    });
    const session = createSession({
      goal: [
        '用户任务：请润色当前文章',
        '',
        '当前文章路径：case.md',
      ].join('\n'),
      authorizedPaths: ['case.md'],
      authorizedOps: ['modify'],
      conversationId: conversation.id,
    });
    updateSessionStatus(session.sessionId, 'running');

    const events = [];
    const result = await runAgentLoop({
      sessionId: session.sessionId,
      approvalMode: 'manual_confirm',
      llmConfig: { llmContextWindowTokens: 60000 },
      onStream: (event) => events.push(event),
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(llmCallCount, 1);
    assert.strictEqual(getSession(session.sessionId).status, 'completed');
    assert.ok(result.operation_set_id > 0);
    assert.strictEqual(getOperationSetById(result.operation_set_id).status, 'pending');
    assert.ok(events.some((event) => (
      event.type === 'thinking'
      && String(event.text || '').includes('diff 卡片')
    )), JSON.stringify(events));
    assert.ok(events.every((event) => !String(event.text || '').includes('内部推理')), JSON.stringify(events));

    const createdFile = createFile('new-version.md', '# Notus 新版本前瞻\n\n初稿\n');
    createOperationSet({
      conversationId: conversation.id,
      agentSessionId: session.sessionId,
      articleHash: 'created-file-context',
      mode: 'create_file',
      status: 'applied',
      patches: [{
        file_path: 'new-version.md',
        old: '',
        new: createdFile.content,
        change_type: 'create',
        status: 'applied',
      }],
    });
    continuationMode = true;
    continuationDraftContent = createdFile.content.replace('初稿', '重写后的正文');
    const continuationSession = createSession({
      goal: '用户任务：根据这些内容进行重写，不要写小功能',
      authorizedPaths: [''],
      authorizedOps: ['modify', 'create'],
      conversationId: conversation.id,
    });
    const continuationResult = await runAgentLoop({
      sessionId: continuationSession.sessionId,
      approvalMode: 'manual_confirm',
      llmConfig: { llmContextWindowTokens: 60000 },
    });
    assert.strictEqual(continuationResult.status, 'completed');
    assert.strictEqual(continuationCallCount, 2, '承接改写应先读取目标文件，再生成全文修订预览');
    assert.strictEqual(getOperationSetById(continuationResult.operation_set_id).revision_file_path, 'new-version.md');
  } finally {
    delete require.cache[require.resolve('../lib/agentLoop')];
    if (originalLlm) require.cache[llmPath] = originalLlm;
    else delete require.cache[llmPath];
  }

  console.log('agent loop preview completion tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
