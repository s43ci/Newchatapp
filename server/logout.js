import { handler } from './_lib.js';

export default handler(async (req, res) => {
  res.setHeader('Set-Cookie', 's=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  res.json({ ok: true });
});
