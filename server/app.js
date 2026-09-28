/*
 * The backend behind this page. It runs in a Web Worker on top of PostgreSQL (PGlite, WebAssembly)
 * and receives real HTTP requests relayed by the Service Worker (sw.js).
 *
 * Deliberately framework-free, so every piece is visible: routing, rate limiting, JWT auth,
 * row-level security, optimistic locking, SQL tracing.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- schema

export const MIGRATIONS = [
  {
    name: '001_portfolio',
    sql: `
      CREATE TABLE profile (
        id           int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        data         jsonb NOT NULL
      );
      CREATE TABLE experience (
        id           serial PRIMARY KEY,
        company      text NOT NULL,
        title        text NOT NULL,
        kind         text NOT NULL,
        start_date   date NOT NULL,
        end_date     date,
        highlights   text[] NOT NULL DEFAULT '{}',
        stack        text[] NOT NULL DEFAULT '{}'
      );
      CREATE TABLE projects (
        slug         text PRIMARY KEY,
        name         text NOT NULL,
        summary      text NOT NULL,
        year         int NOT NULL,
        visibility   text NOT NULL CHECK (visibility IN ('public', 'private')),
        status       text NOT NULL,
        stack        text[] NOT NULL DEFAULT '{}',
        tags         text[] NOT NULL DEFAULT '{}',
        highlights   text[] NOT NULL DEFAULT '{}',
        repo_url     text,
        live_url     text,
        position     int NOT NULL,
        search_text  text NOT NULL
      );
      CREATE INDEX projects_search_idx ON projects USING gin (to_tsvector('simple', search_text));
      CREATE INDEX projects_tags_idx   ON projects USING gin (tags);
      CREATE TABLE strengths (
        position     int PRIMARY KEY,
        title        text NOT NULL,
        body         text NOT NULL
      );`,
  },
  {
    name: '002_tasks_with_row_level_security',
    sql: `
      CREATE ROLE app_user NOLOGIN;
      CREATE TABLE users (
        id           serial PRIMARY KEY,
        username     text NOT NULL UNIQUE,
        role         text NOT NULL CHECK (role IN ('user', 'admin')),
        salt         text NOT NULL,
        password     text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE tasks (
        id           serial PRIMARY KEY,
        owner_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        status       text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
        version      int NOT NULL DEFAULT 0,
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX tasks_owner_status_idx ON tasks (owner_id, status);

      -- Tenant isolation lives in the database, not in application code:
      -- as app_user, a query can only ever see or write the current user's rows.
      ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON tasks
        USING      (owner_id = NULLIF(current_setting('app.user_id', true), '')::int)
        WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::int);
      GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO app_user;
      GRANT USAGE, SELECT ON SEQUENCE tasks_id_seq TO app_user;`,
  },
];

// ---------------------------------------------------------------- crypto helpers

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
const jsonB64u = (obj) => toB64u(enc.encode(JSON.stringify(obj)));
const b64uJson = (str) => JSON.parse(dec.decode(fromB64u(str)));

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256);
  return { salt: toB64u(salt), hash: toB64u(bits) };
}

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

const STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large',
  429: 'Too Many Requests', 500: 'Internal Server Error' };

// ---------------------------------------------------------------- server

export async function createServer({ db, content, emit = () => {}, rateLimit = { capacity: 25, refill: 5 } }) {
  const bootedAt = Date.now();
  let served = 0;
  const signingKey = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  // --- boot: migrations + seed -------------------------------------------------
  const boot = [];
  const version = (await db.query('SELECT version() AS v')).rows[0].v;
  boot.push(`PostgreSQL: ${version.split(' on ')[0]}`);
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  for (const m of MIGRATIONS) {
    const done = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [m.name]);
    if (done.rows.length) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
    });
    boot.push(`migration ${m.name}`);
  }
  const seeded = await seed(db, content);
  boot.push(`seeded ${seeded} rows from data/portfolio.json`);

  // --- rate limiting: token bucket (one visitor = one client) ---------------------
  const bucket = { capacity: rateLimit.capacity, refill: rateLimit.refill, tokens: rateLimit.capacity, at: performance.now() };
  function takeToken() {
    const t = performance.now();
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + ((t - bucket.at) / 1000) * bucket.refill);
    bucket.at = t;
    if (bucket.tokens < 1) return { ok: false, remaining: 0, retryAfter: Math.ceil((1 - bucket.tokens) / bucket.refill) };
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }

  // --- JWT --------------------------------------------------------------------------
  async function signJwt(claims) {
    const unsigned = jsonB64u({ alg: 'HS256', typ: 'JWT' }) + '.' + jsonB64u(claims);
    return unsigned + '.' + toB64u(await crypto.subtle.sign('HMAC', signingKey, enc.encode(unsigned)));
  }
  async function verifyJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new HttpError(401, 'INVALID_TOKEN', 'Malformed token');
    let sig, claims;
    try { sig = fromB64u(parts[2]); claims = b64uJson(parts[1]); } catch { throw new HttpError(401, 'INVALID_TOKEN', 'Malformed token'); }
    // The header's "alg" is never trusted: everything is verified as HS256.
    if (!(await crypto.subtle.verify('HMAC', signingKey, sig, enc.encode(parts[0] + '.' + parts[1])))) {
      throw new HttpError(401, 'INVALID_TOKEN', 'Invalid signature');
    }
    if (!claims.exp || claims.exp * 1000 < Date.now()) throw new HttpError(401, 'INVALID_TOKEN', 'Token expired');
    return claims;
  }

  // --- routing ----------------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth: false, ...opts, handler });
  };

  // Queries run through ctx.q so every statement lands in the request trace.
  function tracer(ctx, runner) {
    return async (sql, params = []) => {
      const t0 = performance.now();
      const res = await runner.query(sql, params);
      ctx.sql.push({ sql: sql.replace(/\s+/g, ' ').trim(), params, ms: +(performance.now() - t0).toFixed(2), rows: res.rows.length || res.affectedRows || 0 });
      return res;
    };
  }

  // Run fn inside a transaction as the unprivileged app_user, scoped to one tenant (RLS applies).
  function asTenant(ctx, fn) {
    return db.transaction(async (tx) => {
      const q = tracer(ctx, tx);
      await q("SELECT set_config('app.user_id', $1, true)", [String(ctx.user.uid)]);
      await q('SET LOCAL ROLE app_user');
      return fn(q);
    });
  }

  const ok = (data, status = 200) => ({ status, data });

  // ---------- content ----------
  route('GET', '/api/health', {}, async (ctx) => {
    const r = await ctx.q("SELECT current_setting('server_version') AS postgres, pg_database_size(current_database()) AS bytes");
    return ok({ status: 'UP', postgres: r.rows[0].postgres, databaseBytes: Number(r.rows[0].bytes),
      uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000), requestsServed: served });
  });

  route('GET', '/api/profile', {}, async (ctx) => {
    const r = await ctx.q('SELECT data FROM profile WHERE id = 1');
    return ok(r.rows[0].data);
  });

  route('GET', '/api/experience', {}, async (ctx) => {
    // Durations are computed by Postgres, not hand-written.
    const r = await ctx.q(`
      SELECT company, title, kind, highlights, stack,
             to_char(start_date, 'Mon YYYY') AS "from",
             COALESCE(to_char(end_date, 'Mon YYYY'), 'Present') AS "to",
             (extract(year FROM span)::int * 12 + extract(month FROM span)::int + 1) AS months
      FROM experience, LATERAL (SELECT age(COALESCE(end_date, current_date), start_date) AS span) s
      ORDER BY end_date DESC NULLS FIRST, start_date DESC`);
    return ok(r.rows);
  });

  route('GET', '/api/projects', {}, async (ctx) => {
    const { q = '', tag = '', visibility = '' } = ctx.query;
    const where = [];
    const params = [];
    // Search-as-you-type: every word becomes a prefix match ("postgres" finds "PostgreSQL").
    const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
    if (words.length) {
      params.push(words.map((w) => `${w}:*`).join(' & '));
      where.push(`to_tsvector('simple', search_text) @@ to_tsquery('simple', $${params.length})`);
    }
    if (tag) {
      params.push(tag);
      where.push(`tags @> ARRAY[$${params.length}]::text[]`);
    }
    if (visibility) {
      if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'VALIDATION_FAILED', 'visibility must be public or private');
      params.push(visibility);
      where.push(`visibility = $${params.length}`);
    }
    const r = await ctx.q(`
      SELECT slug, name, summary, year, visibility, status, stack, tags, highlights, repo_url, live_url
      FROM projects ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY position`, params);
    return ok(r.rows);
  });

  route('GET', '/api/projects/:slug', {}, async (ctx) => {
    const r = await ctx.q('SELECT * FROM projects WHERE slug = $1', [ctx.params.slug]);
    if (!r.rows.length) throw new HttpError(404, 'NOT_FOUND', `No project '${ctx.params.slug}'`);
    return ok(r.rows[0]);
  });

  route('GET', '/api/stack', {}, async (ctx) => {
    const r = await ctx.q(`
      SELECT tech, count(*)::int AS projects
      FROM (SELECT unnest(stack) AS tech FROM projects
            UNION ALL SELECT unnest(stack) FROM experience) t
      GROUP BY tech ORDER BY projects DESC, tech LIMIT 14`);
    return ok(r.rows);
  });

  route('GET', '/api/strengths', {}, async (ctx) => {
    const r = await ctx.q('SELECT title, body FROM strengths ORDER BY position');
    return ok(r.rows);
  });

  // ---------- auth ----------
  route('POST', '/api/auth/login', {}, async (ctx) => {
    const { username, password } = ctx.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'username and password are required');
    }
    const r = await ctx.q('SELECT id, username, role, salt, password FROM users WHERE username = $1', [username]);
    const u = r.rows[0];
    // Hash even for unknown users so timing doesn't reveal which usernames exist.
    const { hash } = await hashPassword(password, u ? u.salt : toB64u(new Uint8Array(16)));
    if (!u || hash !== u.password) throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid username or password');
    const iat = Math.floor(Date.now() / 1000);
    const token = await signJwt({ sub: u.username, uid: u.id, role: u.role, iat, exp: iat + 900 });
    return ok({ accessToken: token, tokenType: 'Bearer', expiresIn: 900 });
  });

  route('GET', '/api/me', { auth: true }, async (ctx) => {
    const r = await ctx.q('SELECT id, username, role, created_at FROM users WHERE id = $1', [ctx.user.uid]);
    return ok(r.rows[0]);
  });

  route('GET', '/api/admin/users', { auth: true, role: 'admin' }, async (ctx) => {
    const r = await ctx.q('SELECT id, username, role, created_at FROM users ORDER BY id');
    return ok(r.rows);
  });

  // ---------- tasks (row-level security + optimistic locking) ----------
  const STATUSES = ['todo', 'doing', 'done'];

  route('GET', '/api/tasks', { auth: true }, async (ctx) => {
    const status = ctx.query.status || '';
    if (status && !STATUSES.includes(status)) throw new HttpError(400, 'VALIDATION_FAILED', `status must be one of ${STATUSES.join(', ')}`);
    // Note: no "WHERE owner_id = ..." here. Row-level security adds it.
    const rows = await asTenant(ctx, (q) => q(
      `SELECT id, title, status, version, updated_at FROM tasks ${status ? 'WHERE status = $1' : ''} ORDER BY id`,
      status ? [status] : []));
    return ok(rows.rows);
  });

  route('GET', '/api/tasks/:id', { auth: true }, async (ctx) => {
    const rows = await asTenant(ctx, (q) => q('SELECT id, title, status, version, updated_at FROM tasks WHERE id = $1', [Number(ctx.params.id) || 0]));
    if (!rows.rows.length) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found');
    return ok(rows.rows[0]);
  });

  route('POST', '/api/tasks', { auth: true }, async (ctx) => {
    const title = typeof ctx.body?.title === 'string' ? ctx.body.title.trim() : '';
    if (!title || title.length > 120) throw new HttpError(400, 'VALIDATION_FAILED', 'title must be 1–120 characters');
    const rows = await asTenant(ctx, (q) => q(
      'INSERT INTO tasks (owner_id, title) VALUES ($1, $2) RETURNING id, title, status, version, updated_at', [ctx.user.uid, title]));
    ctx.headers.Location = `/api/tasks/${rows.rows[0].id}`;
    return ok(rows.rows[0], 201);
  });

  route('PUT', '/api/tasks/:id', { auth: true }, async (ctx) => {
    const { title, status, version } = ctx.body || {};
    const errors = [];
    if (typeof title !== 'string' || !title.trim() || title.length > 120) errors.push({ field: 'title', message: '1–120 characters' });
    if (!STATUSES.includes(status)) errors.push({ field: 'status', message: `one of ${STATUSES.join(', ')}` });
    if (!Number.isInteger(version)) errors.push({ field: 'version', message: 'required for optimistic locking' });
    if (errors.length) throw new HttpError(400, 'VALIDATION_FAILED', 'Request validation failed', errors);
    const id = Number(ctx.params.id) || 0;
    return asTenant(ctx, async (q) => {
      // The version check is part of the UPDATE itself, so it's atomic.
      const upd = await q(`UPDATE tasks SET title = $1, status = $2, version = version + 1, updated_at = now()
                           WHERE id = $3 AND version = $4 RETURNING id, title, status, version, updated_at`, [title.trim(), status, id, version]);
      if (upd.rows.length) return ok(upd.rows[0]);
      const cur = await q('SELECT version FROM tasks WHERE id = $1', [id]);
      if (!cur.rows.length) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found');
      throw new HttpError(409, 'OPTIMISTIC_LOCK_CONFLICT', 'Task was modified by another request. Re-fetch and retry.',
        { currentVersion: cur.rows[0].version, providedVersion: version });
    });
  });

  route('DELETE', '/api/tasks/:id', { auth: true }, async (ctx) => {
    const del = await asTenant(ctx, (q) => q('DELETE FROM tasks WHERE id = $1 RETURNING id', [Number(ctx.params.id) || 0]));
    if (!del.rows.length) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found');
    return { status: 204 };
  });

  // ---------- SQL console: your own sandboxed Postgres, in your browser ----------
  route('POST', '/api/sql', {}, async (ctx) => {
    const sql = typeof ctx.body?.sql === 'string' ? ctx.body.sql : '';
    if (!sql.trim()) throw new HttpError(400, 'VALIDATION_FAILED', 'sql is required');
    if (sql.length > 20_000) throw new HttpError(413, 'TOO_LARGE', 'Query is too long');
    const t0 = performance.now();
    let results;
    try {
      results = await db.exec(sql);
    } catch (e) {
      throw new HttpError(400, 'SQL_ERROR', e.message);
    }
    const ms = +(performance.now() - t0).toFixed(2);
    ctx.sql.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 500), params: [], ms, rows: results.reduce((n, r) => n + r.rows.length, 0) });
    return ok({
      ms,
      results: results.map((r) => ({
        fields: r.fields.map((f) => f.name),
        rows: r.rows.slice(0, 200),
        rowCount: r.rows.length,
        affectedRows: r.affectedRows ?? 0,
      })),
    });
  });

  // ---------- request pipeline ----------
  async function handle(req) {
    const t0 = performance.now();
    const url = new URL(req.url);
    const requestId = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0');
    const ctx = { req, url, query: Object.fromEntries(url.searchParams), params: {}, body: undefined, user: null,
      headers: {}, sql: [] };
    ctx.q = tracer(ctx, db);
    let status, payload;
    try {
      const rl = takeToken();
      ctx.headers['X-RateLimit-Limit'] = String(bucket.capacity);
      ctx.headers['X-RateLimit-Remaining'] = String(rl.remaining);
      if (!rl.ok) {
        ctx.headers['Retry-After'] = String(rl.retryAfter);
        throw new HttpError(429, 'RATE_LIMITED', `Too many requests. Retry after ${rl.retryAfter}s.`);
      }

      let match = null;
      let pathExists = false;
      for (const r of routes) {
        const m = url.pathname.match(r.re);
        if (!m) continue;
        pathExists = true;
        if (r.method !== req.method) continue;
        match = r;
        r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
        break;
      }
      if (!match) {
        if (pathExists) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not supported on ${url.pathname}`);
        throw new HttpError(404, 'NOT_FOUND', `No endpoint ${req.method} ${url.pathname}`);
      }

      if (match.auth) {
        const authz = req.headers.authorization || req.headers.Authorization || '';
        if (!authz.startsWith('Bearer ')) {
          ctx.headers['WWW-Authenticate'] = 'Bearer';
          throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
        }
        ctx.user = await verifyJwt(authz.slice(7).trim());
        if (match.role && ctx.user.role !== match.role) throw new HttpError(403, 'ACCESS_DENIED', `Requires role ${match.role}`);
      }

      if (req.body && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
        try { ctx.body = JSON.parse(req.body); } catch { throw new HttpError(400, 'MALFORMED_JSON', 'Request body is not valid JSON'); }
      }

      const res = await match.handler(ctx);
      status = res.status;
      payload = res.status === 204 ? undefined : { data: res.data };
    } catch (err) {
      let e = err;
      if (!(e instanceof HttpError)) {
        console.error(e);
        e = new HttpError(500, 'INTERNAL_ERROR', 'Unexpected server error');
      }
      status = e.status;
      payload = { error: { status: e.status, code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
    }

    served += 1;
    const ms = +(performance.now() - t0).toFixed(1);
    const headers = {
      ...(payload !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
      'X-Response-Time': `${ms}ms`,
      'X-Powered-By': 'sw.js + PostgreSQL (PGlite)',
      ...ctx.headers,
    };
    const body = payload === undefined ? null : JSON.stringify(payload);
    emit({
      id: requestId, at: Date.now(), method: req.method, path: url.pathname + url.search, status, ms,
      requestHeaders: req.headers, requestBody: req.body || null,
      responseHeaders: headers, responseBody: body && body.length > 4000 ? body.slice(0, 4000) + '…' : body,
      sql: ctx.sql, user: ctx.user ? ctx.user.sub : null,
    });
    return { status, statusText: STATUS_TEXT[status] || '', headers, body };
  }

  return { handle, boot };
}

// ---------------------------------------------------------------- seed

async function seed(db, content) {
  const existing = await db.query('SELECT count(*)::int AS n FROM projects');
  if (existing.rows[0].n > 0) return 0;
  let n = 0;
  await db.transaction(async (tx) => {
    const arr = (a) => JSON.stringify(a || []);
    const ARR = (i) => `ARRAY(SELECT jsonb_array_elements_text($${i}::jsonb))`;

    await tx.query('INSERT INTO profile (id, data) VALUES (1, $1::jsonb)', [JSON.stringify({ ...content.profile, stats: content.stats })]); n++;

    for (const e of content.experience) {
      await tx.query(`INSERT INTO experience (company, title, kind, start_date, end_date, highlights, stack)
                      VALUES ($1, $2, $3, $4, $5, ${ARR(6)}, ${ARR(7)})`,
        [e.company, e.title, e.kind, e.start, e.end, arr(e.highlights), arr(e.stack)]);
      n++;
    }

    let pos = 0;
    for (const p of content.projects) {
      const search = [p.name, p.summary, (p.stack || []).join(' '), (p.tags || []).join(' ')].join(' ');
      await tx.query(`INSERT INTO projects (slug, name, summary, year, visibility, status, stack, tags, highlights, repo_url, live_url, position, search_text)
                      VALUES ($1, $2, $3, $4, $5, $6, ${ARR(7)}, ${ARR(8)}, ${ARR(9)}, $10, $11, $12, $13)`,
        [p.slug, p.name, p.summary, p.year, p.visibility, p.status, arr(p.stack), arr(p.tags), arr(p.highlights),
          p.repo, p.live, pos++, search]);
      n++;
    }

    let spos = 0;
    for (const s of content.strengths) {
      await tx.query('INSERT INTO strengths (position, title, body) VALUES ($1, $2, $3)', [spos++, s.title, s.body]);
      n++;
    }

    // Demo accounts for the task API (passwords shown in the UI).
    for (const [username, password, role] of [['alice', 'alice-pass', 'user'], ['bob', 'bob-pass', 'user'], ['admin', 'admin-pass', 'admin']]) {
      const { salt, hash } = await hashPassword(password);
      await tx.query('INSERT INTO users (username, role, salt, password) VALUES ($1, $2, $3, $4)', [username, role, salt, hash]);
      n++;
    }
    const tasks = [[1, 'Add Redis cache for FX rates', 'doing'], [1, 'Write migration V7', 'todo'], [1, 'Load-test checkout', 'done'],
      [2, 'Push notification service', 'doing'], [2, 'OAuth2 social login', 'todo']];
    for (const [owner, title, status] of tasks) {
      await tx.query('INSERT INTO tasks (owner_id, title, status) VALUES ($1, $2, $3)', [owner, title, status]);
      n++;
    }
  });
  return n;
}
