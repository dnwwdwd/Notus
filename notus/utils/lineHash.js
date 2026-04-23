function normalizeHashValue(hash = '') {
  return String(hash || '').replace(/^#/, '').trim();
}

export function extractHashFromAsPath(asPath = '') {
  const value = String(asPath || '');
  const index = value.indexOf('#');
  return index === -1 ? '' : value.slice(index + 1);
}

export function parseLineHash(hash = '') {
  const normalized = normalizeHashValue(hash);
  const match = normalized.match(/^L(\d+)(?:-L?(\d+))?$/i);
  if (!match) return null;

  const lineStart = Number(match[1]);
  const lineEnd = Number(match[2] || match[1]);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd) || lineStart <= 0 || lineEnd < lineStart) {
    return null;
  }

  return { lineStart, lineEnd };
}

export function buildLineHash(lineStart, lineEnd) {
  const start = Number(lineStart);
  const end = Number(lineEnd);
  if (!Number.isFinite(start) || start <= 0) return '';
  if (!Number.isFinite(end) || end <= start) return `L${start}`;
  return `L${start}-L${end}`;
}

export function buildPathWithHash(pathname, query = {}, hash = '') {
  const params = new URLSearchParams();

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item === undefined || item === null || item === '') return;
        params.append(key, String(item));
      });
      return;
    }

    params.set(key, String(value));
  });

  const search = params.toString();
  const normalizedHash = normalizeHashValue(hash);
  return `${pathname}${search ? `?${search}` : ''}${normalizedHash ? `#${normalizedHash}` : ''}`;
}
