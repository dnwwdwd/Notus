const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-tool-results-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');

  const { getDb } = require('../lib/db');
  getDb();
  const { ensureConversation, deleteConversation } = require('../lib/conversations');
  const { createSession } = require('../lib/agentSession');
  const { buildToolDefinitions } = require('../lib/agentTools');
  const { validateToolInput } = require('../lib/agentToolPolicy');
  const {
    MAX_CONVERSATION_STORED_BYTES,
    MAX_READ_BYTES,
    archiveToolResult,
    cleanupOrphanedToolResultFiles,
    projectToolResultForModel,
    readArtifactResultForRuntime,
    readToolResult,
    resolveArtifactPath,
  } = require('../lib/agentToolResultStore');
  const conversation = ensureConversation({ kind: 'knowledge', title: 'artifact test' });
  const created = createSession({ goal: 'artifact test', conversationId: conversation.id });
  const definitions = buildToolDefinitions({ tool_profile: 'default', web_search_enabled: false });
  assert.strictEqual(validateToolInput({ name: 'read_tool_result', input: { result_ref: 'tool-result://00000000-0000-4000-8000-000000000000', offset: 0 } }, definitions).valid, true);
  assert.strictEqual(validateToolInput({ name: 'read_tool_result', input: { result_ref: 'tool-result://00000000-0000-4000-8000-000000000000', offset: 0, query: 'x' } }, definitions).valid, false);
  const largeText = `needle ${'x'.repeat(MAX_READ_BYTES + 2048)}`;
  const artifact = await archiveToolResult({
    conversationId: conversation.id,
    sessionId: created.sessionId,
    toolCallId: 'tool-1',
    invocationKey: 'session-1:tool-1',
    toolName: 'example_tool',
    result: {
      nested: { value: 42 },
      text: largeText,
      authorization: 'Bearer should-not-remain',
      url: 'https://user:pass@example.com/path?token=should-not-remain&ok=1',
      api_key: 'sk-test-secret-1234567890',
    },
  });
  assert.strictEqual(artifact.status, 'ready');
  const compressedBytes = fs.readFileSync(resolveArtifactPath(artifact.relative_path));
  assert.ok(compressedBytes.length > 0);
  const storedText = zlib.gunzipSync(compressedBytes).toString('utf8');
  assert.ok(!storedText.includes('should-not-remain'));
  assert.ok(!storedText.includes('user:pass'));
  const runtimeRead = await readArtifactResultForRuntime({ conversationId: conversation.id, sessionId: created.sessionId, invocationKey: 'session-1:tool-1' });
  assert.strictEqual(runtimeRead.result.nested.value, 42);
  const recoveredProjection = projectToolResultForModel({ useReceipt: true, toolName: 'external_mcp', result: runtimeRead.result, artifact: runtimeRead.artifact });
  assert.strictEqual(recoveredProjection.result_ref, artifact.result_ref);
  assert.strictEqual(recoveredProjection.status, 'success');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(recoveredProjection, 'nested'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(recoveredProjection, 'text'), false);
  assert.strictEqual(projectToolResultForModel({ useReceipt: false, toolName: 'external_mcp', result: runtimeRead.result, artifact: runtimeRead.artifact }), runtimeRead.result);
  const resultRoot = path.join(tempRoot, 'agent-tool-results');
  const unrelatedFile = path.join(resultRoot, 'keep.txt');
  const orphanFile = path.join(resultRoot, '999', '999', '00000000-0000-4000-8000-000000000001.json.gz');
  fs.mkdirSync(path.dirname(orphanFile), { recursive: true });
  fs.writeFileSync(unrelatedFile, 'keep');
  fs.writeFileSync(orphanFile, 'orphan');
  cleanupOrphanedToolResultFiles();
  assert.strictEqual(fs.existsSync(unrelatedFile), true);
  assert.strictEqual(fs.existsSync(orphanFile), false);

  const pointer = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: artifact.result_ref, jsonPointer: '/nested/value' });
  assert.strictEqual(pointer.content, '42');
  const query = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: artifact.result_ref, query: 'needle', maxBytes: 4096 });
  assert.strictEqual(query.match_count, 1);
  const chunk = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: artifact.result_ref, offset: 0, maxBytes: MAX_READ_BYTES * 2 });
  assert.ok(Buffer.byteLength(chunk.content, 'utf8') <= MAX_READ_BYTES);
  const invalidMode = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: artifact.result_ref, query: 'needle', offset: 0 });
  assert.strictEqual(invalidMode.error, 'TOOL_RESULT_READ_MODE_INVALID');

  const otherConversation = ensureConversation({ kind: 'knowledge', title: 'other' });
  const denied = await readToolResult({ conversationId: otherConversation.id, resultRef: artifact.result_ref, offset: 0 });
  assert.strictEqual(denied.error, 'TOOL_RESULT_NOT_FOUND');
  const otherSession = createSession({ goal: 'same conversation other session', conversationId: conversation.id });
  const sessionDenied = await readToolResult({ conversationId: conversation.id, sessionId: otherSession.sessionId, resultRef: artifact.result_ref, offset: 0 });
  assert.strictEqual(sessionDenied.error, 'TOOL_RESULT_NOT_FOUND');
  const pathDenied = await readToolResult({ conversationId: conversation.id, resultRef: '/tmp/result.json', offset: 0 });
  assert.strictEqual(pathDenied.error, 'TOOL_RESULT_REF_INVALID');
  assert.throws(() => resolveArtifactPath('../../outside.json'), /路径无效/);

  const corruptArtifact = await archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, toolCallId: 'tool-corrupt', invocationKey: 'session-1:tool-corrupt', toolName: 'corrupt_tool', result: { ok: true } });
  fs.writeFileSync(resolveArtifactPath(corruptArtifact.relative_path), 'not gzip');
  const corrupt = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: corruptArtifact.result_ref, offset: 0 });
  assert.strictEqual(corrupt.error, 'TOOL_RESULT_CORRUPT');

  const digestArtifact = await archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, toolCallId: 'tool-digest', invocationKey: 'session-1:tool-digest', toolName: 'digest_tool', result: { value: 'original' } });
  fs.writeFileSync(resolveArtifactPath(digestArtifact.relative_path), zlib.gzipSync(JSON.stringify({ value: 'replaced' })));
  const digestMismatch = await readArtifactResultForRuntime({ conversationId: conversation.id, sessionId: created.sessionId, invocationKey: 'session-1:tool-digest' });
  assert.strictEqual(digestMismatch.error, 'TOOL_RESULT_DIGEST_MISMATCH');

  getDb().prepare('UPDATE agent_tool_result_artifacts SET stored_bytes = ? WHERE id = ?').run(MAX_CONVERSATION_STORED_BYTES, artifact.id);
  const conversationQuota = await archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, toolCallId: 'tool-conversation-quota', invocationKey: 'session-1:tool-conversation-quota', toolName: 'quota_tool', result: { ok: true } });
  assert.strictEqual(conversationQuota.status, 'quota_exceeded');
  getDb().prepare('UPDATE agent_tool_result_artifacts SET stored_bytes = ? WHERE id = ?').run(compressedBytes.length, artifact.id);

  const quota = await archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, toolCallId: 'tool-2', invocationKey: 'session-1:tool-2', toolName: 'large_tool', result: { text: 'short words '.repeat(3 * 1024 * 1024) } });
  assert.strictEqual(quota.status, 'quota_exceeded');

  const artifactPath = resolveArtifactPath(artifact.relative_path);
  assert.strictEqual(deleteConversation(conversation.id), true);
  assert.strictEqual(fs.existsSync(artifactPath), false);
  getDb().exec('DROP TABLE agent_tool_result_artifacts');
  const databaseFailure = await archiveToolResult({ conversationId: 999, sessionId: 999, toolCallId: 'db-failure', invocationKey: 'db-failure', toolName: 'external_tool', result: { external_effect: true } });
  assert.strictEqual(databaseFailure.status, 'archive_failed');
  console.log('agent tool result store tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
