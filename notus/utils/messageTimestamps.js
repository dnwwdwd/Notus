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

function getCalendarParts(value, timeZone) {
  if (!timeZone) {
    return {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
      hour: value.getHours(),
      minute: value.getMinutes(),
      weekday: value.getDay(),
    };
  }

  const values = Object.create(null);
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value).forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });

  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday);
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday,
  };
}

function formatMessageTimestamp(value, { now = new Date(), timeZone } = {}) {
  const createdAt = parseMessageTimestamp(value);
  const reference = parseMessageTimestamp(now);
  if (!createdAt || !reference) return '';

  const created = getCalendarParts(createdAt, timeZone);
  const current = getCalendarParts(reference, timeZone);
  const time = `${pad(created.hour)}:${pad(created.minute)}`;
  const createdDay = Date.UTC(created.year, created.month - 1, created.day);
  const referenceDay = Date.UTC(current.year, current.month - 1, current.day);
  const dayDistance = Math.floor((referenceDay - createdDay) / DAY_IN_MS);
  if (dayDistance === 0) return time;
  if (dayDistance === 1) return `昨天 ${time}`;
  if (dayDistance > 0 && dayDistance < 7) return `${WEEKDAY_LABELS[created.weekday]} ${time}`;
  return `${created.year}-${pad(created.month)}-${pad(created.day)} ${time}`;
}

module.exports = {
  formatFullTimestamp,
  formatMessageTimestamp,
  parseMessageTimestamp,
};
