import { handler, codesMatch, makeSession, HttpError, ROLES } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  const code = String(req.body?.code || '').trim();
  let role = null;
  if (codesMatch(code, process.env.ADMIN_CODE)) role = 'admin';
  else if (codesMatch(code, process.env.USER_CODE)) role = 'user';
  if (!role) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    throw new HttpError(401, 'wrong code');
  }
  const maxAge = 60 * 60 * 24 * 365;
  res.setHeader('Set-Cookie', `s=${makeSession(role)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`);
  res.json({ role, ...ROLES[role] });
});
