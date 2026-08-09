const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY_IN_MS = 24 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

function parseMessageTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value || '').trim();
  if (!raw) return null;

  // SQLite 的 datetime('now') 保存 UTC 但不带时区，解析时补 Z，避免浏览器将其
  // 当成本地时间而产生八小时偏移。
  const sqliteUtc = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
  const parsed = new Date(sqliteUtc ? `${sqliteUtc[1]}T${sqliteUtc[2]}${sqliteUtc[3] || ''}Z` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatFullTimestamp(value, { timeZone = 'Asia/Shanghai' } = {}) {
  const timestamp = parseMessageTimestamp(value);
  if (!timestamp) return value ? String(value) : '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp).replace(/\//g, '-');
}

function formatMessageTimestamp(value, { now = new Date() } = {}) {
  const createdAt = parseMessageTimestamp(value);
  const reference = parseMessageTimestamp(now);
  if (!createdAt || !reference) return '';

  const time = `${pad(createdAt.getHours())}:${pad(createdAt.getMinutes())}`;
  const createdDay = new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate()).getTime();
  const referenceDay = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime();
  const dayDistance = Math.floor((referenceDay - createdDay) / DAY_IN_MS);
  if (dayDistance === 0) return time;
  if (dayDistance === 1) return `昨天 ${time}`;
  if (dayDistance > 0 && dayDistance < 7) return `${WEEKDAY_LABELS[createdAt.getDay()]} ${time}`;
  return `${createdAt.getFullYear()}-${pad(createdAt.getMonth() + 1)}-${pad(createdAt.getDate())} ${time}`;
}

module.exports = {
  formatFullTimestamp,
  formatMessageTimestamp,
  parseMessageTimestamp,
};
