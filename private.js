/* "Private projects": what each one does, as a small simulation. No code or data from the repos. */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Buddy Hub: QR ordering → kitchen → billing, all live off one data store ----------
  const ros = $('[data-widget="ros"]');
  if (ros) {
    const MENU = [['Masala dosa', 90], ['Paneer roll', 120], ['Cold coffee', 80]];
    const orders = [];                                   // { id, table, items, total, status, manual }
    const tables = new Map();                            // table -> session expiry (ms)
    const STEPS = ['Preparing', 'Ready', 'Served'];
    let seq = 100;
    const log = (line) => { const out = $('.ros-log', ros); out.innerHTML = (line + '\n' + out.innerHTML).split('\n').slice(0, 6).join('\n'); };

    const render = () => {
      $('.kitchen', ros).innerHTML = orders.filter((o) => o.status !== 'Served').map((o) => `
        <li><b>#${o.id}</b> T${o.table} · ${esc(o.items.join(', '))}<span class="pill s-${o.status.toLowerCase()}">${o.status}${o.manual ? ' · manual' : ''}</span>
          ${o.status !== 'Served' ? `<button type="button" class="mini" data-bump="${o.id}">bump →</button>` : ''}</li>`).join('') || '<li class="dim">no open orders</li>';
      const served = orders.filter((o) => o.status === 'Served');
      $('.billing', ros).innerHTML = served.map((o) => `<li>#${o.id} T${o.table} <b>₹${o.total}</b></li>`).join('') || '<li class="dim">nothing to bill yet</li>';
      $('.ros-total', ros).textContent = `₹${served.reduce((a, o) => a + o.total, 0)}`;
      $('.tables', ros).innerHTML = [1, 2, 3, 4].map((t) => `<span class="${tables.get(t) > Date.now() ? 'busy' : ''}">T${t}</span>`).join('');
    };

    // One login per table, taken atomically; the session expires so an abandoned scan never locks a table.
    const claimTable = (t) => {
      if (tables.get(t) > Date.now()) return false;
      tables.set(t, Date.now() + 20000);
      return true;
    };

    ros.addEventListener('click', (e) => {
      const scan = e.target.closest('[data-scan]');
      const bump = e.target.closest('[data-bump]');
      if (scan) {
        const t = Number(scan.dataset.scan);
        if (!claimTable(t)) { log(`<span class="bad">scan T${t} → 409 table already in use (session expires in ${Math.ceil((tables.get(t) - Date.now()) / 1000)}s)</span>`); render(); return; }
        const pick = MENU.filter((_, i) => (t + i + seq) % 2 === 0).slice(0, 2);
        const items = (pick.length ? pick : [MENU[0]]);
        const o = { id: ++seq, table: t, items: items.map((m) => m[0]), total: items.reduce((a, m) => a + m[1], 0), status: 'Preparing', manual: false };
        orders.push(o);
        log(`<span class="ok">scan T${t} → session claimed · order #${o.id} placed</span>`);
        render();
        (async () => {                                   // automatic progression, unless staff take over
          for (const next of STEPS.slice(1)) {
            await sleep(3500);
            if (o.manual || o.status === 'Served') return;
            o.status = next; log(`#${o.id} → ${next} (timer)`); render();
          }
        })();
      }
      if (bump) {
        const o = orders.find((x) => x.id === Number(bump.dataset.bump));
        o.manual = true;                                 // a manual correction takes the order off the timer for good
        o.status = STEPS[Math.min(STEPS.indexOf(o.status) + 1, 2)];
        log(`#${o.id} → ${o.status} (staff) · off the timer`); render();
      }
    });
    setInterval(render, 1000);
    render();
  }

  // ---------- Goonj Foundation: donation → campaign progress → certificate ----------
  const goonj = $('[data-widget="goonj"]');
  if (goonj) {
    const T = {
      en: { title: 'Keep your street clean', body: 'Use a dustbin, and carry your waste until you find one.', cert: 'Certificate of Appreciation', thanks: 'for supporting civic-sense education' },
      hi: { title: 'अपनी गली साफ़ रखें', body: 'कूड़ेदान का इस्तेमाल करें, और मिलने तक कचरा अपने पास रखें।', cert: 'प्रशंसा प्रमाण पत्र', thanks: 'नागरिक-बोध शिक्षा में सहयोग के लिए' },
    };
    let lang = 'en', raised = 38200;
    const GOAL = 50000;
    const out = $('.w-out', goonj);
    const paint = () => {
      const t = T[lang];
      $('.topic', goonj).innerHTML = `<b>${esc(t.title)}</b><br>${esc(t.body)}`;
      $('.gbar span', goonj).style.width = `${Math.min(100, (raised / GOAL) * 100)}%`;
      $('.graised', goonj).textContent = `₹${raised.toLocaleString('en-IN')} of ₹${GOAL.toLocaleString('en-IN')}`;
      goonj.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    };
    goonj.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
      lang = b.dataset.lang;
      out.innerHTML = `<span class="dim">GET /api/civic?lang=${lang} → 200 · the saved choice wins over the IP-based default</span>`;
      paint();
    }));
    $('form', goonj).addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('input[name="donor"]', goonj).value.trim();
      const amount = Number($('input[name="amount"]', goonj).value);
      if (!name || !(amount >= 1 && amount <= 100000)) {
        out.innerHTML = '<span class="bad">POST /api/donate → 400 · name and an amount between ₹1 and ₹1,00,000 are required</span>';
        return;
      }
      raised += amount;
      const id = 'GF-' + String(Date.now()).slice(-6);
      out.innerHTML = `<span class="ok">POST /api/donate → 201 · donation ${id} stored</span>\n<span class="dim">GET /api/campaign → progress updated</span>\nPOST /api/certificate → 200 · application/pdf`;
      paint();
      // The real app renders the certificate as a PDF on the server (Go + gofpdf). Here, a canvas stands in.
      const c = $('canvas', goonj), g = c.getContext('2d'), t = T[lang];
      g.fillStyle = '#fffaf0'; g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = '#c47f17'; g.lineWidth = 6; g.strokeRect(10, 10, c.width - 20, c.height - 20);
      g.fillStyle = '#6b3d05'; g.textAlign = 'center';
      g.font = '700 22px Georgia, serif'; g.fillText(t.cert, c.width / 2, 60);
      g.font = '700 26px Georgia, serif'; g.fillText(name, c.width / 2, 110);
      g.font = '16px Georgia, serif'; g.fillText(`₹${amount.toLocaleString('en-IN')} · ${t.thanks}`, c.width / 2, 145);
      g.font = '12px monospace'; g.fillText(`${id} · Goonj Foundation`, c.width / 2, 185);
      c.hidden = false;
    });
    paint();
  }

  // ---------- WUS/KUS: one codebase, three installable apps ----------
  const env = $('[data-widget="appenv"]');
  if (env) {
    const CONF = {
      development: { name: 'WUS/KUS Dev', id: 'com.wuskus.dev', api: 'https://dev-api.example', flags: 'debug menu on' },
      preprod: { name: 'WUS/KUS Pre', id: 'com.wuskus.pre', api: 'https://pre-api.example', flags: 'debug menu off' },
      production: { name: 'WUS/KUS', id: 'com.wuskus', api: 'https://api.example', flags: 'debug menu off' },
    };
    const show = (k) => {
      const c = CONF[k];
      env.querySelectorAll('[data-env]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.env === k)));
      $('.w-out', env).innerHTML = `<span class="dim">$ ${k === 'production' ? '' : `APP_ENV=${k} `}npx expo prebuild</span>
app.config.js → name: <span class="ok">"${c.name}"</span>
               ios.bundleIdentifier / android.package: <span class="ok">"${c.id}"</span>
.env.${k === 'production' ? 'production' : k} → API_URL=${c.api} · ${c.flags}
<span class="dim">public config only: anything bundled in an app can be read by its users</span>`;
    };
    env.querySelectorAll('[data-env]').forEach((b) => b.addEventListener('click', () => show(b.dataset.env)));
    show('development');
  }
})();
