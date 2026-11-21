// POST /api/upload?kind=photo|video|voice|file&name=...  raw body = file bytes.
// Files over Vercel's 4.5 MB request limit come in parts:
//   POST ?up=<id>&part=<n>  (body = part)  … then  POST ?up=<id>&final=1&parts=<N>&mime=…&kind=…
import { handler, requireSession, HttpError, tgMultipart, ensureGroup, fromTelegram, addEvent, notifyOthers, readBody, findMessage, replySnapshot, replyParams, redis, pipeline } from './_lib.js';

// Telegram bots can only download files up to 20 MB, so larger ones could never be opened.
export const MAX_FILE = 20 * 1024 * 1024;
const MAX_PARTS = 40;

// Stores one part, or joins all parts on the final call. Returns null for a stored part.
async function chunked(req, role) {
  const id = String(req.query.up);
  if (!/^[a-z0-9]{8,40}$/.test(id)) throw new HttpError(400, 'upload id');
  const key = (n) => `up:${role}:${id}:${n}`;
  if (req.query.final !== '1') {
    const part = parseInt(req.query.part, 10);
    if (!(part >= 0 && part < MAX_PARTS)) throw new HttpError(400, 'part');
    const chunk = await readBody(req);
    await redis('SET', key(part), chunk.toString('base64'), 'EX', 900);
    return null;
  }
  const parts = parseInt(req.query.parts, 10);
  if (!(parts > 0 && parts <= MAX_PARTS)) throw new HttpError(400, 'parts');
  const bufs = [];
  let total = 0;
  for (let i = 0; i < parts; i++) {
    const b64 = await redis('GET', key(i));
    if (!b64) throw new HttpError(400, 'missing part');
    const b = Buffer.from(b64, 'base64');
    total += b.length;
    if (total > MAX_FILE) throw new HttpError(413, 'too large');
    bufs.push(b);
  }
  await pipeline(Array.from({ length: parts }, (_, i) => ['DEL', key(i)]));
  return Buffer.concat(bufs);
}

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method');
  const s = requireSession(req);
  let buf, mime;
  if (req.query.up) {
    buf = await chunked(req, s.role);
    if (!buf) return res.json({ ok: true }); // part stored; wait for the rest
    mime = String(req.query.mime || 'application/octet-stream');
  } else {
    mime = String(req.headers['content-type'] || 'application/octet-stream');
    buf = await readBody(req);
  }
  if (!buf.length) throw new HttpError(400, 'empty');
  const group = await ensureGroup(req);
  const kind = String(req.query.kind || '');

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
