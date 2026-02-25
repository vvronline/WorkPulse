const CACHE_NAME = 'workpulse-v1';
const PRECACHE_URLS = [
    '/',
    '/manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(PRECACHE_URLS);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip API calls and server resources (uploads, etc.) - always go to network
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/uploads') || url.origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) => {
            const networked = fetch(request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(request, clone);
                        });
                    }
                    return response;
                })
                .catch(() => cached || new Response('Offline', { status: 503, statusText: 'Service Unavailable' }));

            return cached || networked;
        })
    );
});
