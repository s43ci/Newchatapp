// POST /api/delete { id } — remove one message (own messages; admin may remove any).
import { handler, requireSession, HttpError, findMessage, redis, addEvent, deleteTelegramMessages } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  const s = requireSession(req);
  const id = parseInt(req.body?.id, 10);
  const msg = id ? await findMessage(id) : null;
  if (!msg || msg.type !== 'msg') throw new HttpError(404, 'not found');
  if (s.role !== 'admin' && msg.from.role !== s.role) throw new HttpError(403, 'forbidden');
  await redis('ZREMRANGEBYSCORE', 'events', id, id);
  await addEvent({ type: 'del', id });
  if (msg.tg) await deleteTelegramMessages([msg.tg]);
  res.json({ ok: true });
});
