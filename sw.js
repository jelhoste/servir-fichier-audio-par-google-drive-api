// Service worker : met l'application (pas l'audio, qui est dans IndexedDB) en cache, par version.
importScripts('version.js');
const CACHE = 'lecteur-' + self.APP_VERSION;
const SHELL = ['./', 'index.html', 'styles.css', 'themes.js', 'app.js', 'ogg-opus.js', 'drive.js', 'meta.js', 'version.js',
  'vendor/opus-decoder.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

// Installation : tout ou rien. 'reload' contourne le cache HTTP pour ne pas figer des fichiers périmés.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  // pas de skipWaiting automatique : l'utilisateur choisit quand mettre à jour (pas de coupure en pleine lecture)
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('lecteur-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;     // Google Drive, etc. : réseau direct, jamais mis en cache ici
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit =>
    hit || (req.mode === 'navigate' ? caches.match('index.html') : fetch(req))));
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
