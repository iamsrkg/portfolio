# iamsrkg.github.io: a portfolio served by its own backend

[![Backend tests](https://github.com/iamsrkg/iamsrkg.github.io/actions/workflows/test.yml/badge.svg)](https://github.com/iamsrkg/iamsrkg.github.io/actions/workflows/test.yml)

**Live: https://iamsrkg.github.io**

GitHub Pages can only host static files. This site does it anyway: **the page has a real backend, and it runs in the visitor's browser.**

```
UI (this page) ──fetch /api/*──▶ sw.js (Service Worker = HTTP layer)
                                   │ postMessage + MessageChannel
                                   ▼
                          server/app.js in a Web Worker
                          router · rate limiter · JWT · SQL tracing
                                   │ SQL
                                   ▼
                    PostgreSQL 18 (PGlite, WebAssembly)
                    migrations · row-level security · full-text search
```

- **Real HTTP.** The UI calls `fetch('/api/projects')`. The Service Worker intercepts it and answers with a genuine `Response` (status, headers, JSON). In DevTools → Network the calls appear as served by the ServiceWorker. With the portfolio open in one tab, opening `/api/profile` in another tab works too.
- **Real Postgres.** Content lives in tables, seeded from `data/portfolio.json`, and every section is rendered from API responses:
  - job durations come from `age()`
  - the "what I work with" chart is an `unnest … GROUP BY`
  - project search is `to_tsvector`/`to_tsquery` with prefix matching
  - tag filters use `@>` with GIN indexes
- **Real security model** (the "Auth & tenants" tab):
  - PBKDF2 password hashing and HS256 JWTs through Web Crypto
  - role checks (403) and a token-bucket rate limiter (429 + `Retry-After`)
  - tenant isolation enforced by **Postgres row-level security**: queries run as an unprivileged role and never filter by owner themselves
  - optimistic locking done inside the `UPDATE … WHERE version = $n` (409)
- **Observable.** Every request is logged with its headers, body and **every SQL statement with timings**, in the "Requests" tab.
- **A SQL console** on the same database. There's a walkthrough that generates 200,000 rows and shows a real `EXPLAIN ANALYZE` going from a sequential scan (~30 ms) to an index scan (~0.1 ms) after `CREATE INDEX`.
- **Resilient.** The page paints instantly from the same JSON, then re-renders from the API once Postgres has booted (a few seconds on first visit). If the browser can't run it, the content still renders:
  - without Service Workers (for example, private windows), the UI calls the worker directly
  - without WebAssembly, the page stays on the static data

## Run locally
Service Workers need `localhost` or HTTPS, and the site must be served from its root:
```bash
npx serve -l 8080 .          # then open http://localhost:8080
```

## Tests
`tests/backend.test.mjs` runs `server/app.js` on a real PGlite, the same way the browser does. It has 36 checks: content endpoints and SQL features, login and JWT, forged tokens, RLS isolation for reads, updates and deletes, the 409 conflict, validation, rate limiting, the SQL console and the EXPLAIN walkthrough.
```bash
npm install && npm test      # RESULT: 36 passed, 0 failed
```
CI runs them on every push.

## Files
| Path | Role |
|---|---|
| `index.html`, `styles.css`, `app.js` | UI: renders everything from the API, plus the request inspector, auth playground and SQL console |
| `sw.js` | Service Worker: turns `/api/*` requests into messages and messages back into HTTP responses |
| `server/worker.js` | Boots PGlite and the server inside a Web Worker |
| `server/app.js` | The backend: migrations, seed, routes, auth, RLS, rate limiting, tracing |
| `data/portfolio.json` | Single source of truth for the content |

Built by Sudheer Kumar Gupta with AI assistance (Claude Code), with every change reviewed and tested.
