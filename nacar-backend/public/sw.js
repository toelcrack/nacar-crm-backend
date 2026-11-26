// Service worker del CRM Nácar. Objetivo: que se pueda instalar como app y que abra rápido.
// - Red primero: siempre intenta traer la versión nueva (así los cambios se ven al tiro).
// - Si no hay internet, muestra la última copia guardada de la pantalla (no de los datos).
// - NUNCA toca /api ni /c (confirmación del cliente): esos siempre van directo a internet.
const CACHE = 'nacar-crm-v1';
const SHELL = ['/', '/app.js', '/favicon.png', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/c/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then((r) => r || Response.error()))
  );
});
