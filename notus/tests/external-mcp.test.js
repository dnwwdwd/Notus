const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-external-mcp-test-'));
process.env.NOTUS_DATA_ROOT = dataRoot;
process.env.NOTUS_RUNTIME_TARGET = 'web';

async function run() {
  const { ensureRuntime } = require('../lib/runtime');
  const { getDb } = require('../lib/db');
  const { getFileByPath } = require('../lib/files');
  const {
    DEFAULT_PERMISSIONS, createToken, updateToken, rotateToken, authenticateToken,
    executeWriteTool, getChange, applyChange, rejectChange, listChanges, removeToken, createExternalMcpServer,
  } = require('../lib/externalMcp');

  try {
    assert.equal(ensureRuntime().ok, true);
    const automatic = createToken({ name: '自动 Token', approval_mode: 'auto' });
    assert.deepEqual(automatic.token.permissions, DEFAULT_PERMISSIONS);
    assert.match(automatic.raw_token, /^ntm_/);
    const stored = getDb().prepare('SELECT token_hash FROM external_mcp_tokens WHERE id = ?').get(automatic.token.id);
    assert.equal(stored.token_hash.includes(automatic.raw_token), false);
    assert.equal(Object.prototype.hasOwnProperty.call(require('../lib/externalMcp').getToken(automatic.token.id), 'raw_token'), false);
    const autoToken = authenticateToken(automatic.raw_token);
    updateToken(automatic.token.id, { permissions: ['get_change_status', 'list_files'] });
    assert.deepEqual(require('../lib/externalMcp').getToken(automatic.token.id).permissions, ['list_files']);
    const autoServer = await createExternalMcpServer(authenticateToken(automatic.raw_token));
    assert.equal(Object.prototype.hasOwnProperty.call(autoServer._registeredTools, 'get_change_status'), false);
    await autoServer.close();
    assert.throws(() => authenticateToken('ntm_wrong'), (error) => error.code === 'EXTERNAL_MCP_UNAUTHORIZED');

    const created = await executeWriteTool(autoToken, 'create_note', { path: 'external/auto.md', content: '# Auto\n\n初始内容', expected_hash: 'absent' });
    assert.equal(created.status, 'applied');
    const first = getFileByPath('external/auto.md');
    assert.ok(first);
    const firstHash = require('crypto').createHash('sha256').update(first.content).digest('hex');
    const patched = await executeWriteTool(autoToken, 'patch_note', { path: first.path, expected_hash: firstHash, patches: [{ old: '初始内容', new: '局部修改' }] });
    assert.equal(patched.status, 'applied');
    const second = getFileByPath('external/auto.md');
    const secondHash = require('crypto').createHash('sha256').update(second.content).digest('hex');
    await assert.rejects(() => executeWriteTool(autoToken, 'patch_note', { path: second.path, expected_hash: secondHash, patches: [{ old: '不存在', new: 'x' }] }), (error) => error.code === 'EXTERNAL_MCP_PATCH_MISMATCH');
    await executeWriteTool(autoToken, 'replace_note', { path: second.path, expected_hash: secondHash, content: '# Auto\n\n完整替换' });
    const third = getFileByPath('external/auto.md');
    const thirdHash = require('crypto').createHash('sha256').update(third.content).digest('hex');
    await executeWriteTool(autoToken, 'rename_note', { path: third.path, expected_hash: thirdHash, name: 'renamed.md' });
    const renamed = getFileByPath('external/renamed.md');
    const renamedHash = require('crypto').createHash('sha256').update(renamed.content).digest('hex');
    await executeWriteTool(autoToken, 'move_note', { path: renamed.path, expected_hash: renamedHash, directory: 'moved' });
    assert.ok(getFileByPath('moved/renamed.md'));

    const manual = createToken({ name: '手动 Token', approval_mode: 'manual', permissions: ['create_note', 'get_change_status'] });
    const manualToken = authenticateToken(manual.raw_token);
    const manualServer = await createExternalMcpServer(manualToken);
    assert.deepEqual(Object.keys(manualServer._registeredTools).sort(), ['create_note', 'get_change_status']);
    assert.equal(Object.keys(manualServer._registeredTools).some((name) => /delete|web_search/i.test(name)), false);
    await manualServer.close();
    const pending = await executeWriteTool(manualToken, 'create_note', { path: 'external/manual.md', content: '# Manual', expected_hash: 'absent' });
    assert.equal(pending.status, 'pending');
    assert.equal(getFileByPath('external/manual.md'), null);
    assert.equal(getChange(pending.change_id).status, 'pending');
    await applyChange(pending.change_id);
    assert.equal(getChange(pending.change_id).status, 'applied');
    assert.ok(getFileByPath('external/manual.md'));
    const rejected = await executeWriteTool(manualToken, 'create_note', { path: 'external/rejected.md', content: '# Reject', expected_hash: 'absent' });
    rejectChange(rejected.change_id);
    assert.equal(getChange(rejected.change_id).status, 'rejected');
    assert.equal(getFileByPath('external/rejected.md'), null);
    assert.ok(listChanges({ statuses: ['pending', 'conflict', 'applied', 'rejected'] }).length >= 2);

    const rotated = rotateToken(automatic.token.id);
    assert.throws(() => authenticateToken(automatic.raw_token), (error) => error.code === 'EXTERNAL_MCP_UNAUTHORIZED');
    assert.equal(authenticateToken(rotated.raw_token).id, automatic.token.id);
    updateToken(manual.token.id, { enabled: false });
    assert.throws(() => authenticateToken(manual.raw_token), (error) => error.code === 'EXTERNAL_MCP_UNAUTHORIZED');
    assert.equal(removeToken(manual.token.id).deleted, true);
    assert.equal(JSON.stringify(getDb().prepare('SELECT detail_json FROM external_mcp_audit_logs').all()).includes(automatic.raw_token), false);
    const settingsSource = fs.readFileSync(path.join(__dirname, '../components/Settings/SettingsScreen.js'), 'utf8');
    const iconSource = fs.readFileSync(path.join(__dirname, '../components/ui/Icons.js'), 'utf8');
    const externalRouteSource = fs.readFileSync(path.join(__dirname, '../pages/api/mcp.js'), 'utf8');
    const settingsRouteSource = fs.readFileSync(path.join(__dirname, '../pages/api/settings/mcp/[...path].js'), 'utf8');
    const manifestSource = fs.readFileSync(path.join(__dirname, '../../lzc-manifest.yml'), 'utf8');
    assert.ok(settingsSource.includes("label: '调用 MCP'"));
    assert.ok(settingsSource.includes("label: 'MCP 服务'"));
    assert.ok(settingsSource.includes('aria-label="复制 Token"'));
    assert.ok(settingsSource.includes("'/api/settings/mcp/tokens'"));
    assert.ok(externalRouteSource.includes('StreamableHTTPServerTransport'));
    assert.ok(settingsRouteSource.includes('listTokens'));
    assert.ok(manifestSource.includes('    - /api/mcp'));
    assert.ok(settingsSource.includes('待确认变更'));
    assert.ok(iconSource.includes('skill: (p) => <Icon {...p}><path d="m12 2.5 8 4.5v10L12 21.5 4 17V7z"/>'), 'Skill 图标应使用等距立方体轮廓');
    assert.ok(iconSource.includes('<path d="m4 12 8 4.5 8-4.5"/>'), 'Skill 图标应包含等高两层方块的分隔线');
    assert.ok(iconSource.includes('mcp: (p) => <Icon {...p}><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>'), 'MCP 图标应使用横向双层服务器机架');
    assert.ok(iconSource.includes('M7 7h.01M10 7h.01M14 7h4M7 17h.01M10 17h.01M14 17h4'), 'MCP 图标应包含状态灯和端口线');
    console.log('external mcp tests passed');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
