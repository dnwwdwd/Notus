const assert = require('assert');
const { limitToolResult, runWithSignal, validateToolInput } = require('../lib/agentToolPolicy');
const { sanitizeRunEvent, sanitizeToolInputForLog } = require('../lib/agentSession');
const { publicNetworkLookup, publicWebUrl, summarizeInput } = require('../lib/agentTools');
const { parseUrl } = require('../lib/attachmentParsing');

async function run() {
  const definitions = [{
    name: 'read_file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, offset_line: { type: 'integer' }, line_limit: { type: 'integer' } },
      required: ['path'],
      additionalProperties: false,
    },
  }];
  assert.strictEqual(validateToolInput({ name: 'read_file', input: {} }, definitions).error, 'INVALID_TOOL_INPUT');
  assert.strictEqual(validateToolInput({ name: 'read_file', input: { path: 'a.md', offset_line: 10, line_limit: 20 } }, definitions).valid, true);

  const draft2020McpDefinition = [{
    name: 'mcp_execute_sql',
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
      additionalProperties: false,
    },
  }];
  assert.strictEqual(validateToolInput({ name: 'mcp_execute_sql', input: { sql: 'SELECT 1' } }, draft2020McpDefinition).valid, true);
  assert.strictEqual(validateToolInput({ name: 'mcp_execute_sql', input: {} }, draft2020McpDefinition).error, 'INVALID_TOOL_INPUT');

  const fetchWebUrlDefinition = [{
    name: 'fetch_web_url',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  }];
  assert.strictEqual(validateToolInput({ name: 'fetch_web_url', input: {} }, fetchWebUrlDefinition).error, 'INVALID_TOOL_INPUT');
  assert.strictEqual(validateToolInput({ name: 'fetch_web_url', input: { url: 'https://example.com/article' } }, fetchWebUrlDefinition).valid, true);

  assert.deepStrictEqual(
    sanitizeToolInputForLog('mcp_fetch_web_content', {
      endpoint: 'https://example.com/article?access_token=secret#section',
      Authorization: 'Bearer secret-value',
      request: 'cookie=session-secret',
    }),
    { endpoint: 'https://example.com/article', Authorization: '[REDACTED]', request: 'cookie=[REDACTED]' },
    '外部 MCP 持久化调用参数必须移除 URL 查询参数并脱敏认证字段'
  );
  assert.strictEqual((await publicWebUrl('http://127.0.0.1:3000/private')).error, 'URL_PRIVATE_NETWORK_BLOCKED');
  assert.strictEqual((await publicWebUrl('http://[::ffff:127.0.0.1]/private')).error, 'URL_PRIVATE_NETWORK_BLOCKED');
  assert.strictEqual((await publicWebUrl('https://user:pass@example.com/private')).error, 'URL_CREDENTIALS_BLOCKED');
  const privateLookupError = await new Promise((resolve) => publicNetworkLookup('127.0.0.1', {}, (error) => resolve(error)));
  assert.strictEqual(privateLookupError?.code, 'URL_PRIVATE_NETWORK_BLOCKED', '实际建连时必须再次拒绝私有网络地址');
  const timelineInput = summarizeInput({
    name: 'mcp_fetch_web_content',
    input: { endpoint: 'https://example.com/article?api_key=secret', request: 'Authorization: Bearer secret-value' },
  });
  assert.strictEqual(timelineInput.includes('?api_key='), false, '工具链参数摘要不能保留 URL 查询参数');
  assert.strictEqual(timelineInput.includes('secret-value'), false, '工具链参数摘要不能保留自由文本中的认证值');
  assert.strictEqual(limitToolResult('fetch_web_url', { content: '网页正文 '.repeat(32 * 1024) }).truncated, true, '网页读取结果必须使用专用大小上限');
  assert.strictEqual(
    sanitizeRunEvent({ type: 'progress', stage: 'tool_done', tool_name: 'mcp_internal_fetchWebContent', tool_display_name: 'fetchWebContent' }).tool_display_name,
    'fetchWebContent',
    '持久化工具事件必须保留 MCP 原始显示名'
  );

  const originalFetch = global.fetch;
  global.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  try {
    const redirected = await parseUrl('https://public.example/article', {
      validateUrl: async (candidate) => (candidate.includes('127.0.0.1')
        ? { error: 'URL_PRIVATE_NETWORK_BLOCKED', message: '不能读取本机或私有网络地址。' }
        : { url: candidate }),
    });
    assert.strictEqual(redirected.errorCode, 'URL_PRIVATE_NETWORK_BLOCKED', '重定向目标必须在请求前重新校验');
  } finally {
    global.fetch = originalFetch;
  }

  await assert.rejects(
    runWithSignal(() => new Promise(() => {}), { timeoutMs: 1_000, timeoutCode: 'MCP_TIMEOUT' }),
    (error) => error.code === 'MCP_TIMEOUT'
  );
  const controller = new AbortController();
  const pending = runWithSignal(() => new Promise(() => {}), { signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'ABORTED');
  console.log('agent tool policy tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
