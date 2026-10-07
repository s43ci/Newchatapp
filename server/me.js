import { handler, requireSession, vapidPublicKey } from './_lib.js';

export default handler(async (req, res) => {
  const s = requireSession(req);
  let vapid = null;
  try { vapid = await vapidPublicKey(); } catch {}
  res.json({ role: s.role, name: s.name, vapid });
});
