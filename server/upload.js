// POST /api/upload?kind=photo|video|voice&name=...  raw body = file bytes
import { handler, requireSession, HttpError, tgMultipart, ensureGroup, fromTelegram, addEvent, notifyOthers, readBody } from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  const s = requireSession(req);
  const group = await ensureGroup(req);
  const kind = String(req.query.kind || '');
  const mime = String(req.headers['content-type'] || 'application/octet-stream');
  const buf = await readBody(req);
  if (!buf.length) throw new HttpError(400, 'empty');

  const ext = (mime.split('/')[1] || 'bin').split(';')[0].replace('x-', '').replace('quicktime', 'mov').replace('jpeg', 'jpg');
  const form = new FormData();
  form.append('chat_id', String(group));
  const blob = new Blob([buf], { type: mime });
  let method;
  if (kind === 'photo') { method = 'sendPhoto'; form.append('photo', blob, `photo.${ext}`); }
  else if (kind === 'video') { method = 'sendVideo'; form.append('video', blob, `video.${ext}`); form.append('supports_streaming', 'true'); }
  else if (kind === 'voice') {
    // Telegram only renders OGG/Opus, MP3 and M4A as voice notes; anything else goes as a file.
    if (/ogg|mpeg|mp4|m4a|aac/.test(mime)) { method = 'sendVoice'; form.append('voice', blob, `voice.${ext === 'mp4' ? 'm4a' : ext}`); }
    else { method = 'sendDocument'; form.append('document', blob, `voice.${ext}`); }
  } else throw new HttpError(400, 'kind');

  const sent = await tgMultipart(s.bot, method, form);
  const msg = fromTelegram(sent, s.bot, { role: s.role, name: s.name });
  if (kind === 'voice') { msg.kind = 'voice'; msg.mime = mime; }
  if (kind === 'photo' && msg.kind !== 'photo') msg.kind = 'photo';
  msg.cid = req.query.cid || null;
  const dur = parseFloat(req.query.dur);
  if (dur > 0) msg.dur = Math.round(dur);
  const ev = await addEvent(msg);
  await notifyOthers(ev);
  res.json(ev);
});
