const { ensureRuntime } = require('../../../../lib/runtime');
const { listServers, getServer, saveServer, removeServer, testServer, cachedTools, disconnectServer } = require('../../../../lib/mcp');
const { listTokens, getToken, createToken, updateToken, rotateToken, removeToken, listChanges, getChange, applyChange, rejectChange } = require('../../../../lib/externalMcp');

export default async function handler(req, res) {
  if (!ensureRuntime().ok) return res.status(500).json({ error: '运行时初始化失败' });
  const parts = Array.isArray(req.query.path) ? req.query.path : [];
  try {
    if (parts[0] === 'tokens') {
      if (parts.length === 1 && req.method === 'GET') return res.status(200).json({ tokens: listTokens() });
      if (parts.length === 1 && req.method === 'POST') return res.status(201).json(createToken(req.body || {}));
      const id = parts[1];
      if (!id) return res.status(404).end();
      if (parts[2] === 'rotate' && req.method === 'POST') return res.status(200).json(rotateToken(id));
      if (req.method === 'GET') { const token = getToken(id); return token ? res.status(200).json({ token }) : res.status(404).json({ error: 'MCP Token 不存在' }); }
      if (req.method === 'PATCH') return res.status(200).json({ token: updateToken(id, req.body || {}) });
      if (req.method === 'DELETE') return res.status(200).json(removeToken(id));
      return res.status(405).end();
    }
    if (parts[0] === 'changes') {
      if (parts.length === 1 && req.method === 'GET') return res.status(200).json({ changes: listChanges({ statuses: String(req.query.status || '').split(',').filter(Boolean), includePayload: true }) });
      const id = parts[1];
      if (!id) return res.status(404).end();
      if (parts[2] === 'apply' && req.method === 'POST') return res.status(200).json(await applyChange(id));
      if (parts[2] === 'reject' && req.method === 'POST') return res.status(200).json({ change: rejectChange(id) });
      if (req.method === 'GET') { const change = getChange(id, { includePayload: true }); return change ? res.status(200).json({ change }) : res.status(404).json({ error: '待确认变更不存在' }); }
      return res.status(405).end();
    }
    if (parts[0] !== 'servers') return res.status(404).end();
    if (parts.length === 1 && req.method === 'GET') return res.status(200).json({ servers: listServers({ includeDisabled: req.query.enabled_only !== '1' }) });
    if (parts.length === 1 && req.method === 'POST') return res.status(201).json({ server: await saveServer(req.body || {}) });
    const id = parts[1];
    if (!id) return res.status(404).end();
    if (parts[2] === 'test' && req.method === 'POST') return res.status(200).json(await testServer(id));
    if (parts[2] === 'disconnect' && req.method === 'POST') { await disconnectServer(id); return res.status(200).json({ ok: true }); }
    if (parts[2] === 'tools' && req.method === 'GET') return res.status(200).json({ tools: cachedTools(id) });
    if (req.method === 'GET') { const server = getServer(id); return server ? res.status(200).json({ server }) : res.status(404).json({ error: 'MCP Server 不存在' }); }
    if (req.method === 'PATCH') return res.status(200).json({ server: await saveServer(req.body || {}, id) });
    if (req.method === 'DELETE') return res.status(200).json(await removeServer(id));
    return res.status(405).end();
  } catch (error) { return res.status(error.code === 'MCP_TRANSPORT_UNAVAILABLE' ? 422 : 400).json({ error: error.message, code: error.code || 'MCP_API_ERROR' }); }
}
