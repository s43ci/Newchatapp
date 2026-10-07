// Daily wipe (see vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET` when it is set.
import { handler, HttpError, clearAll } from './_lib.js';

export default handler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const ok = secret
    ? req.headers.authorization === `Bearer ${secret}`
    : /vercel-cron/.test(req.headers['user-agent'] || '');
  if (!ok) throw new HttpError(401, 'unauthorized');
  await clearAll();
  res.json({ ok: true, cleared: new Date().toISOString() });
});
