const CACHE = 'domingokids-v3';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './offline.html',
  './icons/icon-192.png',
  './icons/icon-180.png',
  './icons/apple-touch-icon.png',
  './logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isNavegacao(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept') && request.headers.get('accept').includes('text/html'));
}

function deveIgnorar(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return url.hostname.includes('supabase.co') ||
    url.hostname.includes('googleapis.com') ||
    url.pathname.includes('/auth/v1/') ||
    url.pathname.includes('/functions/v1/');
}

function precisaRedePrimeiro(url) {
  return url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.json');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  if (deveIgnorar(url)) return;

  if (isNavegacao(request) || precisaRedePrimeiro(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return await cache.match('./offline.html') || await cache.match('./index.html') || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => undefined);
  return cached || network || Response.error();
}

self.addEventListener('push', (event) => {
  let data = {
    title: 'Domingo Kids',
    body: 'Você tem uma nova notificação.',
    url: './pais.html'
  };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    try {
      data.body = event.data.text();
    } catch (err) {}
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      lang: 'pt-BR',
      vibrate: [120, 80, 120],
      data: { url: data.url || './pais.html' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : './pais.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientes) => {
      for (const cliente of clientes) {
        if ('focus' in cliente) {
          cliente.focus();
          if ('navigate' in cliente) {
            try { cliente.navigate(destino); } catch (err) {}
          }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(destino);
    })
  );
});
