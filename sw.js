// Service Worker = the HTTP layer of this site's backend.
// It intercepts same-origin requests to /api/*, hands them to the backend running in the page's
// Web Worker, and answers with a real HTTP Response (status, headers, body). Check DevTools → Network.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/api/')) return;
  event.respondWith(relay(event));
});

const NULL_BODY = new Set([101, 204, 205, 304]);

function problem(status, code, message) {
  return new Response(JSON.stringify({ error: { status, code, message } }, null, 2), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function relay(event) {
  // Prefer the tab that made the request; for an /api URL opened directly, use any open portfolio tab.
  let client = event.clientId ? await self.clients.get(event.clientId) : null;
  if (!client) {
    const windows = await self.clients.matchAll({ type: 'window' });
    client = windows.find((c) => !new URL(c.url).pathname.startsWith('/api/')) || null;
  }
  if (!client) {
    return problem(503, 'NO_SERVER',
      'This API runs inside the portfolio page. Open https://iamsrkg.github.io in another tab, then reload this URL.');
  }

  const req = event.request;
  const request = {
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers.entries()),
    body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.text(),
  };

  const channel = new MessageChannel();
  const reply = new Promise((resolve) => {
    channel.port1.onmessage = (e) => resolve(e.data);
    setTimeout(() => resolve(null), 20000);
  });
  client.postMessage({ type: 'http', request }, [channel.port2]);
  const res = await reply;
  if (!res) return problem(504, 'GATEWAY_TIMEOUT', 'The in-browser backend did not answer in time.');

  return new Response(NULL_BODY.has(res.status) ? null : res.body, {
    status: res.status, statusText: res.statusText, headers: res.headers,
  });
}
