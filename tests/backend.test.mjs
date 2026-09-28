// Backend tests: server/app.js on a real PostgreSQL (PGlite), exactly as the browser worker runs it.
// Drives server/app.js against a real PGlite, the same way the browser worker does.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createServer } from '../server/app.js';

const content = JSON.parse(readFileSync(new URL('../data/portfolio.json', import.meta.url), 'utf8'));
const t0 = performance.now();
const db = await PGlite.create();
const logs = [];
const server = await createServer({ db, content, emit: (e) => logs.push(e), rateLimit: { capacity: 10000, refill: 1000 } });
console.log(`boot ${Math.round(performance.now() - t0)} ms:`, server.boot.join(' | '));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); } };
const call = async (method, path, { body, token } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await server.handle({ method, url: 'https://iamsrkg.github.io' + path, headers, body: body === undefined ? null : JSON.stringify(body) });
  return { ...r, json: r.body ? JSON.parse(r.body) : null };
};

let r = await call('GET', '/api/health');
check('health', r.status === 200 && r.json.data.status === 'UP', r.body);
console.log('   postgres', r.json.data.postgres);
r = await call('GET', '/api/profile');
check('profile', r.status === 200 && r.json.data.name === 'Sudheer Kumar Gupta' && r.json.data.stats.length === 4);
r = await call('GET', '/api/experience');
check('experience ordered (current first) + durations', r.status === 200 && r.json.data.length === 3 && r.json.data[0].to === 'Present' && r.json.data[1].from === 'Nov 2025' && r.json.data[0].months > 12, JSON.stringify(r.json.data.map((e) => [e.from, e.to, e.months])));
console.log('   ', r.json.data.map((e) => `${e.from}–${e.to} (${e.months} mo)`).join(' | '));
r = await call('GET', '/api/projects');
check('all projects', r.status === 200 && r.json.data.length === content.projects.length);
r = await call('GET', '/api/projects?tag=security');
check('tag filter', r.json.data.length === 2 && r.json.data.every((p) => p.tags.includes('security')), JSON.stringify(r.json.data.map((p) => p.slug)));
r = await call('GET', '/api/projects?q=postgres');
check('full-text search', r.json.data.length >= 2, JSON.stringify(r.json.data.map((p) => p.slug)));
r = await call('GET', '/api/projects?visibility=bogus');
check('validation 400', r.status === 400);
r = await call('GET', '/api/projects/nope');
check('404 project', r.status === 404);
r = await call('GET', '/api/stack');
check('stack counts', r.status === 200 && r.json.data[0].projects >= 2, JSON.stringify(r.json.data.slice(0, 4)));
r = await call('GET', '/api/strengths');
check('strengths', r.json.data.length === 3);
r = await call('DELETE', '/api/profile');
check('405 wrong method', r.status === 405);

// auth + RLS
r = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' } });
check('bad credentials 401', r.status === 401);
r = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'alice-pass' } });
const alice = r.json.data.accessToken;
const bob = (await call('POST', '/api/auth/login', { body: { username: 'bob', password: 'bob-pass' } })).json.data.accessToken;
const admin = (await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin-pass' } })).json.data.accessToken;
check('login returns JWT', alice && alice.split('.').length === 3);
r = await call('GET', '/api/tasks', { token: alice });
check('RLS: alice sees only her 3 tasks', r.status === 200 && r.json.data.length === 3, r.body);
r = await call('GET', '/api/tasks', { token: bob });
check('RLS: bob sees only his 2 tasks', r.json.data.length === 2, r.body);
r = await call('GET', '/api/tasks/4', { token: alice });
check("RLS: alice reading bob's task gets 404", r.status === 404, r.body);
r = await call('POST', '/api/tasks', { token: alice, body: { title: 'New one' } });
check('create 201 + Location', r.status === 201 && r.headers.Location === `/api/tasks/${r.json.data.id}`);
const t = r.json.data;
r = await call('PUT', `/api/tasks/${t.id}`, { token: alice, body: { title: 'x', status: 'doing', version: t.version } });
check('update 200 bumps version', r.status === 200 && r.json.data.version === t.version + 1);
r = await call('PUT', `/api/tasks/${t.id}`, { token: alice, body: { title: 'y', status: 'done', version: t.version } });
check('stale version 409', r.status === 409 && r.json.error.details.currentVersion === t.version + 1, r.body);
r = await call('PUT', `/api/tasks/${t.id}`, { token: bob, body: { title: 'hijack', status: 'done', version: t.version + 1 } });
check("RLS: bob can't update alice's task (404)", r.status === 404, r.body);
r = await call('DELETE', `/api/tasks/${t.id}`, { token: bob });
check("RLS: bob can't delete alice's task (404)", r.status === 404);
r = await call('DELETE', `/api/tasks/${t.id}`, { token: alice });
check('delete 204', r.status === 204 && r.body === null);
r = await call('PUT', '/api/tasks/1', { token: alice, body: { title: '' } });
check('validation errors 400', r.status === 400 && r.json.error.details.length === 3, r.body);
r = await call('GET', '/api/admin/users', { token: alice });
check('user → admin 403', r.status === 403);
r = await call('GET', '/api/admin/users', { token: admin });
check('admin → 200, no password fields', r.status === 200 && r.json.data.length === 3 && !r.body.includes('password') && !r.body.includes('salt'));
r = await call('GET', '/api/tasks');
check('no token 401', r.status === 401 && r.headers['WWW-Authenticate'] === 'Bearer');
const [h, p, s] = alice.split('.');
const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'admin' })).toString('base64url')}.${s}`;
r = await call('GET', '/api/admin/users', { token: forged });
check('forged JWT 401', r.status === 401, r.body);
r = await call('POST', '/api/tasks', { token: alice, body: undefined });
check('missing body → 400', r.status === 400);
const bad = await server.handle({ method: 'POST', url: 'https://x/api/tasks', headers: { authorization: `Bearer ${alice}` }, body: '{oops' });
check('malformed JSON 400', bad.status === 400);

// SQL console
r = await call('POST', '/api/sql', { body: { sql: "BEGIN; SET LOCAL ROLE app_user; SELECT set_config('app.user_id','2',true); SELECT id, owner_id FROM tasks; COMMIT;" } });
const rlsRows = r.json?.data?.results?.find((x) => x.fields.includes('owner_id'))?.rows || [];
check('SQL console: RLS demo returns only bob rows', r.status === 200 && rlsRows.length === 2 && rlsRows.every((x) => x.owner_id === 2), r.body?.slice(0, 300));
let t1 = performance.now();
r = await call('POST', '/api/sql', { body: { sql: `DROP TABLE IF EXISTS orders; CREATE TABLE orders AS SELECT g AS id, (random()*20000)::int AS customer_id, (ARRAY['pending','paid','shipped','cancelled'])[1+floor(random()*4)::int] AS status, round((random()*500)::numeric,2) AS total FROM generate_series(1,200000) g; ANALYZE orders; SELECT count(*) FROM orders;` } });
check('SQL console: 200k orders', r.status === 200, r.body?.slice(0, 200));
console.log(`   generated 200k rows in ${Math.round(performance.now() - t1)} ms`);
r = await call('POST', '/api/sql', { body: { sql: "EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 4242 AND status = 'shipped';" } });
const before = r.json.data.results[0].rows.map((x) => x['QUERY PLAN']).join('\n');
r = await call('POST', '/api/sql', { body: { sql: "CREATE INDEX IF NOT EXISTS orders_customer_status_idx ON orders (customer_id, status); EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 4242 AND status = 'shipped';" } });
const after = r.json.data.results.at(-1).rows.map((x) => x['QUERY PLAN']).join('\n');
check('EXPLAIN: seq scan before, index scan after', /Seq Scan/.test(before) && /Index Scan|Bitmap/.test(after), before + '\n---\n' + after);
console.log('   before:', before.split('\n').filter((l) => /Scan|Execution/.test(l)).join(' | '));
console.log('   after :', after.split('\n').filter((l) => /Scan|Execution/.test(l)).join(' | '));
r = await call('POST', '/api/sql', { body: { sql: 'SELEC 1' } });
check('SQL error → 400 with message', r.status === 400 && /syntax/i.test(r.json.error.message));

// rate limit: a second server with the production limits, on the same database
const limited = await createServer({ db, content });
let codes = {};
for (let i = 0; i < 60; i++) { const x = await limited.handle({ method: 'GET', url: 'https://x/api/health', headers: {}, body: null }); codes[x.status] = (codes[x.status] || 0) + 1; if (x.status === 429) { check('429 has Retry-After', !!x.headers['Retry-After']); break; } }
check('burst hits 429', codes[429] === 1, JSON.stringify(codes));
check('trace captured SQL', logs.some((e) => e.sql.length && e.sql[0].ms >= 0));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
