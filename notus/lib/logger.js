const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readEnvConfig } = require('./config');
const { ensureError } = require('./errors');

const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LOG_PREFIX = 'notus';

function normalizeLevel(level) {
  const normalized = String(level || '').trim().toLowerCase();
  return LEVEL_PRIORITY[normalized] ? normalized : 'info';
}

function getLoggerConfig() {
  const config = readEnvConfig();
  return {
    logDir: config.logDir,
    logLevel: normalizeLevel(config.logLevel),
  };
}

function shouldWrite(level) {
  const { logLevel } = getLoggerConfig();
  return LEVEL_PRIORITY[normalizeLevel(level)] >= LEVEL_PRIORITY[logLevel];
}

function ensureLogDir() {
  const { logDir } = getLoggerConfig();
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function getLogFilePath(date = new Date()) {
  const filename = `${LOG_PREFIX}-${date.toISOString().slice(0, 10)}.log`;
  return path.join(ensureLogDir(), filename);
}

function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (depth > 4) return '[truncated]';
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const normalized = ensureError(value);
    return {
      name: normalized.name,
      message: normalized.message,
      code: normalized.code || null,
      stack: normalized.stack || null,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 80)
        .map(([key, item]) => [key, sanitizeValue(item, depth + 1, seen)])
        .filter(([, item]) => item !== undefined)
    );
  }
  return String(value);
}

function splitErrorFields(payload = {}) {
  if (!payload.error) return sanitizeValue(payload);

  const normalized = ensureError(payload.error);
  const next = sanitizeValue({ ...payload });
  delete next.error;

  next.error = normalized.message;
  next.error_code = normalized.code || null;
  next.error_name = normalized.name || 'Error';
  next.error_stack = normalized.stack || null;
  return next;
}

function writeEntry(entry) {
  if (!shouldWrite(entry.level)) return entry;

  try {
    fs.appendFileSync(getLogFilePath(new Date(entry.timestamp)), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (writeError) {
    const fallback = `[logger] write failed: ${writeError.message}\n`;
    process.stderr.write(fallback);
  }

  if (entry.level === 'warn') {
    console.warn(`[${entry.event}]`, entry.message || '', entry.request_id ? `request=${entry.request_id}` : '');
  }
  if (entry.level === 'error') {
    console.error(`[${entry.event}]`, entry.message || '', entry.request_id ? `request=${entry.request_id}` : '');
  }

  return entry;
}

function writeLog(level, event, payload = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: normalizeLevel(level),
    event,
    ...splitErrorFields(payload),
  };
  return writeEntry(entry);
}

function createLogger(baseContext = {}) {
  const context = sanitizeValue(baseContext) || {};

  return {
    child(extra = {}) {
      return createLogger({ ...context, ...sanitizeValue(extra) });
    },
    debug(event, payload = {}) {
      return writeLog('debug', event, { ...context, ...payload });
    },
    info(event, payload = {}) {
      return writeLog('info', event, { ...context, ...payload });
    },
    warn(event, payload = {}) {
      return writeLog('warn', event, { ...context, ...payload });
    },
    error(event, payload = {}) {
      return writeLog('error', event, { ...context, ...payload });
    },
  };
}

function createRequestContext(req, res, route) {
  const incoming = req?.headers?.['x-request-id'] || req?.headers?.['x-requestid'];
  const requestId = String(incoming || crypto.randomUUID());
  const context = {
    request_id: requestId,
    route,
    method: req?.method || '',
  };

  if (req) req.requestContext = context;
  if (res && !res.headersSent) res.setHeader('x-request-id', requestId);
  return context;
}

function parseLogLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function matchesFilters(entry, filters = {}) {
  if (!entry) return false;
  if (filters.level && entry.level !== filters.level) return false;
  if (filters.route && entry.route !== filters.route) return false;
  if (filters.event && entry.event !== filters.event) return false;
  if (filters.request_id && entry.request_id !== filters.request_id) return false;
  return true;
}

function readLogs(filters = {}) {
  const limit = Math.max(1, Math.min(Number(filters.limit) || 100, 500));
  const logDir = ensureLogDir();
  const files = fs.existsSync(logDir)
    ? fs.readdirSync(logDir)
      .filter((name) => name.startsWith(`${LOG_PREFIX}-`) && name.endsWith('.log'))
      .sort()
      .reverse()
    : [];

  const entries = [];
  for (const filename of files) {
    const content = fs.readFileSync(path.join(logDir, filename), 'utf8');
    const lines = content.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      const entry = parseLogLine(line);
      if (!matchesFilters(entry, filters)) continue;
      entries.push(entry);
      if (entries.length >= limit) return entries;
    }
  }

  return entries;
}

module.exports = {
  createLogger,
  createRequestContext,
  ensureLogDir,
  getLogFilePath,
  getLoggerConfig,
  readLogs,
};
