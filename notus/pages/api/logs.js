const { createAppError, ensureError } = require('../../lib/errors');
const { createLogger, createRequestContext, readLogs } = require('../../lib/logger');
const { getEffectiveConfig } = require('../../lib/config');
const { ensureRuntime } = require('../../lib/runtime');

function isLoopback(req) {
  const check = (address) => address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';
  const socketAddress = String(req.socket?.remoteAddress || '');
  if (!check(socketAddress)) return false;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((item) => item.trim()).filter(Boolean);
  return forwarded.length === 0 || forwarded.every(check);
}

function hasDiagnosticsToken(req, expected) {
  if (!expected) return false;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const provided = String(req.headers['x-notus-diagnostics-token'] || bearer);
  return provided.length === expected.length && require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/logs');
  const logger = createLogger(context);

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed',
      code: 'METHOD_NOT_ALLOWED',
      request_id: context.request_id,
    });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: '日志服务初始化失败', code: 'RUNTIME_ERROR', request_id: context.request_id });
  const diagnosticsToken = getEffectiveConfig().diagnosticsToken;
  if (!isLoopback(req) && !hasDiagnosticsToken(req, diagnosticsToken)) {
    return res.status(403).json({ error: '远程诊断未授权', code: 'DIAGNOSTICS_FORBIDDEN', request_id: context.request_id });
  }

  try {
    const limit = Number(req.query.limit || 100);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw createAppError('INVALID_LIMIT', 'limit 必须是正整数');
    }

    const entries = readLogs({
      level: req.query.level || undefined,
      route: req.query.route || undefined,
      event: req.query.event || undefined,
      request_id: req.query.request_id || undefined,
      limit,
    });

    logger.info('logs.query', {
      query_level: req.query.level || null,
      query_route: req.query.route || null,
      query_event: req.query.event || null,
      limit: entries.length,
    });

    return res.status(200).json({
      items: entries,
      total: entries.length,
      request_id: context.request_id,
    });
  } catch (error) {
    const normalized = ensureError(error, 'LOG_QUERY_FAILED', '读取日志失败');
    logger.error('logs.query.failed', { error: normalized });
    return res.status(400).json({
      error: normalized.message,
      code: normalized.code || 'LOG_QUERY_FAILED',
      request_id: context.request_id,
    });
  }
}
