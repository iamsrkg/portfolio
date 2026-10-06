/* "What I built at work": one small, clickable simulation per job.
   These re-create the pattern in the browser. None of it is client code. */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clock = (d) => d.toTimeString().slice(0, 8);

  // ---------- Freelance: a CMS page with Type-2 versioning ----------
  const cms = $('[data-widget="type2"]');
  if (cms) {
    const rows = [];          // { v, body, by, from: Date, to: Date|null }
    const input = $('textarea', cms), who = $('select', cms), table = $('tbody', cms), asOf = $('input[type="range"]', cms), view = $('.asof-out', cms);
    const save = (body, by, at = new Date()) => {
      const cur = rows.find((r) => !r.to);
      if (cur && cur.body === body) return false;
      if (cur) cur.to = at;                                     // UPDATE … SET valid_to = now()
      rows.push({ v: rows.length + 1, body, by, from: at, to: null }); // INSERT the new version
      return true;
    };
    const t0 = Date.now() - 3 * 60 * 1000;
    save('Services: audit and tax filing.', 'partner', new Date(t0));
    save('Services: audit, tax filing and GST returns.', 'staff', new Date(t0 + 90 * 1000));
    input.value = rows[rows.length - 1].body;

    const render = () => {
      table.innerHTML = rows.map((r) => `<tr class="${r.to ? '' : 'cur'}"><td>v${r.v}</td><td>${esc(r.body)}</td><td>${esc(r.by)}</td>
        <td>${clock(r.from)}</td><td>${r.to ? clock(r.to) : '<b>current</b>'}</td></tr>`).join('');
      asOf.max = rows.length - 1;
      asOf.value = Math.min(Number(asOf.value), rows.length - 1);
      showAsOf();
    };
    const showAsOf = () => {
      const r = rows[Number(asOf.value)];
      // SELECT body FROM page_versions WHERE valid_from <= :t AND (valid_to IS NULL OR valid_to > :t)
      view.innerHTML = `<span class="dim">SELECT … WHERE valid_from &lt;= '${clock(r.from)}' AND (valid_to IS NULL OR valid_to &gt; '${clock(r.from)}')</span>\n→ v${r.v} by ${esc(r.by)}: "${esc(r.body)}"`;
    };
    $('[data-act="save"]', cms).addEventListener('click', () => {
      const ok = save(input.value.trim() || '(empty)', who.value);
      render();
      if (ok) { asOf.value = rows.length - 1; showAsOf(); }
    });
    asOf.addEventListener('input', showAsOf);
    asOf.value = rows.length - 1;
    render();
  }

  // ---------- Accenture 2024: a governance report over a paged API ----------
  const gov = $('[data-widget="graph"]');
  if (gov) {
    const out = $('.w-out', gov), btn = $('[data-act="run"]', gov), dl = $('[data-act="csv"]', gov);
    // A pretend tenant: 230 Teams, some without an owner.
    const teams = Array.from({ length: 230 }, (_, i) => ({ id: `t-${1000 + i}`, name: `Team ${String(i + 1).padStart(3, '0')}`, owners: (i * 37) % 11 === 0 ? 0 : 1 + (i % 3) }));
    let report = [];
    btn.addEventListener('click', async () => {
      btn.disabled = true; dl.hidden = true; report = [];
      const lines = [];
      const log = (l) => { lines.push(l); out.innerHTML = lines.slice(-9).join('\n'); };
      let page = 0, calls = 0;
      const t = performance.now();
      while (page * 100 < teams.length) {
        const batch = teams.slice(page * 100, page * 100 + 100);
        calls++;
        log(`<span class="dim">GET /v1.0/groups?$filter=…Team…${page ? `&amp;$skiptoken=${page}` : ''}</span> → 200 · ${batch.length} teams`);
        await sleep(260);
        for (const g of batch) { calls++; if (!g.owners) report.push(g); }
        log(`  checked owners of ${batch.length} teams · <span class="bad">${report.length} ownerless so far</span>`);
        await sleep(200);
        page++;
        log(page * 100 < teams.length ? '  <span class="dim">@odata.nextLink present → next page</span>' : '  <span class="ok">no nextLink → done</span>');
      }
      log(`<span class="ok">✓ ${teams.length} teams · ${calls} API calls · ${report.length} ownerless · ${Math.round(performance.now() - t)} ms</span>`);
      log(`<span class="dim">by hand: open ${teams.length} teams in the admin portal, one at a time</span>`);
      btn.disabled = false; dl.hidden = false;
    });
    dl.addEventListener('click', () => {
      const csv = 'Team,Id\n' + report.map((r) => `${r.name},${r.id}`).join('\n');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'ownerless-teams.csv' });
      a.click(); URL.revokeObjectURL(a.href);
    });
  }

  // ---------- Accenture 2021: uploads, synchronous vs through a queue ----------
  const up = $('[data-widget="queue"]');
  if (up) {
    const out = $('.w-out', up), bar = $('.qbar span', up), depth = $('.qdepth', up);
    const btns = up.querySelectorAll('[data-mode]');
    const N = 40, PROCESS = 900, WORKERS = 4, THREADS = 8;
    btns.forEach((b) => b.addEventListener('click', async () => {
      btns.forEach((x) => (x.disabled = true));
      const mode = b.dataset.mode;
      const lat = [];
      if (mode === 'sync') {
        // Each request holds a web thread for the whole processing time. With 8 threads, the 40th user waits for 5 rounds.
        for (let round = 0; round < N / THREADS; round++) {
          await sleep(PROCESS / 3);
          for (let k = 0; k < THREADS; k++) lat.push((round + 1) * PROCESS + 20);
          bar.style.width = `${(lat.length / N) * 100}%`;
          depth.textContent = `web threads busy: ${THREADS}/${THREADS} · waiting users: ${N - lat.length}`;
          out.innerHTML = `synchronous: request holds the thread until processing ends\nanswered ${lat.length}/${N} · slowest so far <span class="bad">${Math.max(...lat)} ms</span>`;
        }
      } else {
        // The API stores to S3, publishes an event and answers 202. Workers drain the queue afterwards.
        for (let i = 0; i < N; i++) lat.push(12 + (i % 5));
        out.innerHTML = `queued: 202 Accepted after upload + publish\nanswered ${N}/${N} · slowest <span class="ok">${Math.max(...lat)} ms</span>`;
        let queued = N;
        while (queued > 0) {
          depth.textContent = `queue depth: ${queued} · workers: ${WORKERS}`;
          bar.style.width = `${((N - queued) / N) * 100}%`;
          await sleep(PROCESS / 3);
          queued = Math.max(0, queued - WORKERS);
        }
        bar.style.width = '100%';
        depth.textContent = 'queue depth: 0 · all documents processed';
      }
      const avg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
      out.innerHTML += `\n<span class="dim">users waited on average</span> ${avg} ms ${mode === 'sync' ? '<span class="bad">(and a spike means timeouts)</span>' : '<span class="ok">(a spike just makes the queue longer)</span>'}`;
      btns.forEach((x) => (x.disabled = false));
    }));
  }
  // ---------- phone menu ----------
  const nav = $('.nav'), menuBtn = $('.menu-btn');
  if (nav && menuBtn) {
    const setOpen = (open) => { nav.classList.toggle('open', open); menuBtn.setAttribute('aria-expanded', String(open)); };
    menuBtn.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
    nav.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  }

  // ---------- stops of the request fold on phones ----------
  document.querySelectorAll('.hop-more').forEach((b) => b.addEventListener('click', () => {
    const hop = b.closest('.hop');
    const open = !hop.classList.contains('open');
    hop.classList.toggle('open', open);
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? 'hide details ▴' : 'details ▾';
  }));
  // a link or button that points into a folded stop opens it first
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#hop-"]');
    const hop = a && document.querySelector(a.getAttribute('href'));
    if (hop && !hop.classList.contains('open')) hop.querySelector('.hop-more')?.click();
  });
  // ---------- availability: from the start date on, say "can join immediately" ----------
  const avail = $('.avail[data-from]');
  if (avail && new Date() >= new Date(avail.dataset.from + 'T00:00:00')) {
    avail.querySelector('.avail-text').textContent = 'Open to work · can join immediately';
    $('.notice[data-until]')?.remove();
    const json = $('#avail-json');
    if (json) json.textContent = '"immediately"';
  }
})();

// Section links scroll the page without adding "#section" to the address, so the URL stays clean.
// A link that arrives with one (from the 404 page or a note) still lands on its section, then the address is tidied.
(() => {
  'use strict';
  const clean = () => { if (location.hash) history.replaceState(null, '', location.pathname + location.search); };
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const id = a.getAttribute('href').slice(1);
    if (id === 'resume-form') return;                    // opens the dialog instead
    const target = id ? document.getElementById(id) : document.body;
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView();                             // the stylesheet makes this smooth and leaves room for the top bar
    if (id && id !== 'top') {                            // keep keyboard and screen-reader users in step with the scroll
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  });
  // A link that arrives with "#section": the page above it keeps changing height for a moment after loading
  // (fonts, the folded stops, the live API), so stay on the section until it settles or the visitor scrolls.
  const arrived = location.hash.length > 1 && location.hash !== '#resume-form' && document.getElementById(location.hash.slice(1));
  if (arrived) {
    const hold = () => arrived.scrollIntoView({ behavior: 'instant' });
    const settle = new ResizeObserver(hold);
    const release = () => { settle.disconnect(); ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach((t) => removeEventListener(t, release)); };
    settle.observe(document.body);
    ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach((t) => addEventListener(t, release, { passive: true }));
    window.addEventListener('load', () => { hold(); setTimeout(release, 2500); });
  }
  window.addEventListener('load', () => setTimeout(clean, 400));
  window.addEventListener('hashchange', clean);
})();
