/* The cursor is a client. Moving it sends requests into a small backend drawn behind the page:
   gateway (rate limit) → auth (JWT) → service → cache / database / Kafka, and the response travels back.
     GET  /api/tasks        read:   cache hit → 200, or miss → database → fill the cache → 200
     PUT  /api/tasks/42     write:  database with a version check → 200, or 409 if someone saved first
     POST /api/documents    upload: publish to Kafka → 202 straight away; a worker consumes it later
   The gateway holds a token bucket, so moving fast gets 429s. Off on touch screens and with reduced motion. */
(() => {
  'use strict';
  const fine = window.matchMedia('(pointer: fine)').matches;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!fine || calm) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'mesh';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const hud = document.createElement('div');
  hud.className = 'mesh-hud mono';
  hud.setAttribute('aria-hidden', 'true');
  document.body.append(hud);
  const ctx = canvas.getContext('2d');

  const ROLES = ['gateway', 'auth', 'service', 'cache', 'db', 'kafka', 'worker'];
  const REASON = { 200: 'OK', 202: 'Accepted', 401: 'Unauthorized', 409: 'Conflict', 429: 'Too Many Requests' };

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
    if (labels.some((l) => l.node === node && l.life > 0.4)) return;   // one label per node at a time
    labels.push({ node, x: node.x, y: node.y, text, tone, life: 1 });
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
        return respond(p, 200, 'version 3 → 4');
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

  function arrive(p) {
    if (p.phase === 'request') return handle(p, p.to);
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
  window.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastSend < 120 || packets.length > 28) return;
    lastSend = now;
    send(e.clientX * dpr, e.clientY * dpr);
  }, { passive: true });
  window.addEventListener('resize', layout);

  const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  let color, warn, blue;
  const readColors = () => { color = cssVar('--accent', '#3ddc97'); warn = cssVar('--amber', '#f5c26b'); blue = cssVar('--accent-2', '#5cc8ff'); };
  readColors();
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

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
      ctx.globalAlpha = 0.08 + n.glow * 0.5;
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
      ctx.globalAlpha = Math.max(0, l.life) * 0.8; ctx.fillStyle = l.tone === 'warn' ? warn : color;
      ctx.fillText(l.text, l.x + 8 * dpr, l.y + 14 * dpr);
    }
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].life <= 0) labels.splice(i, 1);
    ctx.globalAlpha = 1;
    if (now - windowStart > 1000) { rps = served; served = 0; windowStart = now; }
    hud.textContent = last ? `${rps} req/s · ${last}` : 'move the cursor: you are the client';
    requestAnimationFrame(frame);
  }
  layout();
  requestAnimationFrame(frame);
})();
