// AINO service worker — safe for independently deployed SPA assets.
const CACHE_NAME = 'aino-v5';
const SHELL_KEY = '/index.html';

self.addEventListener('install', () => {
    // Do not precache '/': during an R2/Worker rollout it could capture the
    // previous shell. The first successful navigation populates the fallback.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) => Promise.all(
            names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
        )),
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    if (url.origin !== self.location.origin
        || url.pathname.startsWith('/api')
        || url.pathname.startsWith('/uploads')
        || url.pathname.startsWith('/ws')
        || url.pathname.startsWith('/collab')) {
        return;
    }

    // Network-first navigation prevents a stale shell referring to assets from
    // a previous release. The last successful shell remains the offline fallback.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            try {
                const response = await fetch(request, { cache: 'no-store' });
                if (response.ok) await cache.put(SHELL_KEY, response.clone());
                return response;
            } catch {
                return (await cache.match(SHELL_KEY))
                    || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
            }
        })());
        return;
    }

    // Vite hashes /assets/* names; cache-first is safe indefinitely.
    if (url.pathname.startsWith('/assets/')) {
        event.respondWith((async () => {
            const cached = await caches.match(request);
            if (cached) return cached;
            const response = await fetch(request);
            if (response.ok) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, response.clone());
            }
            return response;
        })());
        return;
    }

    // Stable-name public assets are network-first because they may change
    // without a content hash.
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
            const response = await fetch(request, { cache: 'no-cache' });
            if (response.ok) await cache.put(request, response.clone());
            return response;
        } catch {
            return (await cache.match(request))
                || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        }
    })());
});