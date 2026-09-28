// The UI: a client of the backend that runs in this browser (see sw.js and server/).
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lowerKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

// ======================================================================= backend lifecycle
let worker = null;
let mode = 'offline';            // 'http' (via Service Worker) | 'direct' (postMessage) | 'offline'
const logEntries = [];
let selectedId = null;

function bootLine(text, state = 'ok', ms) {
  const list = $('#boot');
  const last = list.lastElementChild;
  if (last && last.classList.contains('run')) last.remove();
  const li = document.createElement('li');
  li.className = state;
  li.innerHTML = `<span class="mark">${state === 'ok' ? '✓' : state === 'err' ? '✗' : state === 'warn' ? '!' : '…'}</span> ${esc(text)}${ms != null ? ` <span class="ms">${ms} ms</span>` : ''}`;
  list.appendChild(li);
}

function startWorker() {
  worker = new Worker(new URL('./server/worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PostgreSQL took too long to start')), 60000);
    worker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'boot') bootLine(m.text, m.state, m.ms);
      else if (m.type === 'log') addLog(m.entry);
      else if (m.type === 'ready') { clearTimeout(timer); resolve(m); }
      else if (m.type === 'failed') { clearTimeout(timer); reject(new Error(m.message)); }
    });
    worker.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(e.message || 'worker failed to load')); });
  });
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    // Requests intercepted by sw.js arrive here and are passed, reply port included, to the backend worker.
    navigator.serviceWorker.onmessage = (e) => {
      if (e.data && e.data.type === 'http' && worker) worker.postMessage(e.data, e.ports);
    };
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
        sleep(4000),
      ]);
    }
    return Boolean(navigator.serviceWorker.controller);
  } catch {
    return false;
  }
}

// One client for both transports: the page code doesn't care how the request travels.
async function api(method, path, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  let status, resHeaders, text;
  if (mode === 'http') {
    const r = await fetch(path, { method, headers, body: payload, cache: 'no-store' });
    status = r.status;
    resHeaders = Object.fromEntries(r.headers.entries());
    text = status === 204 ? '' : await r.text();
  } else if (mode === 'direct') {
    const r = await new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data);
      worker.postMessage({ type: 'http', request: { method, url: new URL(path, location.href).href, headers: lowerKeys(headers), body: payload ?? null } }, [ch.port2]);
    });
    status = r.status;
    resHeaders = lowerKeys(r.headers);
    text = r.body || '';
  } else {
    throw new Error('backend offline');
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status, headers: resHeaders, json, text };
}

// ======================================================================= request inspector
const STATUS_CLASS = (s) => (s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : 's2');

function addLog(entry) {
  logEntries.unshift(entry);
  if (logEntries.length > 300) logEntries.pop();
  $('#req-count').textContent = String(logEntries.length);
  $('#server-pill-text').textContent = `PostgreSQL · ${logEntries.length} request${logEntries.length === 1 ? '' : 's'}`;
  renderLogList();
}

function renderLogList() {
  $('#net-list').innerHTML = logEntries.map((e) => `
    <button type="button" class="net-row${e.id === selectedId ? ' sel' : ''}" data-id="${esc(e.id)}">
      <span class="st ${STATUS_CLASS(e.status)}">${e.status}</span>
      <span class="m">${esc(e.method)}</span>
      <span class="p">${esc(e.path)}</span>
      <span class="t">${e.ms} ms</span>
      <span class="q" title="SQL statements">${e.sql.length} sql</span>
    </button>`).join('');
}

function prettyBody(text) {
  if (!text) return '(empty)';
  try { return JSON.stringify(JSON.parse(text.replace(/…$/, '')), null, 2); } catch { return text; }
}

function showLog(id) {
  const e = logEntries.find((x) => x.id === id);
  if (!e) return;
  selectedId = id;
  renderLogList();
  const hdrs = (h) => Object.entries(h || {}).map(([k, v]) => `<div><span class="k">${esc(k)}:</span> ${esc(k.toLowerCase() === 'authorization' ? String(v).slice(0, 24) + '…' : v)}</div>`).join('');
  $('#net-detail').innerHTML = `
    <div class="nd-head"><span class="st ${STATUS_CLASS(e.status)}">${e.status}</span> <b class="mono">${esc(e.method)} ${esc(e.path)}</b></div>
    <div class="nd-meta mono">${e.ms} ms · request id ${esc(e.id)}${e.user ? ' · user ' + esc(e.user) : ''} · ${new Date(e.at).toLocaleTimeString()}</div>
    <details open><summary>SQL (${e.sql.length})</summary>${e.sql.length ? `<table class="sqlt mono"><tbody>${e.sql.map((s) => `
      <tr><td class="n">${s.ms} ms</td><td class="n">${s.rows} rows</td><td><code>${esc(s.sql)}</code>${s.params && s.params.length ? `<div class="params">params ${esc(JSON.stringify(s.params).slice(0, 200))}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No SQL for this request.</p>'}</details>
    <details open><summary>Response headers</summary><div class="hdrs mono">${hdrs(e.responseHeaders)}</div></details>
    <details><summary>Request headers</summary><div class="hdrs mono">${hdrs(e.requestHeaders)}</div></details>
    ${e.requestBody ? `<details><summary>Request body</summary><pre class="mono">${esc(prettyBody(e.requestBody))}</pre></details>` : ''}
    <details open><summary>Response body</summary><pre class="mono">${esc(prettyBody(e.responseBody))}</pre></details>`;
}

function openInspector(requestId) {
  selectTab('t-network');
  document.getElementById('backend').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (requestId) showLog(requestId);
}

// ======================================================================= content
const sourceIds = {};

function setSource(name, res, path) {
  const btn = $(`[data-source="${name}"]`);
  if (!btn) return;
  const id = res.headers['x-request-id'];
  sourceIds[name] = id;
  btn.innerHTML = `<span class="st ${STATUS_CLASS(res.status)}">${res.status}</span> GET ${esc(path)} · ${esc(res.headers['x-response-time'] || '')} <span class="go">inspect →</span>`;
  btn.disabled = false;
}

async function fetchSection(name, path) {
  const res = await api('GET', path);
  setSource(name, res, path);
  if (res.status !== 200) throw new Error(`${path} → ${res.status}`);
  return res.json.data;
}

const monthsLabel = (m) => {
  const y = Math.floor(m / 12), r = m % 12;
  return [y ? `${y} yr${y > 1 ? 's' : ''}` : '', r ? `${r} mo${r > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ');
};

function renderProfile(p) {
  $$('[data-bind]').forEach((el) => { if (p[el.dataset.bind]) el.textContent = p[el.dataset.bind]; });
  $('#stats').innerHTML = (p.stats || []).map((s) => `<div><dt>${esc(s.label)}</dt><dd>${esc(s.value)}</dd></div>`).join('');
  const cert = (p.certifications || [])[0];
  $('#creds').innerHTML = [
    cert ? `${esc(cert.name)} · <a href="${esc(cert.url)}" target="_blank" rel="noopener">verify</a>` : '',
    p.education ? esc(p.education) : '',
  ].filter(Boolean).join('<br>');
}

function renderExperience(rows) {
  $('#experience').innerHTML = rows.map((e) => `
    <article class="work-card">
      <p class="when mono">${esc(e.from)} – ${esc(e.to)} · ${esc(monthsLabel(e.months))}</p>
      <h3>${esc(e.title)}</h3>
      <p class="org">${esc(e.company)}</p>
      <ul>${e.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
      <p class="tags">${e.stack.map((s) => `<span>${esc(s)}</span>`).join('')}</p>
    </article>`).join('');
}

function renderProjects(rows) {
  if (!rows.length) {
    $('#project-list').innerHTML = '<p class="muted">No projects match. Try another word or clear the filter.</p>';
    return;
  }
  $('#project-list').innerHTML = rows.map((p) => `
    <article class="card">
      <div class="card-top">
        <span class="badge ${p.visibility}">${p.visibility === 'private' ? 'private' : 'public'}</span>
        <span class="status mono">${esc(p.status)} · ${esc(p.year)}</span>
      </div>
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.summary)}</p>
      ${p.highlights && p.highlights.length ? `<ul class="hl">${p.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      <p class="tags">${p.stack.map((s) => `<span>${esc(s)}</span>`).join('')}</p>
      <div class="card-links">
        ${p.repo_url ? `<a href="${esc(p.repo_url)}" target="_blank" rel="noopener">Code ↗</a>` : '<span class="muted">Private code</span>'}
        ${p.live_url ? `<a href="${esc(p.live_url)}"${p.live_url.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}>Live ↗</a>` : ''}
      </div>
    </article>`).join('');
}

function renderStack(rows) {
  const max = Math.max(...rows.map((r) => r.projects), 1);
  $('#stack').innerHTML = rows.map((r) => `
    <div class="bar"><span class="bar-label mono">${esc(r.tech)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(r.projects / max) * 100}%"></span></span>
      <span class="bar-n mono">${r.projects}</span></div>`).join('');
}

function renderStrengths(rows) {
  $('#strengths').innerHTML = rows.map((s, i) => `
    <div class="strength"><span class="n mono">0${i + 1}</span><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></div>`).join('');
}

// Project search and filter: every change is a real API call (Postgres FTS + array containment).
let tagFilter = '';
let projectTimer = null;
async function refreshProjects() {
  const params = new URLSearchParams();
  const q = $('#project-q').value.trim();
  if (q) params.set('q', q);
  if (tagFilter) params.set('tag', tagFilter);
  const path = '/api/projects' + (params.toString() ? '?' + params : '');
  if (mode === 'offline') return renderProjects(filterOffline(q, tagFilter));
  renderProjects(await fetchSection('projects', path));
}

function renderTagChips(projects) {
  const tags = [...new Set(projects.flatMap((p) => p.tags))];
  $('#project-tags').innerHTML = ['', ...tags].map((t) =>
    `<button type="button" class="chip${t === tagFilter ? ' on' : ''}" data-tag="${esc(t)}">${t ? esc(t) : 'all'}</button>`).join('');
}

// ======================================================================= static fallback
let staticContent = null;
function filterOffline(q, tag) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return staticContent.projects.filter((p) => (!tag || p.tags.includes(tag)) &&
    words.every((w) => [p.name, p.summary, ...p.stack, ...p.tags].join(' ').toLowerCase().includes(w)));
}
function toRows(content) {
  const month = (d) => new Date(d + 'T00:00:00');
  const fmt = (d) => d.toLocaleString('en', { month: 'short', year: 'numeric' });
  return {
    experience: content.experience.map((e) => {
      const from = month(e.start), to = e.end ? month(e.end) : new Date();
      return { ...e, from: fmt(from), to: e.end ? fmt(to) : 'Present',
        months: (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth() + 1 };
    }),
    projects: content.projects.map((p) => ({ ...p, repo_url: p.repo, live_url: p.live })),
    stack: Object.entries([...content.projects, ...content.experience].flatMap((x) => x.stack)
      .reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {}))
      .map(([tech, projects]) => ({ tech, projects })).sort((a, b) => b.projects - a.projects).slice(0, 14),
  };
}

// ======================================================================= auth & tenants playground
const auth = { token: null, user: null };
const showResponse = (label, r) => {
  $('#api-status').innerHTML = `<span class="st ${STATUS_CLASS(r.status)}">${r.status}</span> ${esc(label)}`;
  const keep = ['content-type', 'location', 'www-authenticate', 'retry-after', 'x-ratelimit-remaining', 'x-request-id', 'x-response-time'];
  const h = Object.entries(r.headers).filter(([k]) => keep.includes(k)).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('#api-out').textContent = `${h}\n\n${r.json ? JSON.stringify(r.json, null, 2) : r.text || '(no body)'}`;
};

async function login(name) {
  const r = await api('POST', '/api/auth/login', { body: { username: name, password: `${name}-pass` } });
  showResponse(`POST /api/auth/login (${name})`, r);
  if (r.status === 200) {
    auth.token = r.json.data.accessToken;
    auth.user = name;
    $('#who').textContent = `signed in as ${name} · token ${auth.token.slice(0, 14)}…`;
    $$('[data-login]').forEach((b) => b.classList.toggle('on', b.dataset.login === name));
  }
}

const b64u = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const actions = {
  async list() { showResponse('GET /api/tasks', await api('GET', '/api/tasks', { token: auth.token })); },
  async foreign() {
    const id = auth.user === 'alice' ? 4 : 1;   // alice owns 1–3, bob owns 4–5
    showResponse(`GET /api/tasks/${id} (not yours)`, await api('GET', `/api/tasks/${id}`, { token: auth.token }));
  },
  async create() {
    showResponse('POST /api/tasks', await api('POST', '/api/tasks', { token: auth.token, body: { title: `Task created at ${new Date().toLocaleTimeString()}` } }));
  },
  async conflict() {
    let list = (await api('GET', '/api/tasks', { token: auth.token })).json?.data || [];
    if (!list.length) {
      await api('POST', '/api/tasks', { token: auth.token, body: { title: 'Task to edit' } });
      list = (await api('GET', '/api/tasks', { token: auth.token })).json.data;
    }
    const t = list[0];
    await api('PUT', `/api/tasks/${t.id}`, { token: auth.token, body: { title: t.title, status: 'doing', version: t.version } });
    showResponse(`PUT /api/tasks/${t.id} (stale version ${t.version})`,
      await api('PUT', `/api/tasks/${t.id}`, { token: auth.token, body: { title: t.title, status: 'done', version: t.version } }));
  },
  async admin() { showResponse('GET /api/admin/users', await api('GET', '/api/admin/users', { token: auth.token })); },
  async noauth() { showResponse('GET /api/tasks (no token)', await api('GET', '/api/tasks')); },
  async forge() {
    const [h, p, s] = auth.token.split('.');
    const claims = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    const forged = `${h}.${b64u({ ...claims, role: 'admin' })}.${s}`;
    showResponse('GET /api/admin/users (forged role=admin)', await api('GET', '/api/admin/users', { token: forged }));
  },
  async burst() {
    const counts = {};
    let last;
    for (let i = 0; i < 40; i++) {
      last = await api('GET', '/api/health');
      counts[last.status] = (counts[last.status] || 0) + 1;
      if (last.status === 429) break;
    }
    showResponse(`GET /api/health × ${Object.values(counts).reduce((a, b) => a + b, 0)}  →  ${Object.entries(counts).map(([k, v]) => `${v}× ${k}`).join(', ')}`, last);
  },
};

// ======================================================================= SQL console
const PRESETS = [
  ['Projects by tag', `SELECT name, status, array_to_string(stack, ', ') AS stack
FROM projects
WHERE tags @> ARRAY['backend']
ORDER BY year DESC;`],
  ['Full-text search', `SELECT name, ts_rank(to_tsvector('simple', search_text), q) AS rank
FROM projects, websearch_to_tsquery('simple', 'postgres OR security') q
WHERE to_tsvector('simple', search_text) @@ q
ORDER BY rank DESC;`],
  ['Row-level security as bob', `BEGIN;
SET LOCAL ROLE app_user;                          -- unprivileged, so the RLS policy applies
SELECT set_config('app.user_id', '2', true);      -- bob
SELECT id, owner_id, title FROM tasks;            -- no WHERE, yet only bob's rows
COMMIT;`],
  ['Index 1/3 · 200k orders', `DROP TABLE IF EXISTS orders;
CREATE TABLE orders AS
SELECT g AS id,
       (random() * 20000)::int AS customer_id,
       (ARRAY['pending','paid','shipped','cancelled'])[1 + floor(random() * 4)::int] AS status,
       round((random() * 500)::numeric, 2) AS total
FROM generate_series(1, 200000) g;
ANALYZE orders;
SELECT count(*) FROM orders;`],
  ['Index 2/3 · EXPLAIN (no index)', `EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 4242 AND status = 'shipped';`],
  ['Index 3/3 · add index, EXPLAIN', `CREATE INDEX IF NOT EXISTS orders_customer_status_idx ON orders (customer_id, status);
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 4242 AND status = 'shipped';`],
  ['Tables & sizes', `SELECT relname AS table, n_live_tup AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;`],
];

function renderSqlResults(data) {
  $('#sql-out').innerHTML = data.results.map((r) => {
    if (r.fields.length === 1 && r.fields[0] === 'QUERY PLAN') {
      return `<pre class="plan mono">${esc(r.rows.map((x) => x['QUERY PLAN']).join('\n'))}</pre>`;
    }
    if (!r.fields.length) return `<p class="mono muted">OK${r.affectedRows ? ` · ${r.affectedRows} rows affected` : ''}</p>`;
    return `<div class="tbl-wrap"><table class="rt mono"><thead><tr>${r.fields.map((f) => `<th>${esc(f)}</th>`).join('')}</tr></thead>
      <tbody>${r.rows.map((row) => `<tr>${r.fields.map((f) => `<td>${esc(typeof row[f] === 'object' && row[f] !== null ? JSON.stringify(row[f]) : row[f])}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${r.rowCount > r.rows.length ? `<p class="muted mono">showing ${r.rows.length} of ${r.rowCount} rows</p>` : ''}</div>`;
  }).join('');
}

async function runSql() {
  const btn = $('#sql-run');
  btn.disabled = true;
  $('#sql-meta').textContent = 'running…';
  try {
    const r = await api('POST', '/api/sql', { body: { sql: $('#sql-in').value } });
    if (r.status === 200) {
      $('#sql-meta').textContent = `${r.json.data.ms} ms · ${r.json.data.results.length} statement result(s)`;
      renderSqlResults(r.json.data);
    } else {
      $('#sql-meta').textContent = `${r.status}`;
      $('#sql-out').innerHTML = `<pre class="plan err mono">${esc(r.json?.error?.message || r.text)}</pre>`;
    }
  } finally {
    btn.disabled = false;
  }
}

// ======================================================================= tabs, wiring
function selectTab(id) {
  $$('.tabs [role="tab"]').forEach((t) => {
    const on = t.id === id;
    t.setAttribute('aria-selected', String(on));
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  });
}

function wire() {
  $$('.tabs [role="tab"]').forEach((t) => t.addEventListener('click', () => selectTab(t.id)));
  $('#net-list').addEventListener('click', (e) => { const row = e.target.closest('.net-row'); if (row) showLog(row.dataset.id); });
  $$('[data-source]').forEach((b) => b.addEventListener('click', () => openInspector(sourceIds[b.dataset.source])));
  $('#server-pill').addEventListener('click', () => openInspector(logEntries[0]?.id));

  $('#project-q').addEventListener('input', () => { clearTimeout(projectTimer); projectTimer = setTimeout(refreshProjects, 250); });
  $('#project-filters').addEventListener('submit', (e) => { e.preventDefault(); refreshProjects(); });
  $('#project-tags').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    tagFilter = chip.dataset.tag;
    $$('.chip', $('#project-tags')).forEach((c) => c.classList.toggle('on', c === chip));
    refreshProjects();
  });

  $$('[data-login]').forEach((b) => b.addEventListener('click', () => login(b.dataset.login)));
  $$('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    if (mode === 'offline') return;
    if (!auth.token && b.dataset.act !== 'noauth') await login('alice');
    await actions[b.dataset.act]();
  }));

  $('#sql-presets').innerHTML = PRESETS.map(([label], i) => `<button type="button" class="chip" data-preset="${i}">${esc(label)}</button>`).join('');
  $('#sql-presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (b) { $('#sql-in').value = PRESETS[Number(b.dataset.preset)][1]; runSql(); }
  });
  $('#sql-run').addEventListener('click', runSql);
  $('#sql-in').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runSql(); });
  $('#sql-reset').addEventListener('click', async () => {
    if (worker) worker.terminate();
    bootLine('server restarted by you: fresh database', 'warn');
    auth.token = null;
    $('#who').textContent = 'not signed in';
    await startWorker();
    $('#sql-meta').textContent = 'database reset';
    $('#sql-out').innerHTML = '';
  });

  document.querySelector('.theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  });
  $('#year').textContent = new Date().getFullYear();
}

// ======================================================================= main
function renderStatic() {
  const rows = toRows(staticContent);
  staticContent.projects = rows.projects;
  renderProfile({ ...staticContent.profile, stats: staticContent.stats });
  renderExperience(rows.experience);
  renderProjects(rows.projects);
  renderTagChips(rows.projects);
  renderStack(rows.stack);
  renderStrengths(staticContent.strengths);
}

async function main() {
  wire();
  $('#boot').innerHTML = '';

  // 1) Paint instantly from the static JSON, so nobody waits for the database to boot.
  staticContent = await (await fetch('data/portfolio.json')).json();
  renderStatic();
  $$('[data-source]').forEach((b) => { b.textContent = 'static · backend starting…'; b.disabled = true; });

  // 2) Boot the backend, then re-render every section from real API responses.
  try {
    const ready = startWorker();
    const viaSw = await setupServiceWorker();
    bootLine(viaSw ? 'Service Worker registered: HTTP server on /api/*' : 'Service Workers unavailable here: using direct calls', viaSw ? 'ok' : 'warn');
    await ready;
    mode = viaSw ? 'http' : 'direct';
    $('#mode-note').innerHTML = viaSw
      ? 'Mode: <b>HTTP via Service Worker</b>. Open DevTools → Network and filter by <code>/api/</code>. The responses show "(ServiceWorker)" as their source. Opening <a href="/api/projects" target="_blank" rel="noopener">/api/projects</a> in a new tab works while this tab is open.'
      : 'Mode: <b>direct</b>. This browser has Service Workers disabled (common in private windows), so the UI calls the backend worker directly. Same server code, no HTTP hop.';
  } catch (err) {
    mode = 'offline';
    bootLine(`backend couldn't start (${err.message}). Showing the same content from static JSON.`, 'err');
    $('#server-pill-text').textContent = 'backend offline · static mode';
    $('#mode-note').textContent = "The in-browser backend couldn't start in this browser, so the interactive tools are disabled. Everything else still works.";
  }

  if (mode !== 'offline') {
    try {
      const [profile, experience, projects, stack, strengths] = await Promise.all([
        fetchSection('profile', '/api/profile'),
        fetchSection('experience', '/api/experience'),
        fetchSection('projects', '/api/projects'),
        fetchSection('stack', '/api/stack'),
        fetchSection('strengths', '/api/strengths'),
      ]);
      renderProfile(profile);
      renderExperience(experience);
      renderProjects(projects);
      renderTagChips(projects);
      renderStack(stack);
      renderStrengths(strengths);
      bootLine('page re-rendered from 5 API calls: click any "GET /api/…" label to inspect it');
      return;
    } catch (err) {
      mode = 'offline';
      bootLine(`API error (${err.message}). Keeping the static content.`, 'err');
    }
  }
  $$('[data-source]').forEach((b) => { b.textContent = 'static fallback'; b.disabled = true; });
}

main();
