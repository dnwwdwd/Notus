const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('isomorphic-git');
const archiver = require('archiver');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-skill-mcp-test-'));
const originalHome = process.env.HOME;
const testHome = path.join(dataRoot, 'home');
fs.mkdirSync(testHome, { recursive: true });
process.env.NOTUS_DATA_ROOT = dataRoot;
process.env.NOTUS_RUNTIME_TARGET = 'electron';
process.env.HOME = testHome;

async function createZip(filePath, entries) {
  await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(filePath);
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    entries.forEach((entry) => archive.append(entry.content, { name: entry.path }));
    archive.finalize();
  });
}

async function run() {
  const { ensureRuntime } = require('../lib/runtime');
  const { createSession, getSession, logToolCall, listRunLogs } = require('../lib/agentSession');
  const { getSkillMcpCapabilities } = require('../lib/platform/capabilities');
  const { getDb } = require('../lib/db');
  const { saveServer, getServer, listServers, removeServer, isToolCacheStale, prepareMcpTools } = require('../lib/mcp');
  const { buildToolDefinitions, executeAddMcpServer, executeInstallSkillFromGit } = require('../lib/agentTools');
  const { buildLoopSystemPrompt } = require('../lib/agentLoopPrompt');
  const { cloneGitMainOrMaster, discoverCandidates, getSkill, setSkillEnabled, loadSkill, installFromGit, updateSkillFromGit, installFromZip, stopSkillWatchers } = require('../lib/skills');

  try {
    assert.equal(ensureRuntime().ok, true);
    const capabilities = getSkillMcpCapabilities('electron', { dataRoot });
    assert.equal(capabilities.mcp.stdio, true);
    assert.equal(capabilities.skills.discoverExternalRoots, true);

    const created = createSession({
      goal: '整理研究笔记',
      authorizedPaths: [''],
      skillMentions: ['skill-a'],
      mcpSelection: { mode: 'auto' },
      mcpSessionPermissions: { allow_local_http: true },
    });
    const session = getSession(created.sessionId);
    assert.deepEqual(session.skill_mentions, ['skill-a']);
    assert.deepEqual(session.mcp_selection, { mode: 'auto' });
    assert.deepEqual(session.mcp_session_permissions, { allow_local_http: true });

    const prompt = buildLoopSystemPrompt(session, {
      skillCatalog: [{ id: 'skill-a', name: 'skill-a', description: '测试 Skill', sourceLabel: 'test', explicit: true }],
      mcpInstructions: [{ server: 'test MCP', text: '外部说明' }],
    });
    assert.ok(prompt.includes('本轮明确选择的 Skill'));
    assert.ok(prompt.includes('不可信输入'));
    assert.ok(prompt.includes('install_skill_from_git'));

    const agentTools = buildToolDefinitions(session);
    const addMcpDefinition = agentTools.find((item) => item.name === 'add_mcp_server');
    assert.ok(agentTools.some((item) => item.name === 'install_skill_from_git'));
    assert.deepEqual(addMcpDefinition.input_schema.properties.transport.enum, ['streamable_http', 'stdio']);
    assert.ok(addMcpDefinition.input_schema.properties.stdio);

    const server = await saveServer({
      name: 'test MCP',
      transport: 'streamable_http',
      http: { url: 'http://127.0.0.1:39001/mcp', allowLocalHttp: true },
      toolPolicy: { default: 'deny', deny: ['legacy-tool'] },
    });
    const disabledServer = await saveServer({
      name: 'disabled MCP',
      transport: 'streamable_http',
      enabled: false,
      http: { url: 'http://127.0.0.1:39002/mcp', allowLocalHttp: true },
    });
    assert.equal(server.tool_policy, undefined);
    assert.equal(listServers().length, 2);
    assert.equal(listServers({ includeDisabled: false }).length, 1);

    getDb().prepare('INSERT INTO mcp_tool_cache (server_id,tool_name,description,input_schema_json,schema_hash,discovered_at) VALUES (?,?,?,?,?,?)')
      .run(server.id, 'legacy-tool', '用于测试 MCP 选择范围', '{"type":"object","properties":{}}', 'test-schema', new Date().toISOString());
    assert.equal(isToolCacheStale(server.id), false);
    getDb().prepare('UPDATE mcp_tool_cache SET discovered_at = ? WHERE server_id = ?').run('2000-01-01T00:00:00.000Z', server.id);
    assert.equal(isToolCacheStale(server.id), true);
    getDb().prepare('UPDATE mcp_tool_cache SET discovered_at = ? WHERE server_id = ?').run(new Date().toISOString(), server.id);
    const specified = await prepareMcpTools({ mode: 'server', serverId: server.id }, '测试 MCP', { allow_local_http: true });
    assert.equal(specified.tools.length, 1);
    assert.equal(Object.values(specified.map)[0].serverId, server.id);
    const automatic = await prepareMcpTools({ mode: 'auto' }, '测试 MCP', { allow_local_http: true });
    assert.ok(automatic.tools.every((tool) => tool.mcp.serverId === server.id));
    const remoteAutomatic = await prepareMcpTools({ mode: 'auto' }, '测试 MCP');
    assert.equal(remoteAutomatic.tools.length, 0, '未获本机许可的 session 不得注入本机 HTTP MCP 工具');

    await assert.rejects(
      () => saveServer({ name: 'test MCP', transport: 'streamable_http', http: { url: 'http://127.0.0.1:39003/mcp', allowLocalHttp: true } }),
      (error) => error.code === 'MCP_SERVER_ALREADY_EXISTS'
    );

    await removeServer(server.id);
    await removeServer(disabledServer.id);
    assert.equal(listServers().length, 0);

    const agentMcp = await executeAddMcpServer({
      name: 'agent MCP',
      transport: 'streamable_http',
      http: { url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer top-secret' }] },
    });
    assert.equal(agentMcp.server.name, 'agent MCP');
    assert.equal(agentMcp.test.ok, false);
    assert.equal(getServer(agentMcp.server.id).config.http.headers[0].secret, true);
    const storedConfig = getDb().prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(agentMcp.server.id).config_json;
    assert.equal(storedConfig.includes('top-secret'), false);
    logToolCall({ sessionId: session.id, loopIndex: 1, toolName: 'add_mcp_server', toolInput: { name: 'agent MCP', transport: 'streamable_http', http: { url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer top-secret' }] } }, toolResult: agentMcp, thinking: '使用 Bearer top-secret 新增 MCP' });
    const agentLog = listRunLogs(session.id).at(-1);
    assert.equal(JSON.stringify(agentLog).includes('top-secret'), false);
    await removeServer(agentMcp.server.id);

    process.env.NOTUS_RUNTIME_TARGET = 'web';
    const webTools = buildToolDefinitions(session);
    const webMcpDefinition = webTools.find((item) => item.name === 'add_mcp_server');
    assert.deepEqual(webMcpDefinition.input_schema.properties.transport.enum, ['streamable_http']);
    assert.equal(webMcpDefinition.input_schema.properties.stdio, undefined);
    const webServer = await saveServer({ name: 'web MCP', transport: 'streamable_http', http: { url: 'https://example.com/mcp' } });
    const localWebServer = await saveServer({
      name: 'web local MCP',
      transport: 'streamable_http',
      http: {
        url: 'http://127.0.0.1:39005/mcp',
        allowLocalHttp: true,
        headers: [{ name: 'Authorization', value: 'Bearer local-test-secret', secret: true }],
      },
    });
    assert.equal(localWebServer.config.http.allow_local_http, true);
    assert.equal(localWebServer.config.http.headers[0].configured, true);
    assert.equal(JSON.stringify(localWebServer).includes('local-test-secret'), false);
    const localStoredConfig = getDb().prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(localWebServer.id).config_json;
    assert.equal(localStoredConfig.includes('local-test-secret'), false);
    const replacedSecretId = JSON.parse(localStoredConfig).http.headers[0].secretId;
    await saveServer({
      name: 'web local MCP',
      transport: 'streamable_http',
      http: {
        url: 'http://127.0.0.1:39005/mcp',
        allowLocalHttp: true,
        headers: [{ name: 'Authorization', value: 'Bearer local-test-secret-rotated', secret: true }],
      },
    }, localWebServer.id);
    const rotatedSecretId = JSON.parse(getDb().prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(localWebServer.id).config_json).http.headers[0].secretId;
    assert.notEqual(rotatedSecretId, replacedSecretId);
    await assert.rejects(() => require('../lib/secretStore').readSecret(replacedSecretId));
    const sharedSecretServer = await saveServer({
      name: 'web local MCP shared secret',
      transport: 'streamable_http',
      http: { url: 'https://example.org/mcp', headers: [{ name: 'Authorization', secretId: rotatedSecretId, secret: true }] },
    });
    await removeServer(localWebServer.id);
    assert.equal(await require('../lib/secretStore').readSecret(rotatedSecretId), 'Bearer local-test-secret-rotated');
    await removeServer(sharedSecretServer.id);
    await assert.rejects(() => require('../lib/secretStore').readSecret(rotatedSecretId));
    await assert.rejects(
      () => saveServer({ name: 'web local MCP without consent', transport: 'streamable_http', http: { url: 'http://127.0.0.1:39006/mcp' } }),
      (error) => error.code === 'MCP_HTTP_URL_BLOCKED'
    );
    await removeServer(webServer.id);
    await assert.rejects(
      () => saveServer({ name: 'web stdio MCP', transport: 'stdio', stdio: { command: 'node' } }),
      (error) => error.code === 'MCP_TRANSPORT_UNAVAILABLE'
    );
    process.env.NOTUS_RUNTIME_TARGET = 'electron';

    const originalClone = git.clone;
    const attemptedRefs = [];
    try {
      git.clone = async ({ dir, ref }) => {
        attemptedRefs.push(ref);
        if (ref === 'main') throw new Error('main branch not found');
        fs.writeFileSync(path.join(dir, '.git-clone-test'), 'ok');
      };
      const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-git-branch-test-'));
      const selectedRef = await cloneGitMainOrMaster({ dir: cloneDir, url: 'https://example.com/git-skill.git' });
      assert.deepEqual(attemptedRefs, ['main', 'master']);
      assert.equal(selectedRef, 'master');
      fs.rmSync(cloneDir, { recursive: true, force: true });

      attemptedRefs.length = 0;
      git.clone = async ({ dir, ref }) => {
        attemptedRefs.push(ref);
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: git-skill\ndescription: Git 安装测试\n---\n\n测试内容\n');
      };
      const installed = await executeInstallSkillFromGit({ repository_url: 'https://example.com/git-skill.git' });
      assert.deepEqual(attemptedRefs, ['main']);
      assert.equal(installed.installed.length, 1);
      assert.equal(installed.installed[0].name, 'git-skill');
      assert.equal(getSkill(installed.installed[0].id).can_update, true);
      await assert.rejects(
        () => executeInstallSkillFromGit({ repository_url: 'https://example.com/git-skill.git' }),
        (error) => error.code === 'SKILL_ALREADY_EXISTS'
      );
      setSkillEnabled(installed.installed[0].id, false);

      git.clone = async ({ dir, ref }) => {
        attemptedRefs.push(ref);
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: git-skill\ndescription: Git 更新测试\n---\n\n更新后的内容\n');
      };
      attemptedRefs.length = 0;
      const updated = await updateSkillFromGit(installed.installed[0].id);
      assert.deepEqual(attemptedRefs, ['main']);
      assert.equal(updated.skill.id, installed.installed[0].id);
      assert.equal(getSkill(installed.installed[0].id).enabled, false);
      setSkillEnabled(installed.installed[0].id, true);
      assert.match(loadSkill(installed.installed[0].id).instructions, /更新后的内容/);

      git.clone = async ({ dir }) => {
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: renamed-skill\ndescription: 名称变更测试\n---\n\n不应覆盖\n');
      };
      await assert.rejects(
        () => updateSkillFromGit(installed.installed[0].id),
        (error) => error.code === 'SKILL_UPDATE_NAME_MISMATCH'
      );
      assert.match(loadSkill(installed.installed[0].id).instructions, /更新后的内容/);

      git.clone = async () => { throw Object.assign(new Error('clone failed'), { code: 'SKILL_SOURCE_UNREACHABLE' }); };
      await assert.rejects(
        () => updateSkillFromGit(installed.installed[0].id),
        (error) => error.code === 'SKILL_SOURCE_UNREACHABLE'
      );
      assert.match(loadSkill(installed.installed[0].id).instructions, /更新后的内容/);

      const gitOverwriteArchive = path.join(dataRoot, 'git-skill-overwrite.zip');
      await createZip(gitOverwriteArchive, [
        { path: 'git-skill/SKILL.md', content: '---\nname: git-skill\ndescription: ZIP 覆盖 Git 测试\n---\n\nZIP 已覆盖 Git 内容\n' },
      ]);
      const gitOverwritten = await installFromZip(gitOverwriteArchive, { conflictPolicy: 'replace' });
      assert.equal(gitOverwritten.skills[0].id, installed.installed[0].id);
      assert.equal(getSkill(installed.installed[0].id).can_update, false);
      assert.match(loadSkill(installed.installed[0].id).instructions, /ZIP 已覆盖 Git 内容/);

      const archivePath = path.join(dataRoot, 'zip-skill.zip');
      await createZip(archivePath, [
        { path: 'zip-skill/SKILL.md', content: '---\nname: zip-skill\ndescription: ZIP 安装测试\n---\n\n测试内容\n' },
        { path: 'zip-skill/references/guide.md', content: '# 参考资料\n' },
      ]);
      const zipInstalled = await installFromZip(archivePath, { conflictPolicy: 'reject' });
      assert.equal(zipInstalled.skills.length, 1);
      assert.equal(zipInstalled.skills[0].name, 'zip-skill');
      assert.equal(getSkill(zipInstalled.skills[0].id).can_update, false);
      fs.rmSync(archivePath, { force: true });
      await createZip(archivePath, [
        { path: 'zip-skill/SKILL.md', content: '---\nname: zip-skill\ndescription: ZIP 覆盖更新测试\n---\n\nZIP 更新后的内容\n' },
      ]);
      const zipUpdated = await installFromZip(archivePath, { conflictPolicy: 'replace' });
      assert.equal(zipUpdated.skills[0].id, zipInstalled.skills[0].id);
      assert.match(loadSkill(zipInstalled.skills[0].id).instructions, /ZIP 更新后的内容/);

      git.clone = async () => {};
      await assert.rejects(
        () => installFromGit({ repositoryUrl: 'https://example.com/no-skill.git', conflictPolicy: 'reject' }),
        (error) => error.code === 'SKILL_INVALID' && error.message.includes('根目录缺少 SKILL.md')
      );

      const discoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-skill-discovery-test-'));
      const vanishedCandidate = path.join(discoveryDir, 'github-repo-crawler');
      fs.mkdirSync(vanishedCandidate);
      fs.writeFileSync(path.join(vanishedCandidate, 'SKILL.md'), '---\nname: github-repo-crawler\ndescription: 候选扫描测试\n---\n\n测试内容\n');
      const originalReaddirSync = fs.readdirSync;
      try {
        fs.readdirSync = (directory, options) => {
          if (directory === vanishedCandidate) fs.rmSync(vanishedCandidate, { recursive: true, force: true });
          return originalReaddirSync(directory, options);
        };
        assert.deepEqual(discoverCandidates(discoveryDir), []);
      } finally {
        fs.readdirSync = originalReaddirSync;
        fs.rmSync(discoveryDir, { recursive: true, force: true });
      }

      git.clone = async ({ dir }) => {
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: source-gone\ndescription: 源目录失效测试\n---\n\n测试内容\n');
      };
      const originalCpSync = fs.cpSync;
      try {
        fs.cpSync = (source, target, options) => {
          fs.rmSync(source, { recursive: true, force: true });
          return originalCpSync(source, target, options);
        };
        await assert.rejects(
          () => installFromGit({ repositoryUrl: 'https://example.com/source-gone.git', conflictPolicy: 'reject' }),
          (error) => error.code === 'SKILL_SOURCE_UNAVAILABLE' && error.message.includes('Skill 安装源目录不可用')
        );
      } finally {
        fs.cpSync = originalCpSync;
      }
    } finally {
      git.clone = originalClone;
    }
    console.log('skill and mcp tests passed');
  } finally {
    stopSkillWatchers();
    fs.rmSync(dataRoot, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
