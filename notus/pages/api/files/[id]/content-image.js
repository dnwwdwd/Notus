const fs = require('fs');
const { ensureRuntime } = require('../../../../lib/runtime');
const { ensureImageAvailableForRequest } = require('../../../../lib/images');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { id, src } = req.query || {};
  if (!src) return res.status(400).json({ error: 'src is required', code: 'SRC_REQUIRED' });

  try {
    const cache = await ensureImageAvailableForRequest(id, src);
    res.setHeader('Content-Type', cache.mimeType || 'image/*');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    return fs.createReadStream(cache.absolutePath).pipe(res);
  } catch (error) {
    if (error.message === 'File not found') {
      return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
    }
    if (/只允许|不允许|无效|不是图片/.test(error.message)) {
      return res.status(400).json({ error: error.message, code: 'INVALID_IMAGE_SOURCE' });
    }
    return res.redirect(307, String(src));
  }
}
