// POST /api/send  JSON: { text } | { sticker: { file, set, fmt, emoji } }
import { handler, requireSession, HttpError, tg, ensureGroup, fromTelegram, addEvent, notifyOthers, findMessage, replySnapshot, replyParams } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  const s = requireSession(req);
  const group = await ensureGroup(req);
  const body = req.body || {};
  const sender = { role: s.role, name: s.name };
  const orig = body.replyTo ? await findMessage(parseInt(body.replyTo, 10)) : null;
  const reply = orig?.type === 'msg' ? replyParams(orig, group) : null;
  const extra = reply ? { reply_parameters: reply } : {};
  let sent;
  if (body.sticker?.file) {
    sent = await tg(s.bot, 'sendSticker', { chat_id: group, sticker: body.sticker.file, ...extra });
  } else {
    const text = String(body.text || '').slice(0, 4000);
    if (!text.trim()) throw new HttpError(400, 'empty');
    sent = await tg(s.bot, 'sendMessage', { chat_id: group, text, ...extra });
  }
  const msg = fromTelegram(sent, s.bot, sender);
  if (msg.kind === 'sticker' && body.sticker?.set) msg.set = body.sticker.set;
  msg.cid = body.cid || null;
  if (orig?.type === 'msg') msg.reply = replySnapshot(orig);
  const ev = await addEvent(msg);
  await notifyOthers(ev);
  res.json(ev);
});
