// POST /api/hide — clears the chat for the caller only; others keep their copy.
import { handler, requireSession, HttpError, redis } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  const s = requireSession(req);
  const seq = (await redis('GET', 'seq')) || '0';
  await redis('SET', `hide:${s.role}`, seq);
  res.json({ ok: true, hiddenUpTo: Number(seq) });
});
