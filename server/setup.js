// POST /api/setup (admin) — finds the group, points bot 1's webhook here, names the group.
import { handler, requireSession, HttpError, tg, redis, webhookSecret, getGroupId } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  if (requireSession(req).role !== 'admin') throw new HttpError(403, 'forbidden');
  const report = [];

  const [b1, b2] = await Promise.all([tg(1, 'getMe'), tg(2, 'getMe')]);
  report.push(`البوت الأول: @${b1.username}`, `البوت الثاني: @${b2.username}`);

  let group = await getGroupId();
  if (!group) {
    // Look through pending updates (only possible while no webhook is set).
    await tg(1, 'deleteWebhook', {});
    const ups = await tg(1, 'getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member'] });
    const chats = ups
      .map((u) => (u.message || u.my_chat_member)?.chat)
      .filter((c) => c && (c.type === 'group' || c.type === 'supergroup'));
    const last = chats[chats.length - 1];
    if (last) {
      group = String(last.id);
      await redis('SET', 'cfg:group', group);
    }
  }
  report.push(group ? `الگروب: ${group}` : 'ما لگيت الگروب بعد — اكتب أي رسالة بالگروب وبعدين سوّ الربط مرة ثانية');

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  await tg(1, 'setWebhook', {
    url: `https://${host}/api/webhook`,
    secret_token: webhookSecret(),
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
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
