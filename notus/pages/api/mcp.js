const { ensureRuntime } = require('../../lib/runtime');
const { authenticateToken, createExternalMcpServer } = require('../../lib/externalMcp');

function rpcError(res, status, message, code = -32000) {
  return res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export default async function handler(req, res) {
  if (!ensureRuntime().ok) return rpcError(res, 500, 'Notus 运行时初始化失败', -32603);
  if (!['POST', 'GET', 'DELETE'].includes(req.method)) return rpcError(res, 405, 'Method not allowed', -32600);
  let server;
  let transport;
  try {
    const token = authenticateToken(bearerToken(req));
    server = await createExternalMcpServer(token);
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.once('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  } catch (cause) {
    if (transport) transport.close().catch(() => {});
    if (server) server.close().catch(() => {});
    const unauthorized = cause?.code === 'EXTERNAL_MCP_UNAUTHORIZED';
    return rpcError(res, unauthorized ? 401 : 500, unauthorized ? 'MCP Token 无效或已停用' : 'MCP 服务暂时不可用', unauthorized ? -32001 : -32603);
  }
}
