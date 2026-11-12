const CACHE_NAME = 'fairshare-__BUILD_HASH__';
const APP_NAME = 'Union';

// App shell files to pre-cache on install
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './js/config.js',
  './js/constants.js',
  './js/state.js',
  './js/utils.js',
  './js/db.js',
  './js/session.js',
  './js/auth.js',
  './js/profile.js',
  './js/avatars.js',
  './js/chat.js',
  './js/transactions.js',
  './js/members.js',
  './js/candidates.js',
  './js/stats.js',
  './js/constitution.js',
  './js/groups.js',
  './js/tabs.js',
  './js/modals.js',
  './js/create-group.js',
  './js/sponsor.js',
  './js/send-currency.js',
  './js/vote.js',
  './js/realtime.js',
  './js/navigation.js',
  './js/meet.js',
  './js/contacts.js',
  './js/preferences.js',
  './js/web-of-trust.js',
  './js/push.js',
  './js/init.js',
  './js/boot.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'
];

// Pre-cache app shell on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Clean up old caches on activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Handle incoming push notifications — skip if a window is focused (Realtime handles foreground)
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      const hasFocused = windowClients.some(c => c.visibilityState === 'visible');
      if (hasFocused) return;
      return self.registration.showNotification(data.title || APP_NAME, {
        body: data.body || '',
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: data.tag || ((data.title || '') + '::' + (data.body || '')),
        data: { url: data.url || './' },
      });
    })
  );
});

// Open or focus the app when the user taps a notification
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || './', self.location.origin);
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (new URL(client.url).pathname.startsWith(targetUrl.pathname) && 'focus' in client) {
          // Always notify the client so it can refresh stale data (e.g. selfie
          // notifications carry no URL params but still need a cache bust).
          client.postMessage({ type: 'notification-click', search: targetUrl.search });
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl.href);
    })
  );
});

// Network-first strategy for all requests
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go to network for Supabase API calls — never cache these
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Also skip Google Fonts runtime requests (CORS / opaque responses)
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then(cached =>
        fetch(event.request)
          .then(response => {
            // Cache a copy for offline use
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            return response;
          })
          .catch(() => cached || new Response('', { status: 503 }))
      )
    );
    return;
  }

  // Page loads always check the server for a fresh index.html (cheap when unchanged)
  // instead of reusing a copy the browser saved up to 10 minutes ago. That way a new
  // deploy shows up on the next reload. A redirect is passed back as a redirect.
  const isPageLoad = event.request.mode === 'navigate' && event.request.method === 'GET';
  const networkRequest = isPageLoad
    ? fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then(response => response.redirected ? Response.redirect(response.url, 302) : response)
    : fetch(event.request);

  // Network-first for everything else (HTML, CDN scripts, etc.)
  event.respondWith(
    networkRequest
      .then(response => {
        // Cache a copy of successful responses
        if (response.ok || response.type === 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        // ignoreSearch so offline still finds files cached before the ?v= stamp changed
        caches.match(event.request, { ignoreSearch: true }).then(cached => {
          if (cached) return cached;
          // For navigation requests, fall back to the cached app shell
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        })
      )
  );
});
