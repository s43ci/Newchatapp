'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const CACHE_KEY = 'abai:v1';
  const MAX_UPLOAD = 4.3 * 1024 * 1024; // Vercel request body limit is 4.5 MB
  const POLL_MS = 1200;

  const state = {
    me: null,
    vapid: null,
    epoch: null,
    lastSeq: 0,
    msgs: new Map(), // seq -> message
    pending: new Map(), // cid -> { node, data }
    polling: false,
    pollTimer: null,
    packs: [],
    packsLoaded: false,
    activePack: 0,
    online: false,
    owner: null,
    ownerName: 'AB',
  };

  // ---------------------------------------------------------------- utils
  const fmtTime = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { hour: 'numeric', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { day: 'numeric', month: 'long' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  const fileUrl = (m, id = m.file) => `/api/file?b=${m.bot || 1}&f=${encodeURIComponent(id)}`;
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const dayKey = (ts) => new Date(ts).toDateString();
  const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  async function api(path, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.json);
    }
    let res;
    try { res = await fetch(path, init); }
    catch (e) { const err = new Error('network'); err.status = 0; if (e.name === 'AbortError') throw e; throw err; }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function show(screen) {
    for (const id of ['splash', 'login', 'chat']) $(id).classList.toggle('hidden', id !== screen);
  }

  // ---------------------------------------------------------------- protection
  // Block zoom, selection, copying, saving and context menus everywhere except the text box.
  const editable = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd < 300 && !editable(e.target)) e.preventDefault(); // double-tap zoom
    lastTouchEnd = now;
  }, { passive: false });
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (!editable(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('selectstart', (e) => { if (!editable(e.target)) e.preventDefault(); });
  for (const ev of ['copy', 'cut']) document.addEventListener(ev, (e) => { if (!editable(e.target)) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0', 's', 'p'].includes(k)) e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && ['c', 'a', 'x'].includes(k) && !editable(e.target)) e.preventDefault();
    if (k === 'printscreen') { shield(true); setTimeout(() => shield(false), 1500); }
  });
  function shield(on) { $('shield').classList.toggle('hidden', !on); }
  window.addEventListener('blur', () => { if (state.me) shield(true); });
  window.addEventListener('focus', () => shield(false));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (state.me) shield(true); stopPolling(); }
    else { shield(false); if (state.me) startPolling(true); }
  });
  window.addEventListener('pageshow', () => shield(false));

  // ---------------------------------------------------------------- boot
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    try {
      const me = await api('/api/me');
      enterChat(me);
    } catch (e) {
      if (e.status === 401) { show('login'); setTimeout(() => $('code').focus(), 50); }
      else {
        // offline: show cached chat if we have one
        const cached = readCache();
        if (cached && cached.me) { enterChat(cached.me); toast('ماكو اتصال بالإنترنت'); }
        else { show('login'); $('loginErr').textContent = 'ماكو اتصال بالإنترنت'; }
      }
    }
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    $('loginErr').textContent = '';
    try {
      const me = await api('/api/login', { json: { code: $('code').value } });
      $('code').value = '';
      enterChat(me);
    } catch (err) {
      $('loginErr').textContent = err.status === 401 ? 'الرمز غلط' : 'صار خطأ، حاول مرة ثانية';
    } finally { btn.disabled = false; }
  });

  function enterChat(me) {
    const cached = readCache();
    if (cached && cached.me && cached.me.role !== me.role) localStorage.removeItem(CACHE_KEY);
    state.me = { role: me.role, name: me.name };
    if (me.vapid) state.vapid = me.vapid;
    show('chat');
    const c = readCache();
    if (c && c.events) {
      state.epoch = c.epoch;
      applyEvents(c.events, true);
    }
    renderEmpty();
    scrollToBottom(true);
    startPolling(true);
    if ('Notification' in window && Notification.permission === 'granted') ensurePush(false);
  }

  // ---------------------------------------------------------------- cache
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
  }
  let saveTimer;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const events = [...state.msgs.values()].slice(-300);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ me: state.me, epoch: state.epoch, events })); } catch {}
    }, 400);
  }

  // ---------------------------------------------------------------- polling
  function startPolling(now) {
    stopPolling();
    state.polling = true;
    if (now) poll(); else state.pollTimer = setTimeout(poll, POLL_MS);
  }
  function stopPolling() {
    state.polling = false;
    clearTimeout(state.pollTimer);
  }
  let inflight = false;
  async function poll() {
    if (!state.polling || inflight) return;
    inflight = true;
    try {
      const q = state.lastSeq && state.epoch != null ? `?after=${state.lastSeq}&epoch=${state.epoch}` : '';
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 9000);
      const data = await api(`/api/messages${q}`, { signal: ctrl.signal });
      clearTimeout(to);
      $('banner').classList.add('hidden');
      if (data.reset) {
        clearMessages();
        state.epoch = data.epoch;
      }
      state.epoch = data.epoch;
      if (data.ownerName) state.ownerName = data.ownerName;
      if ((data.owner || null) !== state.owner) { state.owner = data.owner || null; relabelOwner(); }
      applyEvents(data.events, data.reset);
      setOnline(data.online);
    } catch (e) {
      if (e.status === 401) { logout(true); return; }
      if (e.status >= 500 || e.status === 409) banner(explainError(e));
      else banner('جاري الاتصال…');
    } finally {
      inflight = false;
      if (state.polling) state.pollTimer = setTimeout(poll, POLL_MS);
    }
  }
  function banner(t) { const b = $('banner'); b.textContent = t; b.classList.remove('hidden'); }
  function setOnline(on) {
    state.online = on;
    const s = $('status');
    s.textContent = on ? 'متصل الآن' : '';
    s.classList.toggle('on', on);
  }

  // ---------------------------------------------------------------- events
  function applyEvents(events, isReset) {
    if (!events || !events.length) { if (isReset) { renderEmpty(); saveCache(); } return; }
    const nearBottom = isNearBottom();
    let added = 0;
    for (const ev of events) {
      if (ev.seq > state.lastSeq) state.lastSeq = ev.seq;
      if (ev.type === 'del') { removeMessage(ev.id); continue; }
      if (ev.type !== 'msg' || state.msgs.has(ev.seq)) continue;
      state.msgs.set(ev.seq, ev);
      const p = ev.cid && state.pending.get(ev.cid);
      if (p) { // our optimistic bubble → swap in the real one
        state.pending.delete(ev.cid);
        p.node.replaceWith(renderRow(ev));
      } else {
        appendRow(ev);
        added++;
      }
    }
    restyleGroups();
    renderEmpty();
    saveCache();
    if (added && (nearBottom || isReset)) scrollToBottom(isReset);
    else if (added) $('toBottom').classList.remove('hidden');
  }

  function clearMessages() {
    state.msgs.clear();
    state.lastSeq = 0;
    $('msgs').innerHTML = '';
    for (const p of state.pending.values()) $('msgs').appendChild(p.node);
  }

  function removeMessage(id) {
    state.msgs.delete(id);
    const n = $('msgs').querySelector(`[data-seq="${id}"]`);
    if (n) n.remove();
    restyleGroups();
  }

  function renderEmpty() {
    const has = state.msgs.size || state.pending.size;
    let e = $('msgs').querySelector('.empty');
    if (!has && !e) {
      e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'ماكو رسائل بعد. الرسائل تنمسح تلقائياً كل يوم.';
      $('msgs').appendChild(e);
    } else if (has && e) e.remove();
  }

  // ---------------------------------------------------------------- rendering
  const isOut = (m) => m.from && m.from.role === state.me.role;
  // Messages from the owner's own Telegram account show as "AB" (covers ones received before the owner was known).
  const isOwner = (m) => m.from.owner || (state.owner && m.from.uid && String(m.from.uid) === state.owner);
  const senderName = (m) => (isOwner(m) ? state.ownerName : m.from.name);
  function relabelOwner() {
    for (const row of $('msgs').querySelectorAll('.row[data-seq]')) {
      const m = state.msgs.get(Number(row.dataset.seq));
      if (!m || m.from.role !== 'tg') continue;
      const el = row.querySelector('.sender');
      if (el) el.textContent = senderName(m);
      row.dataset.sender = `tg:${senderName(m)}`;
    }
    restyleGroups();
  }
  const senderColor = (m) => (m.from.role === 'admin' ? '' : m.from.role === 'user' ? 'c2' : 'c3');

  function appendRow(m) {
    const list = $('msgs');
    const lastRow = [...list.querySelectorAll('.row:not(.pending)')].pop();
    const lastTs = lastRow ? Number(lastRow.dataset.ts) : 0;
    if (!lastTs || dayKey(lastTs) !== dayKey(m.ts)) {
      const d = document.createElement('div');
      d.className = 'day';
      d.dataset.day = dayKey(m.ts);
      d.textContent = dayKey(m.ts) === dayKey(Date.now()) ? 'اليوم' : fmtDay.format(m.ts);
      insertBeforePending(d);
    }
    insertBeforePending(renderRow(m));
    restyleGroups();
  }
  function insertBeforePending(node) {
    const firstPending = $('msgs').querySelector('.row.pending');
    $('msgs').insertBefore(node, firstPending || null);
  }

  // Consecutive messages from the same sender are grouped (name shown once).
  function restyleGroups() {
    let prevKey = null;
    for (const el of $('msgs').children) {
      if (!el.classList.contains('row')) { prevKey = null; continue; }
      const key = el.dataset.sender;
      const start = key !== prevKey;
      el.classList.toggle('grp-start', start);
      const name = el.querySelector('.sender');
      if (name) name.classList.toggle('hidden', !start);
      prevKey = key;
    }
  }

  const ticks = '<svg viewBox="0 0 24 24"><path d="M2 13l4 4 8-9M10 17l1 1 9-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const clock = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function renderRow(m, opts = {}) {
    const out = isOut(m);
    const row = document.createElement('div');
    row.className = `row ${out ? 'out' : 'in'}${opts.pending ? ' pending' : ''}`;
    if (m.seq) row.dataset.seq = m.seq;
    row.dataset.ts = m.ts;
    row.dataset.sender = m.from.role === 'tg' ? `tg:${senderName(m)}` : m.from.role;

    const b = document.createElement('div');
    b.className = 'bubble';
    const meta = `<span class="meta">${fmtTime.format(m.ts)}${out ? (opts.pending ? clock : ticks) : ''}</span>`;
    const sender = out ? '' : `<div class="sender ${senderColor(m)}">${esc(senderName(m))}</div>`;
    const caption = m.text && m.kind !== 'text' ? `<div class="text">${linkify(m.text)}${meta}</div>` : '';

    if (m.kind === 'text') {
      b.innerHTML = `${sender}<div class="text">${linkify(m.text)}${meta}</div>`;
    } else if (m.kind === 'photo') {
      b.classList.add('media');
      const ratio = m.w && m.h ? Math.min(Math.max(m.h / m.w, 0.4), 1.6) : 0.75;
      b.innerHTML = `${sender}<div class="photo" style="aspect-ratio:${(1 / ratio).toFixed(3)}"></div>${caption || meta.replace('class="meta"', 'class="meta over"')}`;
      const ph = b.querySelector('.photo');
      const src = opts.localUrl || fileUrl(m);
      lazy(ph, () => { ph.style.backgroundImage = `url("${src}")`; });
      ph.addEventListener('click', () => openViewer(src));
    } else if (m.kind === 'video') {
      b.classList.add('media');
      b.innerHTML = `${sender}<video class="vid${m.round ? ' round' : ''}" playsinline preload="metadata" ${m.gif ? 'autoplay loop muted' : 'controls'} controlslist="nodownload noplaybackrate noremoteplayback" disablepictureinpicture disableremoteplayback></video>${caption || meta.replace('class="meta"', 'class="meta over"')}`;
      const v = b.querySelector('video');
      const src = opts.localUrl || fileUrl(m);
      lazy(v, () => { v.src = src + (opts.localUrl ? '' : '#t=0.1'); });
    } else if (m.kind === 'voice') {
      b.innerHTML = `${sender}<div class="voice"><button class="play" aria-label="تشغيل">${playIcon}</button><div class="track">${bars(m.seq || 7)}</div><span class="dur">${mmss(m.dur)}</span></div>${caption || `<div>${meta}</div>`}`;
      setupVoice(b.querySelector('.voice'), opts.localUrl || fileUrl(m), m.dur);
    } else if (m.kind === 'sticker') {
      b.classList.add('sticker');
      b.innerHTML = `${sender}<div class="stk"></div>${meta}`;
      const box = b.querySelector('.stk');
      lazy(box, () => drawSticker(box, m, m.file, m.fmt));
      if (m.set) box.addEventListener('click', () => openPackPreview(m.set));
    } else {
      b.innerHTML = `${sender}<div class="filebox">📎 <span>${esc(m.name || 'ملف')}</span></div>${caption || meta}`;
    }
    if (opts.progress) {
      const p = document.createElement('div');
      p.className = 'upload-prog';
      p.textContent = '0%';
      b.appendChild(p);
    }
    row.appendChild(b);
    if (m.seq) attachLongPress(b, m);
    return row;
  }

  const playIcon = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  function bars(seed) {
    let x = seed * 9301 + 49297, s = '';
    for (let i = 0; i < 28; i++) { x = (x * 9301 + 49297) % 233280; s += `<i style="height:${20 + (x / 233280) * 80}%"></i>`; }
    return s;
  }
  let currentAudio = null;
  function setupVoice(el, src, knownDur) {
    const btn = el.querySelector('.play');
    const barsEl = [...el.querySelectorAll('.track i')];
    const durEl = el.querySelector('.dur');
    let audio = null;
    btn.addEventListener('click', () => {
      if (!audio) {
        audio = new Audio(src);
        audio.preload = 'auto';
        audio.addEventListener('timeupdate', () => {
          const d = isFinite(audio.duration) ? audio.duration : knownDur || 1;
          const on = Math.floor((audio.currentTime / d) * barsEl.length);
          barsEl.forEach((b, i) => b.classList.toggle('on', i < on));
          durEl.textContent = mmss(audio.currentTime);
        });
        audio.addEventListener('ended', () => { btn.innerHTML = playIcon; barsEl.forEach((b) => b.classList.remove('on')); durEl.textContent = mmss(knownDur || audio.duration); });
        audio.addEventListener('pause', () => { btn.innerHTML = playIcon; });
        audio.addEventListener('play', () => { btn.innerHTML = pauseIcon; });
        audio.addEventListener('error', () => toast('ما گدرت أشغل الصوت'));
      }
      if (audio.paused) {
        if (currentAudio && currentAudio !== audio) currentAudio.pause();
        currentAudio = audio;
        audio.play().catch(() => toast('ما گدرت أشغل الصوت'));
      } else audio.pause();
    });
  }

  // Load media only when it scrolls into view.
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); const f = e.target._load; e.target._load = null; if (f) f(); }
  }, { rootMargin: '400px 0px' }) : null;
  function lazy(el, load) { if (io) { el._load = load; io.observe(el); } else load(); }

  // ---------------------------------------------------------------- stickers
  let lottieReady = null;
  function loadLottie() {
    if (!lottieReady) {
      lottieReady = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie_light.min.js';
        s.onload = () => resolve(window.lottie);
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    return lottieReady;
  }
  async function drawSticker(box, m, fileId, fmt, opts = {}) {
    const url = fileUrl(m, fileId);
    if (fmt === 'webm') {
      const v = document.createElement('video');
      Object.assign(v, { muted: true, loop: !opts.once, autoplay: true, playsInline: true });
      v.setAttribute('playsinline', '');
      v.setAttribute('disablepictureinpicture', '');
      v.src = url;
      box.appendChild(v);
      v.play().catch(() => {});
    } else if (fmt === 'tgs') {
      try {
        const [lottie, res] = await Promise.all([loadLottie(), fetch(url, { credentials: 'same-origin' })]);
        const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
        const json = JSON.parse(await new Response(stream).text());
        lottie.loadAnimation({ container: box, renderer: 'svg', loop: true, autoplay: true, animationData: json });
      } catch { box.textContent = m.emoji || '🙂'; box.style.fontSize = '80px'; }
    } else {
      box.style.backgroundImage = `url("${url}")`;
    }
  }

  async function loadPacks(force) {
    if (state.packsLoaded && !force) return;
    try {
      const data = await api('/api/stickers');
      state.packs = data.sets || [];
      state.packsLoaded = true;
    } catch { toast('ما گدرت أحمل الملصقات'); }
  }

  function renderPacks() {
    const tabs = $('packTabs');
    tabs.innerHTML = '';
    const add = document.createElement('button');
    add.textContent = '＋ حزمة';
    add.addEventListener('click', addPackDialog);
    tabs.appendChild(add);
    state.packs.forEach((p, i) => {
      const t = document.createElement('button');
      t.textContent = p.title;
      t.className = i === state.activePack ? 'on' : '';
      t.addEventListener('click', () => { state.activePack = i; renderPacks(); });
      attachLongPressEl(t, () => sheet([
        { title: p.title },
        { label: 'حذف الحزمة', danger: true, action: async () => {
          await api('/api/stickers', { json: { action: 'remove', name: p.name } }).catch(() => {});
          state.packs.splice(i, 1);
          state.activePack = 0;
          renderPacks();
        } },
      ]));
      tabs.appendChild(t);
    });
    const grid = $('packGrid');
    grid.innerHTML = '';
    const pack = state.packs[state.activePack];
    if (!pack) {
      grid.innerHTML = '<div class="pack-empty">ماكو حزم ملصقات بعد.<br>اضغط على أي ملصق يوصلك بالمحادثة حتى تضيف حزمته، أو اضغط ＋ حزمة وحط رابط الحزمة.</div>';
      return;
    }
    const botN = state.me.role === 'admin' ? 1 : 2;
    for (const s of pack.stickers) {
      const c = document.createElement('button');
      c.className = 'cell';
      if (s.thumb || s.fmt === 'webp') {
        lazy(c, () => { c.style.backgroundImage = `url("${fileUrl({ bot: botN }, s.thumb || s.file)}")`; });
      } else c.textContent = s.emoji;
      c.addEventListener('click', () => sendSticker(s, pack.name));
      grid.appendChild(c);
    }
  }

  function addPackDialog() {
    sheet([
      { title: 'إضافة حزمة ملصقات' },
      { note: 'حط رابط الحزمة (t.me/addstickers/...) أو اسمها' },
      { input: 'packName', placeholder: 't.me/addstickers/…' },
      { label: 'إضافة', primary: true, action: async (root) => {
        const v = root.querySelector('#packName').value.trim();
        const name = v.split('/').pop().split('?')[0];
        if (name) await addPack(name);
      } },
    ]);
  }

  async function addPack(name) {
    try {
      const set = await api('/api/stickers', { json: { action: 'add', name } });
      state.packs = [set, ...state.packs.filter((p) => p.name !== set.name)];
      state.activePack = 0;
      state.packsLoaded = true;
      toast(`انضافت: ${set.title}`);
      if (!$('stickerPanel').classList.contains('hidden')) renderPacks();
    } catch { toast('ما لگيت هالحزمة'); }
  }

  async function openPackPreview(name) {
    const have = state.packs.some((p) => p.name === name);
    let set;
    try { set = await api(`/api/stickers?name=${encodeURIComponent(name)}`); } catch { toast('ما گدرت أفتح الحزمة'); return; }
    const botN = state.me.role === 'admin' ? 1 : 2;
    const grid = set.stickers.slice(0, 40).map((s) => `<div style="background-image:url('${fileUrl({ bot: botN }, s.thumb || s.file)}')"></div>`).join('');
    sheet([
      { title: set.title },
      { html: `<div class="grid-prev">${grid}</div>` },
      have ? { note: 'هالحزمة موجودة عندك ✓' } : { label: `إضافة الحزمة (${set.stickers.length} ملصق)`, primary: true, action: () => addPack(name) },
    ]);
  }

  function toggleStickers(force) {
    const p = $('stickerPanel');
    const open = force !== undefined ? force : p.classList.contains('hidden');
    p.classList.toggle('hidden', !open);
    if (open) {
      $('text').blur();
      renderPacks();
      loadPacks().then(renderPacks);
    }
  }

  // ---------------------------------------------------------------- sending
  function optimistic(data, opts) {
    const cid = uid();
    const m = { type: 'msg', from: { role: state.me.role, name: state.me.name }, ts: Date.now(), bot: state.me.role === 'admin' ? 1 : 2, cid, ...data };
    const node = renderRow(m, { pending: true, ...opts });
    $('msgs').appendChild(node);
    state.pending.set(cid, { node, data: m });
    renderEmpty();
    restyleGroups();
    scrollToBottom();
    return { cid, node };
  }
  // Turns a server error into something the user can act on.
  function explainError(e) {
    const m = String((e && e.message) || '');
    if (e && e.status === 0) return 'ماكو اتصال بالإنترنت';
    if (/not set up/.test(m)) return 'الگروب مو مربوط: ضيف البوتين للگروب، اكتب رسالة بالگروب، وبعدين ⋮ ← ربط البوتات بالگروب';
    if (/Redis/.test(m)) return 'قاعدة البيانات مو مربوطة بالمشروع على Vercel (Storage ← Upstash for Redis)';
    if (/TOKEN is not set/.test(m)) return `${m.split(' ')[0]} مو مضاف بإعدادات Vercel`;
    if (/Unauthorized|401/.test(m) && /Telegram/.test(m)) return 'توكن البوت غلط';
    if (/chat not found|not a member|kicked|bot was blocked/.test(m)) return 'البوت مو موجود بالگروب — ضيفه';
    if (/not enough rights|CHAT_SEND/.test(m)) return 'البوت ما عنده صلاحية يرسل بالگروب';
    if (/too large|413/.test(m)) return 'الملف كبير هواية';
    return m || 'صار خطأ';
  }

  function failPending(cid, retry, err) {
    const p = state.pending.get(cid);
    if (!p) return;
    if (err) toast(explainError(err), 7000);
    p.node.classList.add('failed');
    const meta = p.node.querySelector('.meta');
    if (meta) meta.innerHTML = '⚠️ ما انرسلت — اضغط لإعادة الإرسال';
    p.node.addEventListener('click', () => {
      state.pending.delete(cid);
      p.node.remove();
      retry();
    }, { once: true });
  }
  function settle(cid, ev) {
    // the poll may have already delivered this message
    if (state.msgs.has(ev.seq)) {
      const p = state.pending.get(cid);
      if (p) { p.node.remove(); state.pending.delete(cid); }
      return;
    }
    applyEvents([ev]);
  }

  async function sendText(text) {
    const { cid } = optimistic({ kind: 'text', text });
    try {
      settle(cid, await api('/api/send', { json: { text, cid } }));
    } catch (e) { failPending(cid, () => sendText(text), e); }
  }

  async function sendSticker(s, set) {
    const botN = state.me.role === 'admin' ? 1 : 2;
    const { cid } = optimistic({ kind: 'sticker', file: s.file, fmt: s.fmt, emoji: s.emoji, set, bot: botN });
    try {
      settle(cid, await api('/api/send', { json: { sticker: { file: s.file, set, fmt: s.fmt, emoji: s.emoji }, cid } }));
    } catch (e) { failPending(cid, () => sendSticker(s, set), e); }
  }

  function uploadFile(kind, blob, extra = {}) {
    const localUrl = URL.createObjectURL(blob);
    const { cid, node } = optimistic({ kind, ...extra }, { localUrl, progress: true });
    const prog = node.querySelector('.upload-prog');
    const params = new URLSearchParams({ kind, cid });
    if (extra.dur) params.set('dur', String(extra.dur));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?${params}`);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (prog && e.lengthComputable) prog.textContent = `${Math.round((e.loaded / e.total) * 100)}%`; };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const ev = JSON.parse(xhr.responseText);
        settle(cid, ev);
      } else {
        if (prog) prog.remove();
        let err = { status: xhr.status, message: `HTTP ${xhr.status}` };
        try { err.message = JSON.parse(xhr.responseText).error || err.message; } catch {}
        failPending(cid, () => uploadFile(kind, blob, extra), err);
      }
    };
    xhr.onerror = () => { if (prog) prog.remove(); failPending(cid, () => uploadFile(kind, blob, extra), { status: 0 }); };
    xhr.send(blob);
  }

  async function compressImage(file) {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return { blob: file };
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    let q = 0.86, blob;
    do {
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      q -= 0.12;
    } while (blob && blob.size > MAX_UPLOAD && q > 0.3);
    return { blob, w, h };
  }

  async function handleFiles(files) {
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        const { blob, w, h } = await compressImage(f);
        if (blob.size > MAX_UPLOAD) { toast('الصورة كبيرة هواية'); continue; }
        uploadFile('photo', blob, { w, h });
      } else if (f.type.startsWith('video/')) {
        if (f.size > MAX_UPLOAD) { toast('الفيديو أكبر من 4 ميگا — الحد الأقصى للرفع 4 ميگا'); continue; }
        uploadFile('video', f);
      } else toast('نوع الملف مو مدعوم');
    }
  }

  // ---------------------------------------------------------------- voice recording
  const rec = { mr: null, chunks: [], start: 0, timer: null, stream: null, cancelled: false };
  function pickMime() {
    if (!window.MediaRecorder) return null;
    for (const t of ['audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }
  async function startRecording() {
    const mime = pickMime();
    if (mime === null) { toast('جهازك ما يدعم تسجيل الصوت'); return; }
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch { toast('لازم تسمح بالمايكروفون'); return; }
    rec.chunks = [];
    rec.cancelled = false;
    rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    rec.mr.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    rec.mr.onstop = () => {
      rec.stream.getTracks().forEach((t) => t.stop());
      const dur = (Date.now() - rec.start) / 1000;
      if (rec.cancelled || dur < 0.7) return;
      const type = (rec.mr.mimeType || mime || 'audio/webm').split(';')[0];
      const blob = new Blob(rec.chunks, { type });
      if (blob.size > MAX_UPLOAD) { toast('التسجيل طويل هواية'); return; }
      uploadFile('voice', blob, { dur: Math.round(dur) });
    };
    rec.mr.start(250);
    rec.start = Date.now();
    $('recBar').classList.remove('hidden');
    $('inputRow').classList.add('hidden');
    $('actionBtn').classList.add('recording', 'send');
    $('recTime').textContent = '0:00';
    rec.timer = setInterval(() => { $('recTime').textContent = mmss((Date.now() - rec.start) / 1000); }, 250);
    if (navigator.vibrate) navigator.vibrate(20);
  }
  function stopRecording(cancel) {
    if (!rec.mr) return;
    rec.cancelled = !!cancel;
    clearInterval(rec.timer);
    if (rec.mr.state !== 'inactive') rec.mr.stop();
    rec.mr = null;
    $('recBar').classList.add('hidden');
    $('inputRow').classList.remove('hidden');
    $('actionBtn').classList.remove('recording');
    updateAction();
  }

  // ---------------------------------------------------------------- composer
  const ta = $('text');
  function updateAction() {
    if (rec.mr) return;
    $('actionBtn').classList.toggle('send', ta.value.trim().length > 0);
    $('actionBtn').classList.toggle('mic', !ta.value.trim());
  }
  function autoGrow() { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; }
  ta.addEventListener('input', () => { autoGrow(); updateAction(); });
  ta.addEventListener('focus', () => { toggleStickers(false); setTimeout(() => scrollToBottom(), 250); });
  ta.addEventListener('keydown', (e) => {
    const desktop = window.matchMedia('(pointer: fine)').matches;
    if (e.key === 'Enter' && !e.shiftKey && desktop) { e.preventDefault(); submitText(); }
  });
  function submitText() {
    const t = ta.value.trim();
    if (!t) return;
    ta.value = '';
    autoGrow();
    updateAction();
    sendText(t);
  }
  // keep the keyboard open when tapping send
  $('actionBtn').addEventListener('mousedown', (e) => e.preventDefault());
  $('actionBtn').addEventListener('click', () => {
    if (rec.mr) stopRecording(false);
    else if (ta.value.trim()) { submitText(); ta.focus(); }
    else startRecording();
  });
  $('recCancel').addEventListener('click', () => stopRecording(true));
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { handleFiles([...e.target.files]); e.target.value = ''; });
  $('stickerBtn').addEventListener('click', () => toggleStickers());

  // ---------------------------------------------------------------- scrolling
  const list = $('list');
  function isNearBottom() { return list.scrollHeight - list.scrollTop - list.clientHeight < 160; }
  function scrollToBottom(instant) {
    requestAnimationFrame(() => list.scrollTo({ top: list.scrollHeight, behavior: instant ? 'auto' : 'smooth' }));
    $('toBottom').classList.add('hidden');
  }
  list.addEventListener('scroll', () => { if (isNearBottom()) $('toBottom').classList.add('hidden'); }, { passive: true });
  $('toBottom').addEventListener('click', () => scrollToBottom());
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if (isNearBottom()) scrollToBottom(true); });

  // ---------------------------------------------------------------- long press / sheets
  function attachLongPressEl(el, fn) {
    let t = null, sx = 0, sy = 0;
    const cancel = () => { clearTimeout(t); t = null; };
    el.addEventListener('touchstart', (e) => {
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      t = setTimeout(() => { t = null; if (navigator.vibrate) navigator.vibrate(15); fn(); }, 480);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => { if (Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 10) cancel(); }, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(); });
  }
  function attachLongPress(bubble, m) {
    const canDelete = state.me.role === 'admin' || isOut(m);
    const items = [];
    if (m.kind === 'sticker' && m.set) items.push({ label: 'عرض حزمة الملصقات', action: () => openPackPreview(m.set) });
    if (state.me.role === 'admin' && m.from.role === 'tg' && m.from.uid && !isOwner(m)) {
      items.push({ label: `هذا حسابي — يظهر باسم ${state.ownerName}`, action: () => setOwner(m.from.uid) });
    }
    if (canDelete) items.push({ label: 'حذف الرسالة', danger: true, action: () => deleteMsg(m) });
    if (items.length) attachLongPressEl(bubble, () => sheet(items));
  }
  async function setOwner(uid) {
    try { await api('/api/owner', { json: { uid } }); state.owner = String(uid); relabelOwner(); toast(`صار يظهر باسم ${state.ownerName} ✓`); }
    catch { toast('ما گدرت أحفظها'); }
  }
  async function deleteMsg(m) {
    try { await api('/api/delete', { json: { id: m.seq } }); removeMessage(m.seq); saveCache(); }
    catch { toast('ما گدرت أحذفها'); }
  }

  function sheet(items) {
    const wrap = $('sheet');
    const s = wrap.querySelector('.sheet');
    s.innerHTML = '';
    for (const it of items) {
      let el;
      if (it.title) { el = document.createElement('h3'); el.textContent = it.title; }
      else if (it.note) { el = document.createElement('div'); el.className = 'note'; el.textContent = it.note; }
      else if (it.html) { el = document.createElement('div'); el.innerHTML = it.html; }
      else if (it.input) { el = document.createElement('input'); el.id = it.input; el.placeholder = it.placeholder || ''; el.autocomplete = 'off'; el.spellcheck = false; }
      else {
        el = document.createElement('button');
        el.className = it.primary ? 'btn-primary' : `item${it.danger ? ' danger' : ''}`;
        el.textContent = it.label;
        el.addEventListener('click', async () => {
          if (it.keepOpen) { await it.action(s); return; }
          closeSheet();
          await it.action(s);
        });
      }
      s.appendChild(el);
    }
    wrap.classList.remove('hidden');
    const inp = s.querySelector('input');
    if (inp) setTimeout(() => inp.focus(), 100);
  }
  function closeSheet() { $('sheet').classList.add('hidden'); }
  $('sheet').querySelector('.sheet-bg').addEventListener('click', closeSheet);

  function openViewer(src) {
    const v = $('viewer');
    v.querySelector('.viewer-img').style.backgroundImage = `url("${src}")`;
    v.classList.remove('hidden');
  }
  $('viewer').addEventListener('click', () => $('viewer').classList.add('hidden'));

  // ---------------------------------------------------------------- menu
  $('menuBtn').addEventListener('click', () => {
    const items = [{ title: state.me.name }];
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    items.push({ label: perm === 'granted' ? 'الإشعارات مفعّلة ✓' : 'تفعيل الإشعارات', action: () => ensurePush(true) });
    if (state.me.role === 'admin') {
      items.push({ label: 'ربط البوتات بالگروب', action: runSetup });
      items.push({ label: 'مسح المحادثة الآن', danger: true, action: () => sheet([
        { title: 'تمسح كل الرسائل؟' },
        { note: 'تنمسح من التطبيق ومن الگروب لكل الأشخاص.' },
        { label: 'إي، امسح', danger: true, action: async () => {
          try { await api('/api/clear', { json: {} }); clearMessages(); renderEmpty(); saveCache(); state.epoch = null; toast('انمسحت المحادثة'); }
          catch { toast('ما گدرت أمسح'); }
        } },
      ]) });
    }
    items.push({ label: 'تسجيل خروج', danger: true, action: () => logout(false) });
    sheet(items);
  });

  async function runSetup() {
    toast('جاري الربط…', 8000);
    try {
      const r = await api('/api/setup', { json: {} });
      sheet([{ title: 'نتيجة الربط' }, { note: r.report.join('\n') }]);
    } catch (e) { sheet([{ title: 'صار خطأ' }, { note: explainError(e) }]); }
  }

  async function logout(expired) {
    stopPolling();
    try { if (!expired) await api('/api/logout', { json: {} }); } catch {}
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      if (sub && !expired) { await api('/api/push', { method: 'DELETE', json: { subscription: sub } }).catch(() => {}); await sub.unsubscribe(); }
    } catch {}
    localStorage.removeItem(CACHE_KEY);
    state.me = null;
    state.msgs.clear();
    state.pending.clear();
    state.lastSeq = 0;
    state.epoch = null;
    state.packs = [];
    state.packsLoaded = false;
    $('msgs').innerHTML = '';
    show('login');
  }

  // ---------------------------------------------------------------- push
  function b64ToBytes(b64) {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
  async function ensurePush(interactive) {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      if (interactive) toast(ios && !standalone ? 'بالآيفون: من زر المشاركة اختار "إضافة إلى الشاشة الرئيسية" وافتح التطبيق من هناك' : 'جهازك ما يدعم الإشعارات', 6000);
      return;
    }
    try {
      const perm = interactive ? await Notification.requestPermission() : Notification.permission;
      if (perm !== 'granted') { if (interactive) toast('لازم تسمح بالإشعارات من الإعدادات'); return; }
      if (!state.vapid) state.vapid = (await api('/api/me')).vapid;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.vapid) });
      await api('/api/push', { json: { subscription: sub.toJSON() } });
      if (interactive) toast('الإشعارات اشتغلت ✓');
    } catch (e) {
      if (interactive) toast('ما گدرت أفعّل الإشعارات');
    }
  }

  // ---------------------------------------------------------------- go
  updateAction();
  boot();
})();
