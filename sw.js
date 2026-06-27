/* NotamHub — Service Worker
 *
 * Estrategia:
 *   - App shell (HTML, CSS, JS, iconos, Leaflet) -> cache-first.
 *   - APIs externas (/api/*, AWC, EUMETView, RainViewer, NotamHub) y tiles
 *     -> network-first con fallback a cache si existe.
 *   - Navegaciones (request.mode === 'navigate') sin red -> cache de index.html.
 *
 * Para forzar invalidación al desplegar nueva versión, sube CACHE_VERSION.
 */

const CACHE_VERSION = 'notamhub-v16';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './css/notamhub.css',
  './assets/icon.svg',
  './js/geom.js',
  './js/offlineGeo.js',
  './js/settings.js',
  './js/scheduleFmt.js',
  './js/i18n.js',
  './js/filters.js',
  './js/metarDecode.js',
  './js/meteoApi.js',
  './js/notamHub.js',
  './js/notamDecode.js',
  './js/mapView.js',
  './js/app.js',
  './js/shell.js',
  // Librerías CDN (otro origen, pero las cacheamos para uso offline)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Hosts que deben ir siempre por red (datos en tiempo real). Sin esto la
// estrategia cache-first del SW serviría la PRIMERA respuesta para siempre,
// congelando METARs, NOTAMs, tiles de RainViewer, etc.
const NETWORK_FIRST_HOSTS = [
  'aviationweather.gov',
  'view.eumetsat.int',
  'tilecache.rainviewer.com',
  'api.rainviewer.com',
  'notamhub.duckdns.org',
  'api.allorigins.win',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // add individual con catch: un CDN caído no bloquea la instalación.
      // cache:'reload' ignora la cache HTTP del navegador para traer frescos.
      Promise.all(
        SHELL_ASSETS.map((url) => {
          const req = new Request(url, { cache: 'reload' });
          return cache.add(req).catch((err) => {
            console.warn('[SW] no se pudo cachear', url, err);
          });
        })
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  console.info('[SW] activando', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => { console.info('[SW] borrando cache vieja', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

function isNetworkFirst(url) {
  if (url.pathname.startsWith('/api/')) return true;
  return NETWORK_FIRST_HOSTS.some((h) => url.hostname.endsWith(h));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Navegaciones: intenta red, cae a index.html cacheado.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('./index.html').then((r) => r || caches.match('./'))
      )
    );
    return;
  }

  const networkErrorResponse = () => new Response('', {
    status: 504,
    statusText: 'SW network error fallback',
  });

  // APIs y tiles meteo: network-first.
  if (isNetworkFirst(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && req.method === 'GET') {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || networkErrorResponse()))
    );
    return;
  }

  // App shell y todo lo demás: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached || networkErrorResponse());
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
