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
  // 互斥不再由 Schema 的 oneOf/not 判定（裸关键字对模型不可执行），改为执行层给出可纠正的提示。
  assert.strictEqual(validateToolInput({ name: 'read_tool_result', input: { result_ref: 'tool-result://00000000-0000-4000-8000-000000000000', json_pointer: '', offset: 0 } }, definitions).valid, true);
  assert.strictEqual(validateToolInput({ name: 'read_tool_result', input: { result_ref: 'tool-result://00000000-0000-4000-8000-000000000000', offset: 0, query: 'x' } }, definitions).valid, true);
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
  const fileProjection = projectToolResultForModel({
    useReceipt: true,
    toolName: 'read_file',
    result: { file_id: 42, file_path: '项目/计划.md', content: '不应透传完整正文' },
    artifact: runtimeRead.artifact,
  });
  assert.deepStrictEqual(fileProjection.file_refs, [{ file_id: 42, file_path: '项目/计划.md' }]);
  const createdFile = require('../lib/files').createFile('新建笔记.md', '# 新建笔记\n', { titleFilenameBindingEnabled: false });
  const appliedResult = { applied: true, operation_set: { patches: [{ status: 'applied', file_id: createdFile.id, file_path: createdFile.path }] } };
  const appliedProjection = projectToolResultForModel({ useReceipt: true, toolName: 'create_note', result: appliedResult, artifact: runtimeRead.artifact });
  assert.deepStrictEqual(appliedProjection.file_refs, [{ file_id: createdFile.id, file_path: createdFile.path }]);
  const pendingProjection = projectToolResultForModel({ useReceipt: true, toolName: 'create_note', result: { ...appliedResult, applied: false }, artifact: runtimeRead.artifact });
  assert.strictEqual(pendingProjection.file_refs, undefined, '预览阶段不得提供尚未落盘的文件 ID');
  const wrongPathProjection = projectToolResultForModel({ useReceipt: true, toolName: 'create_note', result: { applied: true, operation_set: { patches: [{ status: 'applied', file_id: createdFile.id, file_path: '其他笔记.md' }] } }, artifact: runtimeRead.artifact });
  assert.strictEqual(wrongPathProjection.file_refs, undefined, '补丁路径与数据库不一致时不得输出可点击 ID');
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
  const defaultWindow = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: artifact.result_ref });
  assert.equal(defaultWindow.mode, 'chunk');
  assert(defaultWindow.content);
  const longPath = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/note.md';
  const { limitToolResult } = require('../lib/agentToolPolicy');
  const localResult = { file_path: longPath, path: longPath, authorization: 'Bearer visible-secret', content: 'api_key=hidden-value sk-abcdefghijklmnopqrstuvwxyz0123456789', nested: { file_path: longPath } };
  const sanitized = limitToolResult('read_file', localResult);
  assert.equal(sanitized.file_path, longPath); assert.equal(sanitized.nested.file_path, longPath);
  assert(!JSON.stringify(sanitized).includes('hidden-value')); assert(!JSON.stringify(sanitized).includes('visible-secret'));
  assert(!JSON.stringify(sanitized).includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.notEqual(limitToolResult('external_mcp', localResult, { isMcp: true }).file_path, longPath, '外部工具不得获得本地路径脱敏例外');
  assert.notEqual(limitToolResult('read_file', localResult, { isMcp: true }).file_path, longPath, '同名外部工具仍按外部结果脱敏');
  const invalidMode = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: artifact.result_ref, query: 'needle', offset: 0 });
  assert.strictEqual(invalidMode.error, 'TOOL_RESULT_READ_MODE_INVALID');
  assert.deepStrictEqual(invalidMode.provided_modes, ['query', 'offset']);
  assert.ok(invalidMode.message.includes('query、offset'), '错误信息要指明冲突的字段');
  assert.ok(invalidMode.message.includes('拆成两次调用'), '错误信息要给出可执行的修正方式');
  const pointerAndOffset = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: artifact.result_ref, jsonPointer: '', offset: 0 });
  assert.strictEqual(pointerAndOffset.error, 'TOOL_RESULT_READ_MODE_INVALID');
  assert.deepStrictEqual(pointerAndOffset.provided_modes, ['json_pointer', 'offset']);

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

  // M4: 云厂商签名与凭据查询参数必须整体脱敏，mock/keyboard 等常见非敏感键不受影响。
  const cloudArtifact = await archiveToolResult({
    conversationId: conversation.id,
    sessionId: created.sessionId,
    toolCallId: 'tool-cloud',
    invocationKey: 'session-1:tool-cloud',
    toolName: 'fetch_tool',
    result: { url: 'https://example.com/bucket?X-Amz-Credential=AKIDEXAMPLE%2F20260101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=abc123def&X-Goog-Signature=googlesig&sig=shortsig&mock=keepme&keyboard=keepboard' },
  });
  assert.strictEqual(cloudArtifact.status, 'ready');
  const cloudStored = zlib.gunzipSync(fs.readFileSync(resolveArtifactPath(cloudArtifact.relative_path))).toString('utf8');
  assert.ok(!cloudStored.includes('AKIDEXAMPLE'), 'X-Amz-Credential 中的 AccessKeyID 必须被脱敏');
  assert.ok(!cloudStored.includes('abc123def'), 'X-Amz-Signature 必须被脱敏');
  assert.ok(!cloudStored.includes('googlesig'), 'X-Goog-Signature 必须被脱敏');
  assert.ok(!cloudStored.includes('shortsig'), 'sig 查询参数必须被脱敏');
  assert.ok(cloudStored.includes('mock=keepme'));
  assert.ok(cloudStored.includes('keyboard=keepboard'));

  // M5: v2 工件直通；v1 旧工件读取时必须按现行脱敏规则二次脱敏。
  const v2Artifact = await archiveToolResult({
    conversationId: conversation.id,
    sessionId: created.sessionId,
    toolCallId: 'tool-v2',
    invocationKey: 'session-1:tool-v2',
    toolName: 'legacy_tool',
    result: { value: 'v2-passthrough-check' },
  });
  const v2Read = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: v2Artifact.result_ref, offset: 0 });
  assert.ok(v2Read.content.includes('v2-passthrough-check'), 'v2 工件保持直通');

  const legacyArtifact = await archiveToolResult({
    conversationId: conversation.id,
    sessionId: created.sessionId,
    toolCallId: 'tool-legacy',
    invocationKey: 'session-1:tool-legacy',
    toolName: 'legacy_tool',
    result: { value: 'legacy' },
  });
  const legacyText = JSON.stringify({ url: 'https://example.com/?X-Amz-Signature=abc123&sig=oldsig', token: 'legacy-secret-value', note: 'legacy' });
  fs.writeFileSync(resolveArtifactPath(legacyArtifact.relative_path), zlib.gzipSync(legacyText));
  getDb().prepare('UPDATE agent_tool_result_artifacts SET redaction_version = 1, sha256 = ?, original_bytes = ? WHERE id = ?')
    .run(require('../lib/files').sha256(legacyText), Buffer.byteLength(legacyText), legacyArtifact.id);
  const legacyRead = await readToolResult({ conversationId: conversation.id, sessionId: created.sessionId, resultRef: legacyArtifact.result_ref, offset: 0 });
  assert.ok(!legacyRead.content.includes('abc123'), 'v1 工件读取时必须再次脱敏签名参数');
  assert.ok(!legacyRead.content.includes('oldsig'), 'v1 工件读取时必须再次脱敏 sig 参数');
  assert.ok(!legacyRead.content.includes('legacy-secret-value'), 'v1 工件读取时必须再次脱敏凭据');
  assert.ok(legacyRead.content.includes('[REDACTED]'));
  const legacyRuntime = await readArtifactResultForRuntime({ conversationId: conversation.id, sessionId: created.sessionId, invocationKey: 'session-1:tool-legacy' });
  assert.ok(!JSON.stringify(legacyRuntime.result).includes('legacy-secret-value'), '运行时恢复 v1 工件同样必须二次脱敏');

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
