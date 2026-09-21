const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-diff-lazy-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), ASSETS_DIR: path.join(root, 'assets'), DB_PATH: path.join(root, 'notus.db'), LOG_DIR: path.join(root, 'logs'), SESSION_DIR: path.join(root, 'session') });
const { ensureConversation } = require('../lib/conversations');
const { createSession } = require('../lib/agentSession');
const { createOperationSet } = require('../lib/canvasOperationSets');
const { registerOperationSet, getTaskChangeSetDetail } = require('../lib/agentTaskChangeSets');
const { getDb } = require('../lib/db');
try {
  const conversation = ensureConversation({ kind: 'canvas', title: 'Diff 性能回归' });
  const session = createSession({ goal: '大量预览', conversationId: conversation.id, authorizedPaths: ['*'], authorizedOps: ['create', 'modify'] });
  const body = '正文示例，校验完整保留。\n'.repeat(2000);
  for (let batch = 0; batch < 3; batch += 1) {
    const set = createOperationSet({ agentSessionId: session.sessionId, conversationId: conversation.id, patches: Array.from({ length: 40 }, (_, i) => ({ file_path: `file-${batch * 40 + i}.md`, change_type: 'create', old: '', new: `${batch}-${i}\n${body}` })) });
    registerOperationSet({ operationSetId: set.id, sessionId: session.sessionId, conversationId: conversation.id, approvalMode: 'manual_confirm' });
  }
  const measure = options => { const start = performance.now(); const result = getTaskChangeSetDetail(session.sessionId, options); const json = JSON.stringify(result); return { result, bytes: Buffer.byteLength(json), ms: Math.round(performance.now() - start) }; };
  const full = measure();
  const manifest = measure({ manifest: true });
  assert.equal(manifest.result.operation_set_view.patches.length, 120);
  assert(!manifest.result.items);
  assert(manifest.result.operation_sets.every(batch => !batch.patches && !batch.revision));
  assert(manifest.result.operation_set_view.patches.every(p => p.old === undefined && p.new === undefined && p.content_loaded === false));
  assert(manifest.bytes < full.bytes / 20);
  const id = manifest.result.operation_set_view.patches[83].item_id;
  const single = measure({ itemId: id });
  assert.equal(single.result.operation_set_view.patches.length, 1);
  assert.deepStrictEqual(single.result.operation_set_view.patches[0], full.result.operation_set_view.patches[83]);
  assert(single.bytes < full.bytes / 20);
  const another = createSession({ goal: '其他任务', conversationId: conversation.id, authorizedPaths: ['*'], authorizedOps: ['create'] });
  const set = createOperationSet({ agentSessionId: another.sessionId, conversationId: conversation.id, patches: [{ file_path: 'other.md', change_type: 'create', old: '', new: 'other' }] });
  registerOperationSet({ operationSetId: set.id, sessionId: another.sessionId });
  assert.equal(getTaskChangeSetDetail(another.sessionId, { itemId: id }).operation_set_view.patches.length, 0);
  // 使用同一服务端路由验证只读凭据和批次归属，避免按需接口扩大读取范围。
  const Module = require('module');
  const runtimePath = require.resolve('../lib/runtime');
  require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: { ensureRuntime: () => ({ ok: true }) } };
  const endpoint = path.resolve(__dirname, '../pages/api/agent/sessions/[id]/changes.js');
  const compiled = new Module(endpoint, module);
  compiled.filename = endpoint;
  compiled.paths = Module._nodeModulePaths(path.dirname(endpoint));
  compiled._compile(fs.readFileSync(endpoint, 'utf8').replace('export default function handler', 'module.exports = function handler'), endpoint);
  const request = (query, token = session.token) => {
    const result = {};
    compiled.exports({ method: 'GET', query: { id: session.sessionId, ...query }, headers: token ? { 'x-agent-session-token': token } : {} }, { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } });
    return result;
  };
  assert.equal(request({ view: 'manifest' }, '').status, 403);
  assert.equal(request({ view: 'manifest' }, another.token).status, 403);
  assert.equal(request({ batch_id: set.id }).status, 404);
  assert.equal(request({ item_id: '-1' }).status, 400);
  const ownedBatch = request({ batch_id: manifest.result.operation_sets[0].id });
  assert.equal(ownedBatch.status, 200);
  assert.equal(ownedBatch.body.operation_set.patches.length, 40);
  assert.equal(request({ item_id: id }).body.task_change_set.operation_set_view.patches.length, 1);
  console.log('Diff detail benchmark (120 files × 2000 lines)', JSON.stringify({ full: { bytes: full.bytes, ms: full.ms }, manifest: { bytes: manifest.bytes, ms: manifest.ms }, single: { bytes: single.bytes, ms: single.ms } }));
  console.log('agent diff lazy detail tests passed');
} finally { getDb().close(); fs.rmSync(root, { recursive: true, force: true }); }
