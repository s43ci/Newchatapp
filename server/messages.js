// GET /api/messages?after=<seq>&epoch=<n>  → new events since `after`, plus presence.
import { handler, requireSession, pipeline, ROLES, checkBridge } from './_lib.js';

export default handler(async (req, res) => {
  const s = requireSession(req);
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  const other = Object.keys(ROLES).find((r) => r !== s.role);

  // Older history, 100 messages at a time (scrolling up).
  if (req.query.before) {
    const before = parseInt(req.query.before, 10) || 0;
    const [items, hide] = await pipeline([
      ['ZREVRANGEBYSCORE', 'events', `(${before}`, '-inf', 'LIMIT', '0', '100'],
      ['GET', `hide:${s.role}`],
    ]);
    const hidden = parseInt(hide, 10) || 0;
    const events = (items || []).map((x) => JSON.parse(x)).filter((e) => e.type === 'msg' && e.seq > hidden).reverse();
    return res.json({ events, more: (items || []).length === 100 });
  }
  const range = after > 0
    ? ['ZRANGEBYSCORE', 'events', `(${after}`, '+inf', 'LIMIT', '0', '500']
    : ['ZRANGE', 'events', '-500', '-1'];
  const [epoch, items, , otherOnline, hide] = await pipeline([
    ['GET', 'epoch'],
    range,
    ['SET', `online:${s.role}`, Date.now(), 'EX', '12'],
    ['GET', `online:${other}`],
    ['GET', `hide:${s.role}`],
  ]);
  const ep = parseInt(epoch, 10) || 0;
  const reqEpoch = req.query.epoch != null ? parseInt(req.query.epoch, 10) : ep;
  let events = (items || []).map((x) => JSON.parse(x));
  let reset = after === 0;
  if (reqEpoch !== ep && after > 0) {
    // chat was cleared since the client last looked: send the full (new) history
    const all = await pipeline([['ZRANGE', 'events', '-500', '-1']]);
    events = (all[0] || []).map((x) => JSON.parse(x));
    reset = true;
  }
  // messages this account cleared from its own view
  const hiddenUpTo = parseInt(hide, 10) || 0;
  if (hiddenUpTo) events = events.filter((e) => e.type !== 'msg' || e.seq > hiddenUpTo);
  // the admin's app keeps the Telegram link healthy and surfaces what needs fixing
  let bridge = null;
  if (s.role === 'admin') {
    try { bridge = await checkBridge(req, req.query.check === '1'); }
    catch (e) { bridge = { problems: [`check:${e.message}`] }; }
  }
  res.json({ bridge, hiddenUpTo, epoch: ep, reset, events, online: !!otherOnline, otherName: ROLES[other].name });
});
