// Single Vercel function for all /api/* routes (the Hobby plan allows at most 12 functions).
import login from '../server/login.js';
import logout from '../server/logout.js';
import me from '../server/me.js';
import messages from '../server/messages.js';
import send from '../server/send.js';
import upload from '../server/upload.js';
import file from '../server/file.js';
import webhook from '../server/webhook.js';
import stickers from '../server/stickers.js';
import push from '../server/push.js';
import del from '../server/delete.js';
import clear from '../server/clear.js';
import cron from '../server/cron.js';
import setup from '../server/setup.js';
import hide from '../server/hide.js';

const routes = { login, logout, me, messages, send, upload, file, webhook, stickers, push, delete: del, clear, cron, setup, hide };

export default function main(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  const name = String(req.query.r || path.replace(/^\/api\/?/, '')).split('/')[0];
  const route = Object.hasOwn(routes, name) ? routes[name] : null;
  if (!route) return res.status(404).json({ error: 'not found' });
  return route(req, res);
}
