import crypto from 'node:crypto';
import { handler, requireSession, HttpError, redis } from './_lib.js';

export default handler(async (req, res) => {
  const s = requireSession(req);
  const sub = req.body?.subscription;
  if (!sub?.endpoint) throw new HttpError(400, 'subscription');
  const id = crypto.createHash('sha1').update(sub.endpoint).digest('hex');
  if (req.method === 'POST') await redis('HSET', `push:${s.role}`, id, JSON.stringify(sub));
  else if (req.method === 'DELETE') await redis('HDEL', `push:${s.role}`, id);
  else throw new HttpError(405, 'method');
  res.json({ ok: true });
});
