const assert = require('assert');
const { allowsLocalHttpMcp, isDirectLoopbackRequest } = require('../lib/directLoopbackRequest');

const originalNodeEnv = process.env.NODE_ENV;
const originalRuntimeTarget = process.env.NOTUS_RUNTIME_TARGET;
const originalOptIn = process.env.NOTUS_ALLOW_LOOPBACK_HTTP_MCP;

function request({ address = '127.0.0.1', host = '127.0.0.1:3000', headers = {} } = {}) {
  return { socket: { remoteAddress: address }, headers: { host, ...headers } };
}

try {
  process.env.NODE_ENV = 'development';
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_ALLOW_LOOPBACK_HTTP_MCP = 'false';
  assert.equal(isDirectLoopbackRequest(request()), true);
  assert.equal(allowsLocalHttpMcp(request()), true);
  assert.equal(isDirectLoopbackRequest(request({ host: 'notus.example.com' })), false);
  assert.equal(isDirectLoopbackRequest(request({ headers: { 'x-forwarded-for': '203.0.113.8' } })), false);
  assert.equal(isDirectLoopbackRequest(request({ headers: { forwarded: 'for=203.0.113.8' } })), false);
  assert.equal(isDirectLoopbackRequest(request({ headers: { 'x-forwarded-host': 'notus.example.com' } })), false);
  assert.equal(isDirectLoopbackRequest(request({ address: '192.168.18.12' })), false);

  process.env.NODE_ENV = 'production';
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_ALLOW_LOOPBACK_HTTP_MCP = 'false';
  assert.equal(allowsLocalHttpMcp(request()), false, '部署者可显式禁用本机 HTTP MCP');
  process.env.NOTUS_ALLOW_LOOPBACK_HTTP_MCP = 'true';
  assert.equal(allowsLocalHttpMcp(request()), true);
  assert.equal(allowsLocalHttpMcp(request({ headers: { 'x-real-ip': '127.0.0.1' } })), false, '带代理来源头的请求一律不得获得本机许可');
} finally {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
  if (originalRuntimeTarget === undefined) delete process.env.NOTUS_RUNTIME_TARGET; else process.env.NOTUS_RUNTIME_TARGET = originalRuntimeTarget;
  if (originalOptIn === undefined) delete process.env.NOTUS_ALLOW_LOOPBACK_HTTP_MCP; else process.env.NOTUS_ALLOW_LOOPBACK_HTTP_MCP = originalOptIn;
}

console.log('direct loopback request tests passed');
