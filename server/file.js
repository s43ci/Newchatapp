// GET /api/file?b=<bot>&f=<file_id> → streams the Telegram file without exposing the bot token.
import { Readable } from 'node:stream';
import { handler, requireSession, HttpError, tg, botToken, redis } from './_lib.js';

export default handler(async (req, res) => {
  requireSession(req);
  const bot = req.query.b === '2' ? 2 : 1;
  const fileId = String(req.query.f || '');
  if (!fileId) throw new HttpError(400, 'file');

  const cacheKey = `fp:${bot}:${fileId}`;
  let path = await redis('GET', cacheKey);
  if (!path) {
    const f = await tg(bot, 'getFile', { file_id: fileId });
    path = f.file_path;
    await redis('SET', cacheKey, path, 'EX', 3000); // Telegram links are valid ≥1h
  }
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const up = await fetch(`https://api.telegram.org/file/bot${botToken(bot)}/${path}`, { headers });
  if (!up.ok && up.status !== 206) throw new HttpError(up.status === 404 ? 404 : 502, 'file unavailable');

  res.status(up.status);
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  const lower = path.toLowerCase();
  const type = lower.endsWith('.webp') ? 'image/webp'
    : lower.endsWith('.webm') ? 'video/webm'
    : lower.endsWith('.tgs') ? 'application/x-tgsticker'
    : lower.endsWith('.oga') || lower.endsWith('.ogg') ? 'audio/ogg'
    : lower.endsWith('.mp4') ? 'video/mp4'
    : lower.endsWith('.mov') ? 'video/quicktime'
    : lower.endsWith('.m4a') ? 'audio/mp4'
    : lower.endsWith('.mp3') ? 'audio/mpeg'
    : lower.endsWith('.png') ? 'image/png'
    : lower.match(/\.jpe?g$/) ? 'image/jpeg'
    : up.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (req.query.dl === '1') {
    // download with the original file name (Arabic names included)
    const name = String(req.query.name || path.split('/').pop() || 'file').replace(/[\r\n"]/g, '_');
    // plain-ASCII fallback keeps the extension; filename* carries the real (Arabic) name
    const ascii = name.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
    const ext = (name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
    const fallback = ascii && ascii !== ext ? ascii : `file${ext}`;
    res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
  } else res.setHeader('Content-Disposition', 'inline');
  Readable.fromWeb(up.body).pipe(res);
});
