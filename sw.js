// An earlier version of this site registered a Service Worker. This one removes itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => clients.forEach((c) => c.navigate(c.url))));
});
