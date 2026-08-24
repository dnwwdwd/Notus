const assert = require('assert');
const { runWithSignal, validateToolInput } = require('../lib/agentToolPolicy');

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
