/* The request's journey: the scroll-following status bar and the small widget at each hop. */
(() => {
  'use strict';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- resume edition (the head script already negotiated it) ----------
  const EDITIONS = {
    th: { file: 'assets/resume-thailand.pdf', name: 'thailand' },
    in: { file: 'assets/resume-india.pdf', name: 'india' },
    remote: { file: 'assets/resume-remote.pdf', name: 'remote' },
  };
  const html = document.documentElement;
  function applyEdition(region, why) {
    const ed = EDITIONS[region] || EDITIONS.remote;
    html.setAttribute('data-region', region);
    document.querySelectorAll('a[data-resume]').forEach((a) => {
      a.href = ed.file;
      a.setAttribute('download', `Sudheer_Kumar_Gupta_Resume_${ed.name}.pdf`);
    });
    document.querySelectorAll('[data-edition]').forEach((el) => { el.textContent = ed.name; });
    document.querySelectorAll('[data-set-region]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setRegion === region)));
    const whyEl = document.getElementById('region-why');
    if (whyEl) whyEl.textContent = why;
  }
  applyEdition(html.getAttribute('data-region') || 'remote', html.getAttribute('data-region-why') || 'default');
  document.querySelectorAll('[data-set-region]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem('region', b.dataset.setRegion); } catch (e) {}
    applyEdition(b.dataset.setRegion, 'your choice');
  }));

  // ---------- HUD: which hop is the request at? ----------
  const hops = Array.from(document.querySelectorAll('.hop'));
  const hudHop = document.getElementById('hud-hop');
  const hudT = document.getElementById('hud-t');
  const hudFill = document.getElementById('hud-fill');

  function setActive(hop) {
    const i = hops.indexOf(hop);
    hops.forEach((h, j) => {
      h.classList.toggle('active', j === i);
      h.classList.toggle('passed', j < i);
    });
    hudHop.textContent = `hop ${hop.dataset.hop} · ${hop.dataset.name}`;
    hudT.textContent = `t+${hop.dataset.t}ms`;
    hudFill.style.width = `${((i + 1) / hops.length) * 100}%`;
    if (hop.id === 'hop-response') hudT.textContent += ' · 200 OK';
  }

  if (hops.length && 'IntersectionObserver' in window) {
    // A thin band across the middle of the viewport: whichever hop crosses it is "current".
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(e.target); });
    }, { rootMargin: '-45% 0px -50% 0px' });
    hops.forEach((h) => io.observe(h));
  }

  // ---------- 02 token bucket ----------
  const bucketEl = document.querySelector('[data-widget="bucket"]');
  if (bucketEl) {
    const CAP = 10, REFILL = 2;
    let tokens = CAP, last = performance.now();
    const slots = bucketEl.querySelector('.bucket');
    const out = bucketEl.querySelector('.w-out');
    for (let i = 0; i < CAP; i++) slots.appendChild(document.createElement('span'));

    const refill = () => {
      const t = performance.now();
      tokens = Math.min(CAP, tokens + ((t - last) / 1000) * REFILL);
      last = t;
    };
    const draw = () => {
      const full = Math.floor(tokens);
      Array.from(slots.children).forEach((s, i) => s.classList.toggle('full', i < full));
    };
    const send = () => {
      refill();
      if (tokens >= 1) { tokens -= 1; return 200; }
      return 429;
    };

    bucketEl.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const n = act.dataset.act === 'burst' ? 12 : 1;
      const results = Array.from({ length: n }, send);
      const ok = results.filter((r) => r === 200).length;
      const limited = n - ok;
      const retry = Math.ceil((1 - (tokens % 1)) / REFILL);
      out.innerHTML = limited
        ? `<span class="ok">${ok} × 200 OK</span>\n<span class="bad">${limited} × 429 Too Many Requests</span>\nRetry-After: ${retry}s  <span class="dim"># refilling at ${REFILL}/s</span>`
        : `<span class="ok">200 OK</span>  <span class="dim">X-RateLimit-Remaining: ${Math.floor(tokens)}</span>`;
      draw();
    });
    setInterval(() => { refill(); draw(); }, 200);
    draw();
  }

  // ---------- 03 JWT ----------
  const jwtEl = document.querySelector('[data-widget="jwt"]');
  if (jwtEl) {
    const b64u = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const header = { alg: 'HS256', typ: 'JWT' };
    const iat = Math.floor(Date.now() / 1000);
    const claims = { sub: 'recruiter', role: 'USER', iat, exp: iat + 900 };
    const signature = 'Q2hvc2VuQnlUaGVTZXJ2ZXItT25seS1JdC1Lbm93cy1UaGUtS2V5';
    const [jh, jp, js] = ['.jh', '.jp', '.js'].map((s) => jwtEl.querySelector(s));
    const payloadOut = jwtEl.querySelector('.jwt-payload');
    const verdict = jwtEl.querySelector('.verdict');
    const toggle = jwtEl.querySelector('[data-act="tamper"]');

    const draw = () => {
      const tampered = toggle.checked;
      const body = { ...claims, role: tampered ? 'ADMIN' : 'USER' };
      jh.textContent = b64u(header);
      jp.textContent = b64u(body);
      js.textContent = signature.slice(0, 22) + '…';
      jp.classList.toggle('changed', tampered);
      payloadOut.textContent = JSON.stringify(body, null, 2);
      verdict.className = 'verdict mono ' + (tampered ? 'bad' : 'ok');
      verdict.textContent = tampered
        ? '✗ HMAC(header.payload) ≠ signature → 401 INVALID_TOKEN'
        : '✓ signature valid · not expired · role USER → continue';
    };
    toggle.addEventListener('change', draw);
    draw();
  }

  // ---------- 04 pods ----------
  const podsEl = document.querySelector('[data-widget="pods"]');
  if (podsEl) {
    const grid = podsEl.querySelector('.pods');
    const out = podsEl.querySelector('.w-out');
    const btn = podsEl.querySelector('[data-act="spike"]');
    const MIN = 3, MAX = 8;
    let replicas = MIN, spiking = false, timer = null;

    const draw = (cpu) => {
      while (grid.children.length < replicas) {
        const p = document.createElement('span');
        p.className = 'pod new';
        grid.appendChild(p);
        requestAnimationFrame(() => p.classList.remove('new'));
      }
      while (grid.children.length > replicas) grid.lastChild.remove();
      grid.classList.toggle('hot', cpu > 75);
      out.textContent = `replicas ${replicas}/${spiking ? MAX : MIN} · cpu ${cpu}%` + (spiking && replicas < MAX ? '  # HPA scaling out…' : '');
    };

    btn.addEventListener('click', () => {
      clearInterval(timer);
      spiking = !spiking;
      btn.textContent = spiking ? 'Traffic back to normal' : 'Simulate a traffic spike';
      if (spiking) {
        let cpu = 91;
        draw(cpu);
        timer = setInterval(() => {
          if (replicas < MAX) { replicas++; cpu = Math.round(91 - (replicas - MIN) * 8); }
          draw(cpu);
          if (replicas >= MAX) clearInterval(timer);
        }, reduceMotion ? 0 : 450);
      } else {
        timer = setInterval(() => {
          if (replicas > MIN) replicas--;
          draw(38);
          if (replicas <= MIN) clearInterval(timer);
        }, reduceMotion ? 0 : 300);
      }
    });
    draw(38);
  }

  // ---------- 05 query plans (illustrative) ----------
  const queryEl = document.querySelector('[data-widget="query"]');
  if (queryEl) {
    const out = queryEl.querySelector('.plan');
    const PLANS = {
      scan: `<span class="dim">EXPLAIN ANALYZE</span> SELECT * FROM tasks
  WHERE owner_id = 42 AND status = 'TODO';

<span class="bad">Seq Scan on tasks</span>  (rows=121)
  Filter: (owner_id = 42 AND status = 'TODO')
  <span class="bad">Rows Removed by Filter: 1,999,879</span>
Execution Time: <span class="bad">412.40 ms</span>`,
      index: `<span class="dim">CREATE INDEX idx_tasks_owner_status
  ON tasks (owner_id, status);</span>

<span class="ok">Index Scan using idx_tasks_owner_status</span>  (rows=121)
  Index Cond: (owner_id = 42 AND status = 'TODO')
Execution Time: <span class="ok">0.11 ms</span>   <span class="dim"># ~3,700× less work</span>`,
      cache: `<span class="dim">GET</span> tasks:owner:42:status:TODO
<span class="ok">HIT</span>  121 items · ttl 58s
Execution Time: <span class="ok">0.30 ms</span>   <span class="dim"># database never touched</span>

<span class="dim"># invalidated on any write to owner 42's tasks,
# so a hit is never stale</span>`,
    };
    const tabs = Array.from(queryEl.querySelectorAll('[data-plan]'));
    const show = (key) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.plan === key)));
      out.innerHTML = PLANS[key];
    };
    tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.plan)));
    show('scan');
  }
})();
