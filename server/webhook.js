// Telegram → app. Only bot 1 has a webhook, so each group message is stored once.
import { handler, webhookSecret, redis, getGroupId, getOwner, OWNER_NAME, fromTelegram, addEvent, notifyOthers } from './_lib.js';

export default handler(async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret()) return res.status(401).end();
  const u = req.body || {};
  const m = u.message;
  if (!m) return res.json({ ok: true });

  let group = await getGroupId();
  if (m.migrate_to_chat_id && String(m.chat.id) === String(group)) {
    // group was upgraded to a supergroup: follow the new id
    await redis('SET', 'cfg:group', String(m.migrate_to_chat_id));
    return res.json({ ok: true });
  }
  if (!group && (m.chat.type === 'group' || m.chat.type === 'supergroup')) {
    await redis('SET', 'cfg:group', String(m.chat.id), 'NX');
    group = await getGroupId();
  }
  if (String(m.chat.id) !== String(group) || m.from?.is_bot) return res.json({ ok: true });

  const msg = fromTelegram(m, 1);
  if (msg) {
    const owner = await getOwner(group);
    if (owner && String(msg.from.uid) === owner) msg.from = { ...msg.from, name: OWNER_NAME, owner: true };
    const ev = await addEvent(msg);
    await notifyOthers(ev);
  }
  res.json({ ok: true });
});
