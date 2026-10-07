// Shared helpers: Redis (Upstash REST), Telegram Bot API, sessions, push.
import crypto from 'node:crypto';
import webpush from 'web-push';

const env = process.env;

// ---------- config ----------
export const ROLES = {
  admin: { name: 'مجهول 1', bot: 1 },
  user: { name: 'مجهول 2', bot: 2 },
};

export function botToken(n) {
  const t = n === 2 ? env.BOT2_TOKEN : env.BOT1_TOKEN;
  if (!t) throw new HttpError(500, `BOT${n === 2 ? 2 : 1}_TOKEN is not set`);
  return t;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const secret = () => env.SESSION_SECRET || sha(`ab-ai:${env.BOT1_TOKEN}:${env.BOT2_TOKEN}:${env.ADMIN_CODE}:${env.USER_CODE}`);
export const webhookSecret = () => sha(`wh:${secret()}`).slice(0, 48);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- redis ----------
// Vercel's storage integration may add a custom prefix (e.g. STORAGE_KV_REST_API_URL).
const envBySuffix = (...suffixes) => {
  for (const suf of suffixes) {
    if (env[suf]) return env[suf];
    const k = Object.keys(env).find((x) => x.endsWith(`_${suf}`) && env[x]);
    if (k) return env[k];
  }
  return undefined;
};
const R_URL = envBySuffix('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const R_TOKEN = envBySuffix('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');

export async function redis(...cmd) {
  const [r] = await pipeline([cmd]);
  return r;
}

export async function pipeline(cmds) {
  if (!R_URL || !R_TOKEN) throw new HttpError(500, 'Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)');
  const res = await fetch(`${R_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
  });
  if (!res.ok) throw new HttpError(502, `Redis error ${res.status}`);
  const out = await res.json();
  return out.map((x) => {
    if (x.error) throw new HttpError(502, `Redis: ${x.error}`);
    return x.result;
  });
}

export async function getGroupId() {
  return env.GROUP_CHAT_ID || (await redis('GET', 'cfg:group'));
}

// Finds the group from bot 1's pending updates (only readable while no webhook is set).
export async function discoverGroup() {
  await tg(1, 'deleteWebhook', {});
  const ups = await tg(1, 'getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member'] });
  const chats = ups
    .map((u) => (u.message || u.my_chat_member)?.chat)
    .filter((c) => c && (c.type === 'group' || c.type === 'supergroup'));
  const last = chats[chats.length - 1];
  if (!last) return null;
  await redis('SET', 'cfg:group', String(last.id));
  return String(last.id);
}

export async function setWebhook(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  await tg(1, 'setWebhook', {
    url: `https://${host}/api/webhook`,
    secret_token: webhookSecret(),
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
}

// The app owner's own Telegram account shows as OWNER_NAME instead of their real name.
export const OWNER_NAME = env.OWNER_NAME || 'AB';

// Owner = whoever the admin marked in the app, otherwise the group's creator.
export async function getOwner(group) {
  const saved = await redis('GET', 'cfg:owner');
  if (saved) return saved === '0' ? null : saved;
  let id = '0';
  try {
    const admins = await tg(1, 'getChatAdministrators', { chat_id: group });
    const creator = admins.find((a) => a.status === 'creator' && !a.is_anonymous);
    if (creator) id = String(creator.user.id);
  } catch { return null; } // try again next time
  await redis('SET', 'cfg:owner', id, 'NX');
  return id === '0' ? null : id;
}

// Used by send/upload: links the group on first use if the admin never ran setup.
export async function ensureGroup(req) {
  let group = await getGroupId();
  if (group) return group;
  group = await discoverGroup();
  await setWebhook(req);
  if (!group) throw new HttpError(409, 'not set up');
  return group;
}

// ---------- events (messages + deletions) ----------
// Every change gets a sequence number; clients poll for events after their last seq.
export async function addEvent(ev) {
  const seq = await redis('INCR', 'seq');
  ev.seq = seq;
  const cmds = [['ZADD', 'events', seq, JSON.stringify(ev)]];
  if (ev.type === 'msg' && ev.tg) cmds.push(['RPUSH', 'tgmsgs', JSON.stringify(ev.tg)]);
  await pipeline(cmds);
  return ev;
}

export async function findMessage(id) {
  const all = await redis('ZRANGEBYSCORE', 'events', id, id);
  return all && all[0] ? JSON.parse(all[0]) : null;
}

// ---------- telegram ----------
export async function tg(bot, method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${botToken(bot)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new HttpError(502, `Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

export async function tgMultipart(bot, method, form) {
  const res = await fetch(`https://api.telegram.org/bot${botToken(bot)}/${method}`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new HttpError(502, `Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// Convert a Telegram message into our stored message shape.
export function fromTelegram(m, bot, sender) {
  const base = {
    type: 'msg',
    from: sender || { role: 'tg', uid: m.from?.id || null, name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || 'تيليجرام' },
    ts: (m.date || Math.floor(Date.now() / 1000)) * 1000,
    bot,
    tg: { chat: m.chat.id, id: m.message_id, bot },
    text: m.text || m.caption || '',
  };
  if (m.reply_to_message) base.replyTg = m.reply_to_message.message_id;
  if (m.sticker) {
    const s = m.sticker;
    return { ...base, kind: 'sticker', file: s.file_id, uid: s.file_unique_id, set: s.set_name || null,
      fmt: s.is_animated ? 'tgs' : s.is_video ? 'webm' : 'webp', emoji: s.emoji || '' };
  }
  if (m.photo) {
    const p = m.photo[m.photo.length - 1];
    return { ...base, kind: 'photo', file: p.file_id, w: p.width, h: p.height };
  }
  if (m.video) return { ...base, kind: 'video', file: m.video.file_id, w: m.video.width, h: m.video.height, dur: m.video.duration, mime: m.video.mime_type };
  if (m.animation) return { ...base, kind: 'video', gif: true, file: m.animation.file_id, w: m.animation.width, h: m.animation.height, mime: m.animation.mime_type };
  if (m.video_note) return { ...base, kind: 'video', round: true, file: m.video_note.file_id, w: m.video_note.length, h: m.video_note.length, dur: m.video_note.duration };
  if (m.voice) return { ...base, kind: 'voice', file: m.voice.file_id, dur: m.voice.duration, mime: m.voice.mime_type };
  if (m.audio) return { ...base, kind: 'voice', file: m.audio.file_id, dur: m.audio.duration, mime: m.audio.mime_type, title: m.audio.title || m.audio.file_name || '' };
  if (m.document) {
    const d = m.document;
    if (/^voice\./.test(d.file_name || '') || /^audio\//.test(d.mime_type || '')) return { ...base, kind: 'voice', file: d.file_id, mime: d.mime_type };
    if (/^image\//.test(d.mime_type || '')) return { ...base, kind: 'photo', file: d.file_id };
    if (/^video\//.test(d.mime_type || '')) return { ...base, kind: 'video', file: d.file_id, mime: d.mime_type };
    return { ...base, kind: 'file', file: d.file_id, name: d.file_name || 'ملف' };
  }
  if (m.text != null || m.caption != null) return { ...base, kind: 'text' };
  return null;
}

// ---------- http helpers ----------
export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function makeSession(role) {
  const payload = Buffer.from(JSON.stringify({ role, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(req) {
  const raw = parseCookies(req).s;
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const { role } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return ROLES[role] ? { role, ...ROLES[role] } : null;
  } catch { return null; }
}

export function requireSession(req) {
  const s = readSession(req);
  if (!s) throw new HttpError(401, 'unauthorized');
  return s;
}

export function codesMatch(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
}

export function handler(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) res.status(status).json({ error: e.message || 'error' });
      else res.end();
    }
  };
}

export async function readBody(req, limit = 4.4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ---------- web push ----------
async function vapid() {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const saved = await redis('GET', 'cfg:vapid');
  if (saved) return JSON.parse(saved);
  const keys = webpush.generateVAPIDKeys();
  // NX so two concurrent first calls agree on one key pair
  await redis('SET', 'cfg:vapid', JSON.stringify(keys), 'NX');
  return JSON.parse(await redis('GET', 'cfg:vapid'));
}

export async function vapidPublicKey() {
  return (await vapid()).publicKey;
}

export async function notify(roles, payload) {
  try {
    const keys = await vapid();
    webpush.setVapidDetails('mailto:noreply@ab-ai.app', keys.publicKey, keys.privateKey);
    const lists = await pipeline(roles.map((r) => ['HGETALL', `push:${r}`]));
    const jobs = [];
    lists.forEach((flat, i) => {
      for (let j = 0; j < (flat || []).length; j += 2) {
        const id = flat[j];
        const sub = JSON.parse(flat[j + 1]);
        jobs.push(
          webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }).catch(async (err) => {
            if (err.statusCode === 404 || err.statusCode === 410) await redis('HDEL', `push:${roles[i]}`, id);
          }),
        );
      }
    });
    await Promise.all(jobs);
  } catch (e) {
    console.error('push failed', e);
  }
}

export function previewText(m) {
  return m.kind === 'text' ? m.text.slice(0, 80)
    : m.kind === 'photo' ? '📷 صورة'
    : m.kind === 'video' ? '🎬 فيديو'
    : m.kind === 'voice' ? '🎤 رسالة صوتية'
    : m.kind === 'sticker' ? `${m.emoji || ''} ملصق`
    : '📎 ملف';
}

// Notify everyone except the sender.
export function notifyOthers(msg) {
  const roles = Object.keys(ROLES).filter((r) => r !== msg.from.role);
  return notify(roles, { title: msg.from.name, body: previewText(msg), tag: 'chat' });
}

// ---------- clearing ----------
export async function deleteTelegramMessages(list) {
  const byKey = new Map();
  for (const t of list) {
    const key = `${t.bot}:${t.chat}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t.id);
  }
  for (const [key, ids] of byKey) {
    const [bot, chat] = key.split(':');
    for (let i = 0; i < ids.length; i += 100) {
      await tg(Number(bot), 'deleteMessages', { chat_id: chat, message_ids: ids.slice(i, i + 100) }).catch((e) => console.error(e.message));
    }
  }
}

export async function clearAll() {
  const raw = (await redis('LRANGE', 'tgmsgs', 0, -1)) || [];
  await pipeline([['DEL', 'events'], ['DEL', 'tgmsgs'], ['INCR', 'epoch']]);
  // Messages from Telegram users can only be removed by an admin bot (bot 1).
  await deleteTelegramMessages(raw.map((x) => JSON.parse(x)));
}
