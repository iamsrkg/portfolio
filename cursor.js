/* The cursor is a client: moving it sends requests into a small service mesh drawn behind the page.
   Each request hops gateway → auth → service → cache/db/kafka and comes back with a status. */
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

  const ROLES = ['gateway', 'auth', 'service', 'cache', 'db', 'kafka'];
  const SAYS = {
    gateway: () => `GET /api/${['tasks', 'users', 'projects', 'hire/sudheer'][Math.random() * 4 | 0]}`,
    auth: () => (Math.random() < 0.94 ? 'auth ✓ jwt' : '401 · expired token'),
    service: () => 'validate · map DTO',
    cache: () => (Math.random() < 0.7 ? 'cache hit · redis' : 'cache miss'),
    db: () => `SELECT … · ${1 + (Math.random() * 6 | 0)} ms`,
    kafka: () => '→ kafka · document-uploaded',
  };
  // who talks to whom
  const NEXT = { gateway: ['auth'], auth: ['service'], service: ['cache', 'db', 'kafka'], cache: ['db'], db: [], kafka: [] };

  let W, H, dpr, nodes = [];
  const packets = [], labels = [];
  let served = 0, windowStart = performance.now(), rps = 0, last = '';

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
    for (const n of nodes) {
      n.links = nodes.filter((m) => m !== n && Math.hypot(m.x - n.x, m.y - n.y) < step * 1.45);
    }
  }

  const nearest = (x, y, role) => {
    let best = null, d = Infinity;
    for (const n of nodes) {
      if (role && n.role !== role) continue;
      const e = Math.hypot(n.x - x, n.y - y);
      if (e < d) { d = e; best = n; }
    }
    return best;
  };

  function send(x, y) {
    const gw = nearest(x, y, 'gateway');
    if (!gw) return;
    packets.push({ x, y, from: { x, y }, to: gw, t: 0, trail: ['gateway'], t0: performance.now() });
  }

  function arrive(p) {
    const n = p.to;
    n.glow = 1;
    // one label per node at a time, so two requests landing together don't print on top of each other
    const busy = labels.some((l) => l.node === n && l.life > 0.35);
    const said = busy ? null : SAYS[n.role]();
    if (said && (Math.random() < 0.55 || n.role === 'gateway' || said.startsWith('401'))) labels.push({ node: n, x: n.x, y: n.y, text: said, life: 1 });
    if (said && said.startsWith('401')) return finish(p, 401);
    const nextRoles = NEXT[n.role];
    if (!nextRoles.length || p.trail.length > 5) return finish(p, n.role === 'kafka' ? 202 : 200);
    const role = nextRoles[Math.random() * nextRoles.length | 0];
    const target = n.links.filter((m) => m.role === role).sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y))[0]
      || nearest(n.x, n.y, role);
    p.from = { x: n.x, y: n.y }; p.to = target; p.t = 0; p.trail.push(role);
  }

  function finish(p, status) {
    p.done = true;
    const ms = Math.max(1, Math.round((performance.now() - p.t0) / 40));
    last = `${status} ${status === 202 ? 'Accepted' : status === 401 ? 'Unauthorized' : 'OK'} · ${p.trail.join(' → ')} · ${ms}ms`;
    served++;
  }

  let lastSend = 0;
  window.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastSend < 140 || packets.length > 24) return;
    lastSend = now;
    send(e.clientX * dpr, e.clientY * dpr);
  }, { passive: true });
  window.addEventListener('resize', layout);

  const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3ddc97';
  let color = accent();
  new MutationObserver(() => { color = accent(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function frame(now) {
    ctx.clearRect(0, 0, W, H);
    // mesh
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
    // packets
    for (const p of packets) {
      if (p.done) continue;
      p.t = Math.min(1, p.t + 0.045);
      const x = p.from.x + (p.to.x - p.from.x) * p.t, y = p.from.y + (p.to.y - p.from.y) * p.t;
      ctx.globalAlpha = 0.35; ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(x, y); ctx.stroke();
      ctx.globalAlpha = 0.9; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, 2.6 * dpr, 0, Math.PI * 2); ctx.fill();
      if (p.t >= 1) arrive(p);
    }
    for (let i = packets.length - 1; i >= 0; i--) if (packets[i].done) packets.splice(i, 1);
    // labels
    for (const l of labels) {
      l.life -= 0.012; l.y -= 0.25 * dpr;
      ctx.globalAlpha = Math.max(0, l.life) * 0.75; ctx.fillStyle = color;
      ctx.fillText(l.text, l.x + 8 * dpr, l.y + 14 * dpr);
    }
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].life <= 0) labels.splice(i, 1);
    ctx.globalAlpha = 1;
    // hud
    if (now - windowStart > 1000) { rps = served; served = 0; windowStart = now; }
    hud.textContent = last ? `${rps} req/s · ${last}` : 'move the cursor: you are the client';
    requestAnimationFrame(frame);
  }
  layout();
  requestAnimationFrame(frame);
})();
