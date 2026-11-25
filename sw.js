// BC Dads Golf service worker: opens the app instantly from the phone's copy, and picks up new versions on the next open.
// Bump VERSION with every change (together with APP_VERSION in index.html).
const VERSION = 'bdg-v0.5.0';
const SHELL = ['./', 'index.html', 'config.js', 'vendor/supabase.js'];

// cache: 'reload' skips the browser's own HTTP cache (GitHub Pages keeps files ~10 minutes), so a new version never saves an old page.
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

// The app page itself: try the network first (fresh from GitHub, not the browser cache) so updates show on the next open.
// If the network is slow (over 2.5 s) or offline, the saved copy opens instead and the fresh one is saved for next time.
// Requests to Supabase (another site) are never touched here.
const isPage = (req, u) => req.mode === 'navigate' || u.pathname.endsWith('/') || u.pathname.endsWith('/index.html');
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (isPage(e.request, u)) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = (await c.match('./')) || (await c.match('index.html'));
      const fresh = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) c.put('./', r.clone()); return r; });
      if (!hit) return fresh;
      const slow = new Promise(res => setTimeout(() => res(null), 2500));
      try { const r = await Promise.race([fresh, slow]); if (r && r.ok) return r; } catch (err) {}
      e.waitUntil(fresh.catch(() => {}));
      return hit;
    }));
    return;
  }
  // Everything else (config, library): show the saved copy right away, then fetch a fresh one for next time.
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) c.put(u.pathname.endsWith('/') ? './' : e.request, r.clone()); return r; }).catch(() => hit);
    if (hit) { e.waitUntil(fresh); return hit; }
    return fresh;
  }));
});
