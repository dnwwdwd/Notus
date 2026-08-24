const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const { sha256 } = require('./files');

const RESULT_LIMITS = {
  read_file: 256 * 1024,
  load_skill: 128 * 1024,
  read_skill_file: 128 * 1024,
  search_knowledge: 96 * 1024,
  web_search: 64 * 1024,
  mcp: 64 * 1024,
};

const SECRET_KEY_PATTERN = /(authorization|cookie|token|secret|password|api[_-]?key|private[_-]?key)/i;
const HIGH_ENTROPY_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9+/=_-]{40,})\b/g;

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
const ajv2020 = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false });
const validators = new Map();

function validatorForSchema(schema = {}) {
  const metaSchema = String(schema?.$schema || '').trim().toLowerCase();
  return metaSchema.includes('/draft/2020-12/') ? ajv2020 : ajv;
}

function toolDefinitionMap(definitions = []) {
  return new Map((Array.isArray(definitions) ? definitions : []).map((item) => [String(item?.name || ''), item]));
}

function validateToolInput(toolUse = {}, definitions = []) {
  const definition = toolDefinitionMap(definitions).get(String(toolUse.name || ''));
  if (!definition) return { valid: false, error: 'UNKNOWN_TOOL', details: [] };
  const cacheKey = `${definition.name}:${sha256(JSON.stringify(definition.input_schema || {}))}`;
  let validator = validators.get(cacheKey);
  if (!validator) {
    validator = validatorForSchema(definition.input_schema).compile(definition.input_schema || { type: 'object' });
    validators.set(cacheKey, validator);
  }
  const valid = validator(toolUse.input || {});
  return {
    valid: Boolean(valid),
    error: valid ? null : 'INVALID_TOOL_INPUT',
    details: valid ? [] : (validator.errors || []).map((item) => ({
      path: item.instancePath || '/',
      keyword: item.keyword,
      message: item.message || '参数无效',
    })),
  };
}

function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') return value.replace(HIGH_ENTROPY_PATTERN, '[REDACTED]');
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => (
    SECRET_KEY_PATTERN.test(key) ? [key, '[REDACTED]'] : [key, redactSecrets(item, seen)]
  )));
}

function resultLimit(toolName, isMcp = false) {
  if (isMcp) return RESULT_LIMITS.mcp;
  return RESULT_LIMITS[toolName] || 256 * 1024;
}

function limitToolResult(toolName, value, { isMcp = false } = {}) {
  const redacted = redactSecrets(value);
  const limit = resultLimit(toolName, isMcp);
  const serialized = JSON.stringify(redacted ?? null);
  if (Buffer.byteLength(serialized, 'utf8') <= limit) return redacted;
  const summary = Buffer.from(serialized, 'utf8').subarray(0, limit).toString('utf8');
  return {
    truncated: true,
    result_bytes: Buffer.byteLength(serialized, 'utf8'),
    result_limit_bytes: limit,
    digest: sha256(serialized),
    stable_ref: String(redacted?.file_path || redacted?.path || redacted?.id || ''),
    summary,
  };
}

function runWithSignal(factory, { signal, timeoutMs = 30_000, timeoutCode = 'TOOL_TIMEOUT' } = {}) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('工具调用已取消'), { code: 'ABORTED' }));
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), Math.max(1000, Number(timeoutMs) || 30_000));
  const onAbort = () => timeoutController.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  return Promise.race([
    Promise.resolve().then(() => factory(timeoutController.signal)),
    new Promise((_, reject) => timeoutController.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error(signal?.aborted ? '工具调用已取消' : '工具调用超时'), {
        code: signal?.aborted ? 'ABORTED' : timeoutCode,
      }));
    }, { once: true })),
  ]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  });
}

module.exports = {
  RESULT_LIMITS,
  limitToolResult,
  redactSecrets,
  runWithSignal,
  validateToolInput,
};
