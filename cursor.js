/* The cursor is a client. Moving it sends requests into a small backend drawn behind the page:
   gateway (rate limit) → auth (JWT) → service → cache / database / Kafka, and the response travels back.
     GET  /api/tasks        read:   cache hit → 200, or miss → database → fill the cache → 200
     PUT  /api/tasks/42     write:  database with a version check → 200, or 409 if someone saved first;
                                    a good write evicts the cached list, so the next read is fresh
     POST /api/documents    upload: publish to Kafka → 202 straight away; a worker consumes it later
   The gateway holds a token bucket, so moving fast gets 429s. On a phone, scrolling and tapping send the requests.
   Off with reduced motion. The drawing loop stops when nothing is moving. */
(() => {
  'use strict';
  const fine = window.matchMedia('(pointer: fine)').matches;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (calm) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'mesh';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const hud = document.createElement('div');
  hud.className = 'mesh-hud mono';
  const status = document.createElement('span');
  status.setAttribute('aria-hidden', 'true');
  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  const helpLabel = fine ? "what's this?" : "what's moving?";
  helpBtn.textContent = helpLabel;
  helpBtn.setAttribute('aria-expanded', 'false');
  helpBtn.setAttribute('aria-controls', 'mesh-help');
  hud.append(status, helpBtn);
  const help = document.createElement('aside');
  help.className = 'mesh-help';
  help.id = 'mesh-help';
  help.hidden = true;
  help.innerHTML = `
    <h2>What's moving behind the page</h2>
    <p>A small model of a request path. ${fine ? 'Your cursor is the client' : 'You are the client: scrolling and tapping send requests'}, and every dot is a request following the same rules as the rest of this site.</p>
    <ul>
      <li><b>gateway</b> A token bucket. ${fine ? 'Move the cursor fast' : 'Scroll fast'} and it answers <code>429</code> before anything else runs.</li>
      <li><b>auth</b> Checks the JWT. An expired token stops here with <code>401</code>.</li>
      <li><b>read</b> <code>GET</code> asks the cache first. A hit answers at once. A miss goes to the database, then fills the cache.</li>
      <li><b>write</b> <code>PUT</code> updates the database with a version check. A stale version gets <code>409</code>. A good write evicts the cached copy.</li>
      <li><b>upload</b> <code>POST</code> publishes an event to Kafka and answers <code>202</code> straight away. A worker does the slow part later.</li>
    </ul>
    <p class="mesh-key"><span><i class="k-ok"></i>request and reply</span><span><i class="k-warn"></i>rejected</span><span><i class="k-async"></i>work after the reply</span></p>
    <p>The reply travels back the way it came. It's simplified: a real system also has load balancers, replicas and several copies of each service.</p>`;
  document.body.append(hud, help);
  const toggleHelp = (open) => { help.hidden = !open; helpBtn.setAttribute('aria-expanded', String(open)); helpBtn.textContent = open ? 'close' : helpLabel; };
  helpBtn.addEventListener('click', () => toggleHelp(help.hidden));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !help.hidden) toggleHelp(false); });
  document.addEventListener('click', (e) => { if (!help.hidden && !help.contains(e.target) && !hud.contains(e.target)) toggleHelp(false); });
  const ctx = canvas.getContext('2d');

  const ROLES = ['gateway', 'auth', 'service', 'cache', 'db', 'kafka', 'worker'];
  const REASON = { 200: 'OK', 202: 'Accepted', 401: 'Unauthorized', 409: 'Conflict', 429: 'Too Many Requests' };

  const quiet = fine ? 0.75 : 0.5;     // text sits on top of the map, so labels stay faint, fainter on a small screen
  let W, H, dpr, nodes = [];
  const packets = [], labels = [];
  let served = 0, windowStart = performance.now(), rps = 0, last = '';

  // ---------------------------------------------------------------- the gateway's token bucket
  const bucket = { tokens: 6, capacity: 6, perSecond: 3, at: performance.now() };
  function takeToken() {
    const now = performance.now();
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + ((now - bucket.at) / 1000) * bucket.perSecond);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // ---------------------------------------------------------------- layout
  function layout() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.width = innerWidth * dpr; H = canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
    nodes = [];
    const step = 190 * dpr;
    let k = 0;
    for (let y = step * 0.6; y < H; y += step) {
      for (let x = step * 0.5 + ((y / step) % 2 ? step / 2 : 0); x < W; x += step) {
        nodes.push({ x: x + (Math.random() - 0.5) * step * 0.4, y: y + (Math.random() - 0.5) * step * 0.4, role: ROLES[k++ % ROLES.length], glow: 0 });
      }
    }
    for (const n of nodes) n.links = nodes.filter((m) => m !== n && Math.hypot(m.x - n.x, m.y - n.y) < step * 1.45);
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function nearest(from, role) {
    // prefer a directly linked node, like a service calling its neighbour
    const linked = from.links ? from.links.filter((m) => m.role === role) : [];
    const pool = linked.length ? linked : nodes.filter((n) => n.role === role);
    return pool.reduce((best, n) => (!best || dist(n, from) < dist(best, from) ? n : best), null);
  }

  function say(node, text, tone = 'ok') {
    node.glow = 1;
    const here = labels.filter((l) => l.node === node && l.life > 0.4);
    if (here.some((l) => l.text === text)) return;                     // don't repeat what is already showing
    labels.push({ node, x: node.x, y: node.y + here.length * 13 * dpr, text, tone, life: 1 });   // a second line goes underneath
  }

  // ---------------------------------------------------------------- requests
  function send(x, y) {
    const r = Math.random();
    const kind = r < 0.6 ? 'read' : r < 0.8 ? 'write' : 'upload';
    const line = { read: 'GET /api/tasks', write: 'PUT /api/tasks/42', upload: 'POST /api/documents' }[kind];
    const client = { x, y };
    const gateway = nearest(client, 'gateway');
    if (!gateway) return;
    packets.push({ kind, line, client, path: [client], from: client, to: gateway, t: 0, phase: 'request', t0: performance.now() });
    wake();
  }

  // what each service does with the request, and where it goes next
  function handle(p, n) {
    switch (n.role) {
      case 'gateway':
        if (!takeToken()) { say(n, '429 · rate limited, retry later', 'warn'); return respond(p, 429); }
        say(n, `${p.line} · token ✓`);
        return forward(p, n, 'auth');
      case 'auth':
        if (Math.random() < 0.05) { say(n, '401 · token expired', 'warn'); return respond(p, 401); }
        say(n, 'jwt ✓ · role USER');
        return forward(p, n, 'service');
      case 'service':
        say(n, p.kind === 'read' ? 'validate → read' : p.kind === 'write' ? 'validate → update' : 'store file → publish');
        return forward(p, n, p.kind === 'read' ? 'cache' : p.kind === 'write' ? 'db' : 'kafka');
      case 'cache':
        if (p.filled) { say(n, 'cache set · ttl 60s'); return respond(p, 200, 'cache miss → db'); }
        if (Math.random() < 0.7) { say(n, 'cache hit · redis'); return respond(p, 200, 'cache hit'); }
        say(n, 'cache miss');
        return forward(p, n, 'db');
      case 'db':
        if (p.kind === 'read') { say(n, `SELECT … · ${2 + (Math.random() * 6 | 0)} ms`); p.filled = true; return forward(p, n, 'cache'); }
        if (Math.random() < 0.1) { say(n, '409 · stale version', 'warn'); return respond(p, 409); }
        say(n, 'UPDATE … WHERE version = 3 ✓');
        evict(p.from);
        return respond(p, 200, 'version 3 → 4, cache evicted');
      case 'kafka':
        say(n, 'publish · document-uploaded');
        spawnConsumer(n);
        return respond(p, 202, 'processing later');
      default:
        return respond(p, 200);
    }
  }

  function forward(p, n, role) {
    const next = nearest(n, role);
    if (!next) return respond(p, 200);
    p.path.push(n);
    p.from = n; p.to = next; p.t = 0;
  }

  // the response walks back the same way it came, to where the cursor was
  function respond(p, status, note = '') {
    p.path.push(p.to);
    p.phase = 'response'; p.status = status; p.note = note;
    // [here, ..., gateway, client], without loops: after a cache miss the path is
    // cache → db → cache, and the response must not walk back through the database again
    let back = [];
    for (const node of p.path.slice().reverse()) {
      const seen = back.indexOf(node);
      if (seen >= 0) back = back.slice(0, seen + 1); else back.push(node);
    }
    p.back = back;
    p.from = p.back.shift(); p.to = p.back.shift(); p.t = 0;
  }

  // Kafka hands the event to a worker, off the request path
  function spawnConsumer(kafka) {
    const worker = nearest(kafka, 'worker');
    if (!worker) return;
    packets.push({ kind: 'async', from: kafka, to: worker, t: -0.6, phase: 'consume' });
  }

  // after a good write the service drops the cached copy, so the next read can't serve the old row
  function evict(service) {
    const cache = nearest(service, 'cache');
    if (cache) packets.push({ kind: 'async', from: service, to: cache, t: -0.3, phase: 'evict' });
  }

  function arrive(p) {
    if (p.phase === 'request') return handle(p, p.to);
    if (p.phase === 'evict') { say(p.to, 'evict tasks · next read is fresh'); p.done = true; return; }
    if (p.phase === 'consume') {
      say(p.to, 'worker · consume + process');
      const db = nearest(p.to, 'db');
      if (!db) { p.done = true; return; }
      p.from = p.to; p.to = db; p.t = 0; p.phase = 'store';
      return;
    }
    if (p.phase === 'store') { say(p.to, 'INSERT result · offset committed'); p.done = true; return; }
    // response: keep walking back until we reach the client
    if (p.back.length) { p.from = p.to; p.to = p.back.shift(); p.t = 0; return; }
    p.done = true;
    const ms = Math.max(1, Math.round((performance.now() - p.t0) / 45));
    last = `${p.line} → ${p.status} ${REASON[p.status]}${p.note ? ` (${p.note})` : ''} · ${ms}ms`;
    served++;
  }

  // ---------------------------------------------------------------- input
  let lastSend = 0;
  function client(x, y, gap) {
    const now = performance.now();
    if (now - lastSend < gap || packets.length > (fine ? 28 : 12)) return;
    lastSend = now;
    send(x * dpr, y * dpr);
  }
  window.addEventListener('pointermove', (e) => client(e.clientX, e.clientY, 120), { passive: true });
  if (!fine) {
    // a phone has no cursor: a tap is one request, and scrolling sends them from where the finger last was
    let touch = { x: innerWidth / 2, y: innerHeight / 2 };
    window.addEventListener('pointerdown', (e) => { touch = { x: e.clientX, y: e.clientY }; client(touch.x, touch.y, 120); }, { passive: true });
    window.addEventListener('scroll', () => client(touch.x + (Math.random() - 0.5) * 80, touch.y + (Math.random() - 0.5) * 160, 260), { passive: true });
  }
  window.addEventListener('resize', () => { layout(); wake(); });

  const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  let color, warn, blue;
  const readColors = () => { color = cssVar('--accent', '#3ddc97'); warn = cssVar('--amber', '#f5c26b'); blue = cssVar('--accent-2', '#5cc8ff'); };
  readColors();
  new MutationObserver(() => { readColors(); wake(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------------------------------------------------------------- draw
  function frame(now) {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = dpr;
    ctx.strokeStyle = color; ctx.globalAlpha = 0.05;
    ctx.beginPath();
    for (const n of nodes) for (const m of n.links) if (m.x > n.x || (m.x === n.x && m.y > n.y)) { ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y); }
    ctx.stroke();
    ctx.font = `${10 * dpr}px "JetBrains Mono", monospace`;
    for (const n of nodes) {
      n.glow *= 0.94;
      ctx.globalAlpha = 0.12 + n.glow * 0.7; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(n.x, n.y, (2.2 + n.glow * 3) * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.08 + n.glow * 0.5 * quiet;
      ctx.fillText(n.role, n.x + 7 * dpr, n.y - 6 * dpr);
    }
    for (const p of packets) {
      if (p.done) continue;
      p.t = Math.min(1, p.t + (p.phase === 'response' ? 0.06 : 0.045));
      if (p.t < 0) continue;                      // async work starts a moment after the publish
      const x = p.from.x + (p.to.x - p.from.x) * p.t, y = p.from.y + (p.to.y - p.from.y) * p.t;
      const c = p.phase === 'response' ? (p.status >= 400 ? warn : color) : p.kind === 'async' ? blue : color;
      ctx.strokeStyle = c; ctx.fillStyle = c;
      ctx.globalAlpha = 0.35;
      if (p.kind === 'async') ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(x, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(x, y, (p.phase === 'response' ? 2 : 2.6) * dpr, 0, Math.PI * 2); ctx.fill();
      if (p.t >= 1) arrive(p);
    }
    for (let i = packets.length - 1; i >= 0; i--) if (packets[i].done) packets.splice(i, 1);
    for (const l of labels) {
      l.life -= 0.011; l.y -= 0.25 * dpr;
      ctx.globalAlpha = Math.max(0, l.life) * quiet; ctx.fillStyle = l.tone === 'warn' ? warn : color;
      ctx.fillText(l.text, l.x + 8 * dpr, l.y + 14 * dpr);
    }
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].life <= 0) labels.splice(i, 1);
    ctx.globalAlpha = 1;
    if (now - windowStart > 1000) { rps = served; served = 0; windowStart = now; }
    status.textContent = last ? `${rps} req/s · ${last}` : fine ? 'move the cursor: you are the client' : 'scroll or tap: you are the client';
    // keep drawing only while something is moving or fading
    running = packets.length > 0 || labels.length > 0 || rps > 0 || nodes.some((n) => n.glow > 0.02);
    if (running) requestAnimationFrame(frame);
  }
  let running = false;
  function wake() { if (!running) { running = true; requestAnimationFrame(frame); } }
  layout();
  wake();
})();
