// POST /api/setup (admin) — finds the group, points bot 1's webhook here, names the group.
import { handler, requireSession, HttpError, tg, getGroupId, discoverGroup, setWebhook } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  if (requireSession(req).role !== 'admin') throw new HttpError(403, 'forbidden');
  const report = [];

  const [b1, b2] = await Promise.all([tg(1, 'getMe'), tg(2, 'getMe')]);
  report.push(`البوت الأول: @${b1.username}`, `البوت الثاني: @${b2.username}`);

  let group = await getGroupId();
  if (!group) group = await discoverGroup();
  report.push(group ? `الگروب: ${group}` : 'ما لگيت الگروب بعد — اكتب أي رسالة بالگروب وبعدين سوّ الربط مرة ثانية');

  await setWebhook(req);
  await tg(2, 'deleteWebhook', {}).catch(() => {});
  report.push('الويب هوك اشتغل ✓');

  if (group) {
    try { await tg(1, 'setChatTitle', { chat_id: group, title: 'محادثة 1' }); report.push('اسم الگروب: محادثة 1 ✓'); }
    catch (e) { report.push(`ما گدرت أغير اسم الگروب (البوت الأول لازم يكون أدمن): ${e.message}`); }
    try {
      const m = await tg(1, 'getChatMember', { chat_id: group, user_id: b1.id });
      if (m.status !== 'administrator') report.push('⚠️ خلي البوت الأول أدمن بالگروب حتى يشوف كل الرسائل ويكدر يمسحها');
    } catch {}
    try { await tg(2, 'getChatMember', { chat_id: group, user_id: b2.id }); }
    catch { report.push('⚠️ البوت الثاني مو بالگروب — ضيفه'); }
  }
  res.json({ ok: true, group, report });
});
