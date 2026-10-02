/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// PWA service worker (PRD W6). SvelteKit registers it automatically.
// - App shell (built JS/CSS, static files, index.html) is cached so the app opens fast on a weak connection.
// - /api, /admin and /health are never touched: data always comes from the server, never from this cache.
// - Pages (navigations) are network-first, so a new deploy shows up right away; the cached shell is the offline fallback.

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `panta-shell-${version}`;
const SHELL = '/';
const ASSETS = new Set([...build, ...files]);

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...ASSETS, SHELL])));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
});

const NEVER_CACHE = /^\/(?:api|admin|health)(?:\/|$)/;

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin || NEVER_CACHE.test(url.pathname)) return;

  if (ASSETS.has(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(SHELL)) ?? Response.error())
    );
  }
});
