const { ensureRuntime } = require('../../../lib/runtime');
const { listServers, getServer, saveServer, removeServer, testServer, cachedTools, disconnectServer } = require('../../../lib/mcp');

export default async function handler(req, res) {
  if (!ensureRuntime().ok) return res.status(500).json({ error: '运行时初始化失败' });
  const parts = Array.isArray(req.query.path) ? req.query.path : [];
  try {
    if (parts[0] !== 'servers') return res.status(404).end();
    if (parts.length === 1 && req.method === 'GET') return res.status(200).json({ servers: listServers() });
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
