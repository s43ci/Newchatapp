// Sticker packs saved per account. File ids are bot-specific, so each account
// loads packs through its own bot.
import { handler, requireSession, HttpError, tg, pipeline, redis } from './_lib.js';

async function loadSet(bot, name) {
  const key = `set:${bot}:${name}`;
  const cached = await redis('GET', key);
  if (cached) return JSON.parse(cached);
  const s = await tg(bot, 'getStickerSet', { name });
  const set = {
    name: s.name,
    title: s.title,
    stickers: s.stickers.map((x) => ({
      file: x.file_id,
      thumb: x.thumbnail?.file_id || null,
      fmt: x.is_animated ? 'tgs' : x.is_video ? 'webm' : 'webp',
      emoji: x.emoji || '',
    })),
  };
  await redis('SET', key, JSON.stringify(set), 'EX', 86400);
  return set;
}

export default handler(async (req, res) => {
  const s = requireSession(req);
  const listKey = `packs:${s.role}`;

  if (req.method === 'GET') {
    if (req.query.name) return res.json(await loadSet(s.bot, String(req.query.name)));
    const names = (await redis('LRANGE', listKey, 0, -1)) || [];
    const sets = [];
    for (const n of names) {
      try { sets.push(await loadSet(s.bot, n)); } catch { /* pack deleted on Telegram */ }
    }
    return res.json({ sets });
  }

  if (req.method === 'POST') {
    const { action, name } = req.body || {};
    if (!name || !/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new HttpError(400, 'name');
    if (action === 'add') {
      const set = await loadSet(s.bot, name);
      await pipeline([['LREM', listKey, 0, name], ['LPUSH', listKey, name]]);
      return res.json(set);
    }
    if (action === 'remove') {
      await redis('LREM', listKey, 0, name);
      return res.json({ ok: true });
    }
  }
  throw new HttpError(400, 'bad request');
});
