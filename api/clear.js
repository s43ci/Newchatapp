import { handler, requireSession, HttpError, clearAll } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  if (requireSession(req).role !== 'admin') throw new HttpError(403, 'forbidden');
  await clearAll();
  res.json({ ok: true });
});
