const CACHE = 'cuet-cse25-shell-v35-cleanup';
const RESOURCE_CACHE = 'cuet-cse25-saved-resources-v1';
const SHELL = ['/', '/manifest.webmanifest', '/x.js', '/icon-180.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
  // add files one by one: a single missing file must never make the whole update fail (that left phones stuck on old code)
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('cuet-cse25-shell-') && key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/dl/')) {
    event.respondWith(caches.open(RESOURCE_CACHE).then(async cache => (await cache.match(request)) || fetch(request)));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match('/'))));
    return;
  }
  // network first, cache only when offline: phones always get the latest x.js / icons
  event.respondWith(fetch(request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); }
    return response;
  }).catch(() => caches.match(request).then(cached => cached || Response.error())));
});

self.addEventListener('message', event => {
  const data = event.data || {}, port = event.ports[0];
  if (data.type === 'SAVE_RESOURCE') event.waitUntil((async () => {
    try {
      const url = new URL(data.url, self.location.origin);
      if (url.origin !== self.location.origin || !url.pathname.startsWith('/api/dl/')) throw new Error('Only dashboard files can be saved offline');
      const response = await fetch(new Request(url.href, { credentials: 'same-origin' }));
      if (!response.ok) throw new Error(response.status === 401 ? 'Log in again to save this file' : 'Could not download this file');
      await (await caches.open(RESOURCE_CACHE)).put(url.href, response);
      port?.postMessage({ ok: true, url: url.pathname });
    } catch (error) { port?.postMessage({ ok: false, error: error.message }); }
  })());
  if (data.type === 'REMOVE_RESOURCE') event.waitUntil(caches.open(RESOURCE_CACHE).then(cache => cache.delete(new URL(data.url, self.location.origin).href)).then(ok => port?.postMessage({ ok })));
  if (data.type === 'CLEAR_RESOURCES') event.waitUntil(caches.delete(RESOURCE_CACHE));
});

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { body: event.data?.text() || '' }; }
  event.waitUntil((async () => {
    if (message.url === '/chat') { // don't buzz while the person is already looking at the chat
      const seen = (await clients.matchAll({ type: 'window', includeUncontrolled: true })).some(c => c.visibilityState === 'visible' && c.focused && new URL(c.url).pathname === '/chat');
      if (seen) return;
    }
    await self.registration.showNotification(message.title || 'CUET CSE 25 alert', {
    body: message.body || 'You have a new alert.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: message.id ? 'cse25-' + message.id : 'cse25-alert',
    data: { url: message.url || '/' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'OPEN_ALERTS', url: event.notification.data && event.notification.data.url });
        return;
      }
    }
    await clients.openWindow(event.notification.data && event.notification.data.url === '/chat' ? '/chat' : '/?openAlerts=1');
  })());
});
