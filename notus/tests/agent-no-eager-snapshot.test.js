const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function reset(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-no-eager-snapshot-'));
  const notesDir = path.join(root, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  for (let folder = 0; folder < 100; folder += 1) {
    const dir = path.join(notesDir, `folder-${folder}`);
    fs.mkdirSync(dir);
    for (let file = 0; file < 100; file += 1) fs.writeFileSync(path.join(dir, `note-${file}.md`), '# note\n');
  }
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = root;
  process.env.NOTES_DIR = notesDir;
  process.env.ASSETS_DIR = path.join(root, 'assets');
  process.env.DB_PATH = path.join(root, 'notus.db');
  process.env.LOG_DIR = path.join(root, 'logs');
  process.env.SESSION_DIR = path.join(root, 'session');
  process.env.CANVAS_ENABLE_STYLE_EXTRACTION = 'false';

  ['../lib/db', '../lib/config', '../lib/agentSession', '../lib/agentLoop', '../lib/platform/paths', '../lib/platform/profile', '../lib/platform/target'].forEach(reset);
  const llmPath = require.resolve('../lib/llm');
  const original = require.cache[llmPath];
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: {
      completeToolChat: async () => ({
        content: [{ type: 'text', text: '普通任务完成。' }],
        stopReason: 'end_turn',
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    },
  };
  try {
    const { createSession, countSnapshots, updateSessionStatus } = require('../lib/agentSession');
    const { runAgentLoop } = require('../lib/agentLoop');
    const created = createSession({ goal: '普通任务，不读取文件' });
    updateSessionStatus(created.sessionId, 'running');
    const result = await runAgentLoop({ sessionId: created.sessionId, llmConfig: { llmContextWindowTokens: 60_000 } });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(countSnapshots(created.sessionId), 0, '1 万篇笔记的普通任务启动时不得生成全库快照');
  } finally {
    if (original) require.cache[llmPath] = original;
    else delete require.cache[llmPath];
  }
  console.log('agent no eager snapshot tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
