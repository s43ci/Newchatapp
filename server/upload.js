// POST /api/upload?kind=photo|video|voice&name=...  raw body = file bytes
import { handler, requireSession, HttpError, tgMultipart, ensureGroup, fromTelegram, addEvent, notifyOthers, readBody, findMessage, replySnapshot, replyParams } from './_lib.js';

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
  const orig = req.query.replyTo ? await findMessage(parseInt(req.query.replyTo, 10)) : null;
  const reply = orig?.type === 'msg' ? replyParams(orig, group) : null;
  if (reply) form.append('reply_parameters', JSON.stringify(reply));
  const blob = new Blob([buf], { type: mime });
  let method;
  if (kind === 'photo') { method = 'sendPhoto'; form.append('photo', blob, `photo.${ext}`); }
  else if (kind === 'video') { method = 'sendVideo'; form.append('video', blob, `video.${ext}`); form.append('supports_streaming', 'true'); }
  else if (kind === 'voice') {
    // Telegram only renders OGG/Opus, MP3 and M4A as voice notes; anything else goes as a file.
    if (/ogg|mpeg|mp4|m4a|aac/.test(mime)) { method = 'sendVoice'; form.append('voice', blob, `voice.${ext === 'mp4' ? 'm4a' : ext}`); }
    else { method = 'sendDocument'; form.append('document', blob, `voice.${ext}`); }
  } else if (kind === 'file') {
    // documents keep their real name so they download as e.g. report.docx
    const name = String(req.query.name || 'file').replace(/[\\/\r\n"]/g, '_').slice(0, 120) || 'file';
    method = 'sendDocument';
    form.append('document', blob, name);
  } else throw new HttpError(400, 'kind');

  const sent = await tgMultipart(s.bot, method, form);
  const msg = fromTelegram(sent, s.bot, { role: s.role, name: s.name });
  if (kind === 'voice') { msg.kind = 'voice'; msg.mime = mime; }
  if (kind === 'photo' && msg.kind !== 'photo') msg.kind = 'photo';
  if (kind === 'file') { msg.kind = 'file'; msg.name = String(req.query.name || msg.name || 'file'); msg.size = buf.length; }
  msg.cid = req.query.cid || null;
  if (orig?.type === 'msg') msg.reply = replySnapshot(orig);
  const dur = parseFloat(req.query.dur);
  if (dur > 0) msg.dur = Math.round(dur);
  const ev = await addEvent(msg);
  await notifyOthers(ev);
  res.json(ev);
});
