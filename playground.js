/*
 * API lab: an in-browser port of the task-management-api contract.
 * Real HS256 JWTs and PBKDF2 password hashing (Web Crypto), a token-bucket rate limiter,
 * tenant-scoped queries, optimistic locking and a uniform response envelope.
 */
(() => {
  'use strict';

  const root = document.getElementById('playground');
  if (!root) return;
  const $ = (sel) => root.querySelector(sel);

  if (!(window.crypto && crypto.subtle)) {
    root.innerHTML = '<p class="pg-fallback">This demo needs a browser with Web Crypto (any current Chrome, Edge, Firefox or Safari over HTTPS).</p>';
    return;
  }

  // ---------- encoding ----------
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const toB64u = (buf) => {
    let s = '';
    new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64u = (str) => {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  };
  const jsonToB64u = (obj) => toB64u(enc.encode(JSON.stringify(obj)));
  const b64uToJson = (str) => JSON.parse(dec.decode(fromB64u(str)));
  const iso = () => new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const newRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ---------- security ----------
  const TOKEN_TTL = 900;
  const PBKDF2_ITERATIONS = 100000;
  const signingKey = crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  async function signJwt(claims) {
    const unsigned = jsonToB64u({ alg: 'HS256', typ: 'JWT' }) + '.' + jsonToB64u(claims);
    const sig = await crypto.subtle.sign('HMAC', await signingKey, enc.encode(unsigned));
    return unsigned + '.' + toB64u(sig);
  }

  // The header's "alg" is never trusted: every token is verified as HS256, so "alg":"none" gets nowhere.
  async function verifyJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed token');
    let sig, claims;
    try { sig = fromB64u(parts[2]); claims = b64uToJson(parts[1]); } catch (e) { throw new Error('Malformed token'); }
    const valid = await crypto.subtle.verify('HMAC', await signingKey, sig, enc.encode(parts[0] + '.' + parts[1]));
    if (!valid) throw new Error('Invalid signature');
    if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('Token expired');
    return claims;
  }

  async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
    return { salt, hash: toB64u(bits) };
  }

  // ---------- data ----------
  const db = { users: [], projects: [], tasks: [], seq: { user: 0, project: 0, task: 0 } };
  const STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'];

  async function seed() {
    for (const [username, password, role] of [['alice', 'alice123', 'USER'], ['bob', 'bob123', 'USER'], ['admin', 'admin123', 'ADMIN']]) {
      const { salt, hash } = await hashPassword(password);
      db.users.push({ id: ++db.seq.user, username, role, salt, hash, createdAt: iso() });
    }
    db.projects.push({ id: ++db.seq.project, name: 'Payments revamp', ownerId: 1 });
    db.projects.push({ id: ++db.seq.project, name: 'Mobile onboarding', ownerId: 2 });
    const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const task = (title, projectId, ownerId, assigneeId, status, h) =>
      db.tasks.push({ id: ++db.seq.task, title, projectId, ownerId, assigneeId, status, version: 0, updatedAt: hoursAgo(h) });
    task('Design idempotent payment API', 1, 1, 1, 'IN_PROGRESS', 1);
    task('Add Redis cache for FX rates', 1, 1, 1, 'TODO', 2);
    task('Write Flyway migration V7', 1, 1, 2, 'TODO', 3);
    task('Load-test checkout with k6', 1, 1, 1, 'DONE', 5);
    task('Fix N+1 query on /orders', 1, 1, 1, 'TODO', 8);
    task('Push notification service', 2, 2, 2, 'IN_PROGRESS', 4);
    task('OAuth2 social login', 2, 2, 2, 'TODO', 6);
  }
  const ready = seed();

  const userDto = (u) => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt });
  const taskDto = (t) => ({ id: t.id, title: t.title, status: t.status, projectId: t.projectId, ownerId: t.ownerId,
    assigneeId: t.assigneeId, version: t.version, updatedAt: t.updatedAt });
  const canSee = (t, uid) => t.ownerId === uid || t.assigneeId === uid;

  // ---------- rate limiting: token bucket, one per client ----------
  const BUCKET = { capacity: 10, refillPerSec: 2, tokens: 10, last: performance.now() };
  function takeToken() {
    const t = performance.now();
    BUCKET.tokens = Math.min(BUCKET.capacity, BUCKET.tokens + ((t - BUCKET.last) / 1000) * BUCKET.refillPerSec);
    BUCKET.last = t;
    if (BUCKET.tokens < 1) return { ok: false, remaining: 0, retryAfter: Math.ceil((1 - BUCKET.tokens) / BUCKET.refillPerSec) };
    BUCKET.tokens -= 1;
    return { ok: true, remaining: Math.floor(BUCKET.tokens) };
  }

  // ---------- errors & envelope ----------
  class HttpError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.status = status; this.code = code; this.details = details;
    }
  }
  const ok = (data, status = 200) => ({ status, body: { success: true, data, timestamp: iso() } });

  // ---------- resilience: what happens when the database misbehaves ----------
  // mode: healthy | slow (every query hangs past the 500 ms timeout) | down (connection refused)
  const DB = { mode: 'healthy', timeoutMs: 500, attempts: 3 };
  const BREAKER = { state: 'closed', failures: 0, threshold: 3, openedAt: 0, coolMs: 10000 };
  const unavailable = (ctx, why, retryAfter) => {
    ctx.headers['Retry-After'] = String(retryAfter);
    return new HttpError(503, 'SERVICE_UNAVAILABLE', why, { retryAfterSeconds: retryAfter });
  };
  function dbCall(ctx, sql, args) {
    const query = sql + (args ? '  <- ' + JSON.stringify(args) : '');
    if (BREAKER.state === 'open') {
      const left = BREAKER.coolMs - (performance.now() - BREAKER.openedAt);
      if (left > 0) {
        ctx.step('CircuitBreaker', false, `open · failing fast, the database is not called (${Math.ceil(left / 1000)}s until a trial request)`, 0.05);
        throw unavailable(ctx, 'Database unavailable (circuit open). Try again shortly.', Math.ceil(left / 1000));
      }
      BREAKER.state = 'half-open';
      ctx.step('CircuitBreaker', true, 'half-open · letting one trial request through', 0.05);
    }
    if (DB.mode === 'healthy') {
      ctx.step('Repository', true, query, 1 + Math.random() * 3);
      if (BREAKER.state === 'half-open' || BREAKER.failures) {
        const wasHalfOpen = BREAKER.state === 'half-open';
        BREAKER.state = 'closed'; BREAKER.failures = 0;
        if (wasHalfOpen) ctx.step('CircuitBreaker', true, 'closed · trial succeeded, back to normal', 0.05);
      }
      return;
    }
    for (let attempt = 1; attempt <= DB.attempts; attempt++) {
      if (DB.mode === 'slow') ctx.step('Repository', false, `attempt ${attempt}: no answer within the ${DB.timeoutMs} ms timeout · ${query}`, DB.timeoutMs);
      else ctx.step('Repository', false, `attempt ${attempt}: connection refused · ${query}`, 1.5);
      if (attempt < DB.attempts) {
        const backoff = 50 * 2 ** (attempt - 1);
        ctx.step('Retry', true, `backing off ${backoff} ms, then retrying`, backoff);
      }
    }
    BREAKER.failures++;
    if (BREAKER.state === 'half-open' || BREAKER.failures >= BREAKER.threshold) {
      BREAKER.state = 'open'; BREAKER.openedAt = performance.now();
      ctx.step('CircuitBreaker', false, `opened after ${BREAKER.failures} failed request${BREAKER.failures > 1 ? 's' : ''} · the next ${BREAKER.coolMs / 1000}s fail fast`, 0.05);
    } else {
      ctx.step('CircuitBreaker', true, `closed · ${BREAKER.failures}/${BREAKER.threshold} failures before it opens`, 0.05);
    }
    throw unavailable(ctx, `Database ${DB.mode === 'slow' ? 'timed out' : 'unreachable'} after ${DB.attempts} attempts.`, 5);
  }
  const STATUS = { 503: 'Service Unavailable', 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 429: 'Too Many Requests', 500: 'Internal Server Error' };

  function validate(ctx, rules) {
    const errors = rules.filter(([pass]) => !pass).map(([, field, message]) => ({ field, message }));
    if (errors.length) {
      ctx.step('@Valid', false, errors.length + ' field error' + (errors.length > 1 ? 's' : ''));
      throw new HttpError(400, 'VALIDATION_FAILED', 'Request validation failed', errors);
    }
    ctx.step('@Valid', true, 'constraints satisfied');
  }

  // ---------- routing ----------
  const routes = [];
  function route(method, pattern, opts, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth: true, ...opts, handler });
  }
  function resolve(method, path) {
    let pathMatched = false;
    for (const r of routes) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch (e) { params[k] = m[i + 1]; } });
      return { r, params };
    }
    return { pathMatched };
  }

  const AUTH = 'c.i.tasks.web.AuthController';
  const TASKS = 'c.i.tasks.web.TaskController';

  route('GET', '/actuator/health', { auth: false, ctrl: 'o.s.b.a.health.HealthEndpoint' }, () => {
    const dbUp = DB.mode === 'healthy';
    return {
      status: dbUp ? 200 : 503,
      body: { status: dbUp ? 'UP' : 'DOWN', components: {
        db: { status: dbUp ? 'UP' : 'DOWN', details: { database: 'PostgreSQL', ...(dbUp ? { validationQuery: 'isValid()' } : { error: DB.mode === 'slow' ? 'validation query timed out' : 'connection refused' }) } },
        circuitBreaker: { status: BREAKER.state === 'open' ? 'OPEN' : BREAKER.state === 'half-open' ? 'HALF_OPEN' : 'CLOSED' },
        ping: { status: 'UP' } } },
    };
  });

  route('POST', '/api/auth/register', { auth: false, ctrl: AUTH }, async (ctx) => {
    const b = ctx.body || {};
    validate(ctx, [
      [typeof b.username === 'string' && /^[a-z0-9_]{3,20}$/i.test(b.username), 'username', 'must be 3-20 letters, digits or _'],
      [typeof b.password === 'string' && b.password.length >= 8, 'password', 'must be at least 8 characters'],
    ]);
    ctx.sql('SELECT 1 FROM users WHERE lower(username) = lower(?)', [b.username]);
    if (db.users.some((u) => u.username.toLowerCase() === b.username.toLowerCase())) {
      throw new HttpError(409, 'USERNAME_TAKEN', 'Username is already registered');
    }
    const { salt, hash } = await hashPassword(b.password);
    ctx.step('PasswordEncoder', true, `PBKDF2-SHA256 · ${PBKDF2_ITERATIONS / 1000}k iterations · random salt`);
    const u = { id: ++db.seq.user, username: b.username, role: 'USER', salt, hash, createdAt: iso() };
    db.users.push(u);
    ctx.sql('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [u.username, '<hash>', 'USER']);
    ctx.headers.Location = '/api/users/' + u.id;
    return ok(userDto(u), 201);
  });

  route('POST', '/api/auth/login', { auth: false, ctrl: AUTH }, async (ctx) => {
    const b = ctx.body || {};
    validate(ctx, [
      [typeof b.username === 'string' && b.username.length > 0, 'username', 'must not be blank'],
      [typeof b.password === 'string' && b.password.length > 0, 'password', 'must not be blank'],
    ]);
    ctx.sql('SELECT id, password_hash, salt, role FROM users WHERE username = ?', [b.username]);
    const u = db.users.find((x) => x.username === b.username);
    // Hash even for unknown users so response time doesn't reveal which usernames exist.
    const { hash } = await hashPassword(b.password, u ? u.salt : new Uint8Array(16));
    if (!u || hash !== u.hash) {
      ctx.step('PasswordEncoder', false, 'no match · same answer for unknown users');
      throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid username or password');
    }
    ctx.step('PasswordEncoder', true, 'PBKDF2 hash matches');
    const iat = Math.floor(Date.now() / 1000);
    const token = await signJwt({ sub: u.username, uid: u.id, role: u.role, iat, exp: iat + TOKEN_TTL });
    ctx.step('JwtService', true, 'signed HS256 · expires in 15 min');
    return ok({ accessToken: token, tokenType: 'Bearer', expiresIn: TOKEN_TTL });
  });

  route('GET', '/api/users/me', { ctrl: 'c.i.tasks.web.UserController' }, (ctx) => {
    ctx.sql('SELECT * FROM users WHERE id = ?', [ctx.user.uid]);
    const u = db.users.find((x) => x.id === ctx.user.uid);
    if (!u) throw new HttpError(404, 'USER_NOT_FOUND', 'User no longer exists');
    return ok(userDto(u));
  });

  route('GET', '/api/admin/users', { role: 'ADMIN', ctrl: 'c.i.tasks.web.AdminController' }, (ctx) => {
    ctx.sql('SELECT * FROM users ORDER BY id');
    return ok(db.users.map(userDto));
  });

  route('GET', '/api/projects', { ctrl: 'c.i.tasks.web.ProjectController' }, (ctx) => {
    ctx.sql('SELECT * FROM projects WHERE owner_id = ?', [ctx.user.uid]);
    return ok(db.projects.filter((p) => p.ownerId === ctx.user.uid));
  });

  route('POST', '/api/projects', { ctrl: 'c.i.tasks.web.ProjectController' }, (ctx) => {
    const b = ctx.body || {};
    validate(ctx, [[typeof b.name === 'string' && b.name.trim().length > 0 && b.name.length <= 60, 'name', 'must be 1-60 characters']]);
    const p = { id: ++db.seq.project, name: b.name.trim(), ownerId: ctx.user.uid };
    db.projects.push(p);
    ctx.sql('INSERT INTO projects (name, owner_id) VALUES (?, ?)', [p.name, p.ownerId]);
    ctx.headers.Location = '/api/projects/' + p.id;
    return ok(p, 201);
  });

  route('GET', '/api/tasks', { ctrl: TASKS }, (ctx) => {
    const q = ctx.query;
    const page = q.page === undefined ? 0 : Number(q.page);
    const size = q.size === undefined ? 10 : Number(q.size);
    const [sortField, sortDir = 'desc'] = (q.sort || 'updatedAt,desc').split(',');
    const COLUMNS = { updatedAt: 'updated_at', title: 'title', status: 'status', id: 'id' };
    validate(ctx, [
      [q.status === undefined || STATUSES.includes(q.status), 'status', 'must be one of ' + STATUSES.join(', ')],
      [Number.isInteger(page) && page >= 0, 'page', 'must be an integer ≥ 0'],
      [Number.isInteger(size) && size >= 1 && size <= 50, 'size', 'must be between 1 and 50'],
      [COLUMNS[sortField] !== undefined && ['asc', 'desc'].includes(sortDir), 'sort', 'use field,dir with field in updatedAt|title|status|id'],
    ]);
    const uid = ctx.user.uid;
    const args = [uid, uid].concat(q.status ? [q.status] : [], [size, page * size]);
    // Sort column comes from a whitelist, never from raw input.
    ctx.sql(`SELECT * FROM tasks WHERE (owner_id = ? OR assignee_id = ?)${q.status ? ' AND status = ?' : ''} ORDER BY ${COLUMNS[sortField]} ${sortDir.toUpperCase()} LIMIT ? OFFSET ?`, args);
    const rows = db.tasks.filter((t) => canSee(t, uid) && (!q.status || t.status === q.status));
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => (a[sortField] < b[sortField] ? -1 : a[sortField] > b[sortField] ? 1 : 0) * dir);
    return ok({
      content: rows.slice(page * size, page * size + size).map(taskDto),
      page, size, totalElements: rows.length, totalPages: Math.ceil(rows.length / size), sort: sortField + ',' + sortDir,
    });
  });

  function findVisibleTask(ctx) {
    const id = Number(ctx.params.id);
    ctx.sql('SELECT * FROM tasks WHERE id = ? AND (owner_id = ? OR assignee_id = ?)', [ctx.params.id, ctx.user.uid, ctx.user.uid]);
    const t = db.tasks.find((x) => x.id === id && canSee(x, ctx.user.uid));
    if (!t) {
      ctx.step('TenantScope', false, '0 rows · outside your tenant or missing, same answer');
      throw new HttpError(404, 'TASK_NOT_FOUND', `Task ${ctx.params.id} not found`);
    }
    return t;
  }

  route('GET', '/api/tasks/{id}', { ctrl: TASKS }, (ctx) => {
    const t = findVisibleTask(ctx);
    ctx.headers.ETag = `W/"${t.version}"`;
    return ok(taskDto(t));
  });

  route('POST', '/api/tasks', { ctrl: TASKS }, (ctx) => {
    const b = ctx.body || {};
    validate(ctx, [
      [typeof b.title === 'string' && b.title.trim().length > 0 && b.title.length <= 120, 'title', 'must be 1-120 characters'],
      [Number.isInteger(b.projectId), 'projectId', 'must be an integer'],
      [b.status === undefined || STATUSES.includes(b.status), 'status', 'must be one of ' + STATUSES.join(', ')],
      [b.assigneeId === undefined || Number.isInteger(b.assigneeId), 'assigneeId', 'must be an integer'],
    ]);
    ctx.sql('SELECT * FROM projects WHERE id = ? AND owner_id = ?', [b.projectId, ctx.user.uid]);
    if (!db.projects.some((p) => p.id === b.projectId && p.ownerId === ctx.user.uid)) {
      throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project ${b.projectId} not found`);
    }
    if (b.assigneeId !== undefined && !db.users.some((u) => u.id === b.assigneeId)) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Request validation failed', [{ field: 'assigneeId', message: 'user does not exist' }]);
    }
    const t = { id: ++db.seq.task, title: b.title.trim(), projectId: b.projectId, ownerId: ctx.user.uid,
      assigneeId: b.assigneeId === undefined ? ctx.user.uid : b.assigneeId, status: b.status || 'TODO', version: 0, updatedAt: iso() };
    db.tasks.push(t);
    ctx.sql('INSERT INTO tasks (title, project_id, owner_id, assignee_id, status, version) VALUES (?, ?, ?, ?, ?, 0)',
      [t.title, t.projectId, t.ownerId, t.assigneeId, t.status]);
    ctx.headers.Location = '/api/tasks/' + t.id;
    return ok(taskDto(t), 201);
  });

  route('PUT', '/api/tasks/{id}', { ctrl: TASKS }, (ctx) => {
    const b = ctx.body || {};
    validate(ctx, [
      [typeof b.title === 'string' && b.title.trim().length > 0 && b.title.length <= 120, 'title', 'must be 1-120 characters'],
      [STATUSES.includes(b.status), 'status', 'must be one of ' + STATUSES.join(', ')],
      [Number.isInteger(b.version), 'version', 'is required for optimistic locking'],
    ]);
    const t = findVisibleTask(ctx);
    ctx.sql('UPDATE tasks SET title = ?, status = ?, version = version + 1 WHERE id = ? AND version = ?', [b.title, b.status, t.id, b.version]);
    if (b.version !== t.version) {
      ctx.step('OptimisticLock', false, `0 rows updated · version ${b.version} is stale, current is ${t.version}`);
      throw new HttpError(409, 'OPTIMISTIC_LOCK_CONFLICT', 'Task was modified by another request. Re-fetch and retry.',
        { currentVersion: t.version, providedVersion: b.version });
    }
    Object.assign(t, { title: b.title.trim(), status: b.status, version: t.version + 1, updatedAt: iso() });
    ctx.step('OptimisticLock', true, `1 row updated · version ${t.version - 1} → ${t.version}`);
    ctx.headers.ETag = `W/"${t.version}"`;
    return ok(taskDto(t));
  });

  route('PATCH', '/api/tasks/{id}/status', { ctrl: TASKS }, (ctx) => {
    const b = ctx.body || {};
    validate(ctx, [[STATUSES.includes(b.status), 'status', 'must be one of ' + STATUSES.join(', ')]]);
    const t = findVisibleTask(ctx);
    ctx.sql('UPDATE tasks SET status = ?, version = version + 1 WHERE id = ?', [b.status, t.id]);
    Object.assign(t, { status: b.status, version: t.version + 1, updatedAt: iso() });
    ctx.headers.ETag = `W/"${t.version}"`;
    return ok(taskDto(t));
  });

  route('DELETE', '/api/tasks/{id}', { ctrl: TASKS }, (ctx) => {
    const t = findVisibleTask(ctx);
    if (t.ownerId !== ctx.user.uid) {
      ctx.step('OwnershipCheck', false, 'assignee can see it, only the owner can delete');
      throw new HttpError(403, 'ACCESS_DENIED', 'Only the task owner can delete it');
    }
    ctx.sql('DELETE FROM tasks WHERE id = ? AND owner_id = ?', [t.id, ctx.user.uid]);
    db.tasks.splice(db.tasks.indexOf(t), 1);
    return { status: 204 };
  });

  // ---------- request pipeline ----------
  async function handle(req) {
    await ready;
    const t0 = performance.now();
    const trace = [];
    const headers = { 'Content-Type': 'application/json', 'X-Request-Id': newRequestId() };
    let simulated = 0, lastEnd = 0;
    const elapsed = () => performance.now() - t0 + simulated;
    const step = (name, pass, note, extraMs = 0) => {
      const start = lastEnd;
      simulated += extraMs;
      lastEnd = Math.max(elapsed(), start + 0.05);
      trace.push({ name, pass, note, start, end: lastEnd });
    };
    const [pathname, qs = ''] = req.path.split('?');
    let status, body, user = null, ctrl = 'o.s.web.servlet.DispatcherServlet';

    try {
      const rl = takeToken();
      headers['X-RateLimit-Limit'] = String(BUCKET.capacity);
      headers['X-RateLimit-Remaining'] = String(rl.remaining);
      if (!rl.ok) {
        headers['Retry-After'] = String(rl.retryAfter);
        step('RateLimitFilter', false, `bucket empty · refills ${BUCKET.refillPerSec}/s`);
        throw new HttpError(429, 'RATE_LIMITED', `Too many requests. Retry after ${rl.retryAfter}s.`);
      }
      step('RateLimitFilter', true, `${rl.remaining}/${BUCKET.capacity} tokens left`);

      const { r, params, pathMatched } = resolve(req.method, pathname);
      if (!r) {
        if (pathMatched) {
          step('DispatcherServlet', false, 'method not supported');
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not supported on ${pathname}`);
        }
        step('DispatcherServlet', false, 'no handler mapping');
        throw new HttpError(404, 'NOT_FOUND', `No endpoint ${req.method} ${pathname}`);
      }
      ctrl = r.ctrl;

      if (r.auth) {
        const authz = req.authorization || '';
        if (!authz.startsWith('Bearer ')) {
          headers['WWW-Authenticate'] = 'Bearer';
          step('JwtAuthFilter', false, 'no bearer token');
          throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
        }
        try {
          user = await verifyJwt(authz.slice(7).trim());
        } catch (e) {
          headers['WWW-Authenticate'] = 'Bearer error="invalid_token"';
          step('JwtAuthFilter', false, e.message);
          throw new HttpError(401, 'INVALID_TOKEN', e.message);
        }
        step('JwtAuthFilter', true, `sub=${user.sub} · role=${user.role}`);
        if (r.role && user.role !== r.role) {
          step('@PreAuthorize', false, `hasRole('${r.role}') denied`);
          throw new HttpError(403, 'ACCESS_DENIED', `Requires role ${r.role}`);
        }
        step('@PreAuthorize', true, r.role ? `hasRole('${r.role}')` : 'isAuthenticated()');
      } else {
        step('SecurityFilterChain', true, 'public endpoint');
      }

      let parsed;
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body.trim()) {
        try { parsed = JSON.parse(req.body); } catch (e) {
          step('HttpMessageConverter', false, 'malformed JSON');
          throw new HttpError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
        }
      }

      const ctx = {
        params, query: Object.fromEntries(new URLSearchParams(qs)), body: parsed, user, headers, step,
      };
      ctx.sql = (sql, args) => dbCall(ctx, sql, args);
      const res = await r.handler(ctx);
      status = res.status;
      body = res.body;
    } catch (err) {
      let e = err;
      if (!(e instanceof HttpError)) {
        console.error(e);
        step('GlobalExceptionHandler', false, 'unexpected exception');
        e = new HttpError(500, 'INTERNAL_ERROR', 'Unexpected server error');
      }
      status = e.status;
      body = { success: false, error: { status: e.status, code: e.code, message: e.message, path: pathname, ...(e.details ? { details: e.details } : {}) }, timestamp: iso() };
    }

    step('Response', status < 400, `${status} ${STATUS[status]} written as JSON`, 0.3);
    await sleep(Math.min(simulated, 1800));            // let slow requests feel slow
    if (status === 204) { body = undefined; delete headers['Content-Type']; }
    const ms = Math.max(1, Math.round(lastEnd));
    writeLog(status, req.method, req.path, ms, headers['X-Request-Id'], user && user.sub, ctrl);
    return { status, headers, body, ms, trace };
  }

  // ---------- UI ----------
  const ui = {
    form: $('#pg-form'), method: $('#pg-method'), path: $('#pg-path'), body: $('#pg-body'),
    useAuth: $('#pg-useauth'), token: $('#pg-token'), jwt: $('#pg-jwt'),
    code: $('#pg-code'), time: $('#pg-time'), trace: $('#pg-trace'), headers: $('#pg-headers'), out: $('#pg-out'), log: $('#pg-log'),
  };

  function highlight(obj) {
    return esc(JSON.stringify(obj, null, 2)).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (m, str, colon, lit) => {
        if (str) return colon ? `<span class="j-k">${str}</span>${colon}` : `<span class="j-s">${str}</span>`;
        if (lit) return `<span class="j-l">${m}</span>`;
        return `<span class="j-n">${m}</span>`;
      });
  }

  let thread = 0;
  function writeLog(status, method, path, ms, rid, sub, ctrl) {
    const level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
    thread = (thread % 10) + 1;
    const line = document.createElement('div');
    line.className = 'lv-' + level.toLowerCase();
    line.textContent = `${iso().slice(11, 23)} ${level.padStart(5)} --- [nio-8080-exec-${String(thread).padEnd(2)}] ${ctrl.padEnd(30)} : `
      + `${method} ${path} → ${status} ${STATUS[status]} (${ms}ms) rid=${rid}${sub ? ' user=' + sub : ''}`;
    ui.log.appendChild(line);
    while (ui.log.childElementCount > 200) ui.log.firstChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  let token = null;
  function showToken(t, label) {
    ui.token.textContent = label || (t ? t.slice(0, 16) + '…' + t.slice(-8) : 'not logged in');
    if (!t) { ui.jwt.textContent = 'Log in to get a token.'; return; }
    const [h, p, s] = t.split('.');
    try {
      ui.jwt.innerHTML = highlight({ header: b64uToJson(h), payload: b64uToJson(p), signature: s.slice(0, 20) + '…' });
    } catch (e) { ui.jwt.textContent = 'Token could not be decoded.'; }
  }
  const currentSub = () => { try { return b64uToJson(token.split('.')[1]).sub; } catch (e) { return null; } };

  function render(res) {
    ui.code.textContent = `${res.status} ${STATUS[res.status]}`;
    ui.code.className = 'pg-code s' + String(res.status)[0];
    ui.time.textContent = `${res.ms} ms`;
    const total = Math.max(res.ms, 1);
    const fmt = (ms) => (ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';
    ui.trace.innerHTML = res.trace.map((s) => {
      const left = Math.min((s.start / total) * 100, 99.2), width = Math.max(((s.end - s.start) / total) * 100, 0.8);
      return `<li class="${s.pass ? 'ok' : 'fail'}"><span class="pg-mark">${s.pass ? '✓' : '✗'}</span>`
        + `<span class="pg-step">${esc(s.name)}</span>`
        + `<span class="pg-bar" aria-hidden="true"><i style="left:${left.toFixed(2)}%;width:${Math.min(width, 100 - left).toFixed(2)}%"></i></span>`
        + `<span class="pg-dur">${fmt(s.end - s.start)}</span>`
        + `<span class="pg-note">${esc(s.note || '')}</span></li>`;
    }).join('');
    renderBreaker();
    ui.headers.textContent = `HTTP/1.1 ${res.status} ${STATUS[res.status]}\n`
      + Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    ui.out.innerHTML = res.body === undefined ? '<span class="j-c">(no body)</span>' : highlight(res.body);
  }

  async function execute(overrideToken) {
    const bearer = overrideToken || token;
    let path = ui.path.value.trim() || '/';
    if (!path.startsWith('/')) path = '/' + path;
    const res = await handle({
      method: ui.method.value, path, body: ui.body.value,
      authorization: ui.useAuth.checked && bearer ? 'Bearer ' + bearer : '',
    });
    if (res.status === 200 && res.body && res.body.data && res.body.data.accessToken) {
      token = res.body.data.accessToken;
      showToken(token);
    }
    render(res);
    return res;
  }

  function send(method, path, body, opts = {}) {
    ui.method.value = method;
    ui.path.value = path;
    ui.body.value = body === undefined ? '' : JSON.stringify(body, null, 2);
    ui.useAuth.checked = opts.auth !== false;
    return execute(opts.token);
  }

  async function asAlice() {
    if (!token || currentSub() !== 'alice') await send('POST', '/api/auth/login', { username: 'alice', password: 'alice123' }, { auth: false });
  }

  const scenarios = {
    health: () => send('GET', '/actuator/health', undefined, { auth: false }),
    login: () => send('POST', '/api/auth/login', { username: 'alice', password: 'alice123' }, { auth: false }),
    list: async () => { await asAlice(); return send('GET', '/api/tasks?status=TODO&page=0&size=5&sort=updatedAt,desc'); },
    tenant: async () => { await asAlice(); return send('GET', '/api/tasks/6'); },
    noauth: () => send('GET', '/api/tasks', undefined, { auth: false }),
    admin: async () => { await asAlice(); return send('GET', '/api/admin/users'); },
    invalid: async () => { await asAlice(); return send('POST', '/api/tasks', { title: '', projectId: 'one', status: 'WIP' }); },
    tamper: async () => {
      await asAlice();
      const [h, p, s] = token.split('.');
      const claims = b64uToJson(p);
      claims.role = 'ADMIN';
      const forged = h + '.' + jsonToB64u(claims) + '.' + s;
      showToken(forged, 'forged: role=ADMIN, original signature');
      const res = await send('GET', '/api/admin/users', undefined, { token: forged });
      showToken(token);
      return res;
    },
    conflict: async () => {
      await asAlice();
      const current = await send('GET', '/api/tasks/2');
      if (current.status !== 200) return current;
      const v = current.body.data.version;
      await send('PUT', '/api/tasks/2', { title: 'Add Redis cache for FX rates', status: 'IN_PROGRESS', version: v });
      return send('PUT', '/api/tasks/2', { title: 'Cache FX rates in Redis', status: 'DONE', version: v });
    },
    burst: async () => {
      await asAlice();
      for (let i = 0; i < 20; i++) {
        const res = await send('GET', '/api/tasks?page=0&size=1');
        if (res.status === 429) return res;
      }
    },
  };

  let busy = false;
  async function run(fn) {
    if (busy) return;
    busy = true;
    root.classList.add('busy');
    try { await fn(); } finally { busy = false; root.classList.remove('busy'); }
  }

  root.querySelectorAll('[data-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => run(scenarios[btn.dataset.scenario]));
  });
  ui.form.addEventListener('submit', (e) => { e.preventDefault(); run(() => execute()); });

  // "Try it" links elsewhere on the page scroll here and run a scenario.
  document.querySelectorAll('[data-run]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fn = scenarios[btn.dataset.run];
      if (!fn) return;
      root.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      run(fn);
    });
  });

  const breakerEl = root.querySelector('.pg-breaker');
  function renderBreaker() {
    if (!breakerEl) return;
    const left = Math.ceil((BREAKER.coolMs - (performance.now() - BREAKER.openedAt)) / 1000);
    breakerEl.textContent = BREAKER.state === 'open' && left > 0 ? `circuit breaker: open (${left}s)`
      : BREAKER.state === 'open' ? 'circuit breaker: open (trial due)' : `circuit breaker: ${BREAKER.state}`;
    breakerEl.dataset.state = BREAKER.state;
  }
  root.querySelectorAll('[data-db]').forEach((b) => b.addEventListener('click', () => {
    DB.mode = b.dataset.db;
    root.querySelectorAll('[data-db]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    run(scenarios.health);
  }));
  setInterval(renderBreaker, 1000);

  showToken(null);
  run(scenarios.health);
})();
