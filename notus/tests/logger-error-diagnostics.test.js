const assert = require('assert');
const { formatConsoleEntry } = require('../lib/logger');

const formatted = formatConsoleEntry({
  level: 'error',
  event: 'agent.task.failed',
  request_id: 'request-123',
  error: 'Prompt 模块超出预算：resources.external-materials',
  error_code: 'PROMPT_MODULE_BUDGET_EXCEEDED',
  error_name: 'Error',
  error_location: 'notus/lib/prompt/agent-loop/render.js:25:13',
  error_stack: 'Error: Prompt 模块超出预算\n    at render (/work/notus/lib/prompt/agent-loop/render.js:25:13)\nAuthorization: Bearer sk-abcdefghijklmnopqrstuvwxyz',
});

assert.ok(formatted.includes('PROMPT_MODULE_BUDGET_EXCEEDED'));
assert.ok(formatted.includes('notus/lib/prompt/agent-loop/render.js:25:13'));
assert.ok(formatted.includes('request-123'));
assert.ok(!formatted.includes('sk-abcdefghijklmnopqrstuvwxyz'), '控制台诊断不能输出密钥');
assert.ok(formatted.includes('[REDACTED]'));

const shortCredentialDiagnostic = formatConsoleEntry({
  event: 'verification.short-credential',
  error: 'Authorization: Bearer short-secret-123; password=hunter2; api_key=abc123',
  error_stack: `Error: upstream response\n${'日志条目;'.repeat(10_000)}`,
});
assert.ok(!shortCredentialDiagnostic.includes('short-secret-123'));
assert.ok(!shortCredentialDiagnostic.includes('hunter2'));
assert.ok(!shortCredentialDiagnostic.includes('abc123'));
assert.ok(shortCredentialDiagnostic.includes('[已截断超长错误诊断]'));

const jsonCredentialDiagnostic = formatConsoleEntry({
  event: 'verification.json-credential',
  error: '{"api_key":"abc123","password":"hunter2","authorization":"Bearer short-secret-123"}\nCookie: session=abc; preference=dark',
});
assert.ok(!jsonCredentialDiagnostic.includes('abc123'));
assert.ok(!jsonCredentialDiagnostic.includes('hunter2'));
assert.ok(!jsonCredentialDiagnostic.includes('short-secret-123'));
assert.ok(!jsonCredentialDiagnostic.includes('preference=dark'));

console.log('logger error diagnostics tests passed');
