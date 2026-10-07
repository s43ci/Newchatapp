// POST /api/owner { uid } (admin) — marks which Telegram account is the app owner.
import { handler, requireSession, HttpError, redis } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  if (requireSession(req).role !== 'admin') throw new HttpError(403, 'forbidden');
  const uid = parseInt(req.body?.uid, 10);
  if (!uid) throw new HttpError(400, 'uid');
  await redis('SET', 'cfg:owner', String(uid));
  res.json({ ok: true });
});
