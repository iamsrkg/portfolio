// Web Worker that hosts the backend: PostgreSQL (PGlite, WebAssembly) + server/app.js.
// Requests arrive as messages (from sw.js via the page, or directly from the page) with a reply port.
import { PGlite } from 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.8/dist/index.js';
import { createServer } from './app.js';

const post = (msg) => self.postMessage(msg);
const step = (text, state = 'ok', ms) => post({ type: 'boot', text, state, ms });

let serverReady;

async function start() {
  const t0 = performance.now();
  step('downloading & starting PostgreSQL (WebAssembly)…', 'run');
  const db = await PGlite.create();
  step('PostgreSQL started', 'ok', Math.round(performance.now() - t0));

  const t1 = performance.now();
  const content = await (await fetch(new URL('../data/portfolio.json', import.meta.url))).json();
  const server = await createServer({ db, content, emit: (entry) => post({ type: 'log', entry }) });
  for (const line of server.boot) step(line);
  step('HTTP API ready on /api', 'ok', Math.round(performance.now() - t1));
  post({ type: 'ready', totalMs: Math.round(performance.now() - t0) });
  return server;
}

serverReady = start().catch((err) => {
  post({ type: 'failed', message: String(err && err.message || err) });
  throw err;
});

self.onmessage = async (event) => {
  const { type, request } = event.data || {};
  if (type !== 'http') return;
  const port = event.ports[0];
  try {
    const server = await serverReady;
    port.postMessage(await server.handle(request));
  } catch {
    port.postMessage({ status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { status: 503, code: 'BACKEND_DOWN', message: 'The in-browser backend failed to start.' } }) });
  }
};
