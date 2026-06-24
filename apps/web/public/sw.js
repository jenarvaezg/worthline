// worthline service worker
const CACHE_NAME = "worthline-shell-v1";

const PRECACHE_ASSETS = ["/manifest.json", "/icon.svg"];

// Cache static assets on fetch
const STATIC_ASSETS_PATTERNS = [
  /\/_next\/static\//,
  /\/icon\.svg$/,
  /\/manifest\.json$/,
  /\/mcp-icon\.svg$/,
];

function isStaticAsset(url) {
  return STATIC_ASSETS_PATTERNS.some((pattern) => pattern.test(url));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        // Individual precaching so single 404 does not break entire installation
        return Promise.allSettled(
          PRECACHE_ASSETS.map((asset) =>
            cache.add(asset).catch((err) => {
              console.warn(`Failed to precache asset: ${asset}`, err);
            }),
          ),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Inline offline HTML response
const OFFLINE_HTML = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sin conexión - worthline</title>
  <style>
    /* Design tokens mapped from app/globals.css to prevent offline style drift:
       background: #eef2ef -> --paper
       color: #17201e -> --ink
       container background: #fffdf7 -> --panel
       container border: #78877f -> --line
       h1 color: #006f5f -> --green
       p color: #51605b -> --muted
       button background: #17201e -> --ink
       button color: #fbfbf4 -> --paper-strong
    */
    body {
      background: #eef2ef;
      color: #17201e;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      text-align: center;
    }
    .container {
      max-width: 400px;
      padding: 30px;
      background: #fffdf7;
      border: 1px solid #78877f;
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(23, 32, 30, 0.06);
    }
    h1 {
      font-size: 1.5rem;
      margin-top: 0;
      color: #006f5f;
    }
    p {
      color: #51605b;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    button {
      background: #17201e;
      color: #fbfbf4;
      border: none;
      border-radius: 8px;
      font-weight: 600;
      padding: 10px 20px;
      cursor: pointer;
      min-height: 38px;
    }
    button:hover {
      background: #006f5f;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Sin conexión</h1>
    <p>worthline requiere conexión para computar y mostrar tus cifras autoritativas en tiempo real. No se muestran datos obsoletos por seguridad.</p>
    <button onclick="window.location.reload()">Reintentar</button>
  </div>
</body>
</html>
`;

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // We only handle same-origin or same-host requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // Network-First strategy for documents / data / POST / next-action
  const isDocument =
    request.mode === "navigate" ||
    (request.headers.get("Accept") || "").includes("text/html");
  const isPostOrAction = request.method === "POST" || request.headers.has("next-action");

  if (isDocument || isPostOrAction) {
    event.respondWith(
      fetch(request).catch(() => {
        // If it fails and it's a document/GET navigation, return the offline fallback
        if (isDocument && request.method === "GET") {
          return new Response(OFFLINE_HTML, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        // Let POSTs and APIs fail naturally with connection error
        throw new Error("Offline");
      }),
    );
    return;
  }

  // Cache-First (with network fallback) for static assets
  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            // Serve from cache, and refresh in background (stale-while-revalidate pattern)
            fetch(request)
              .then((networkResponse) => {
                if (networkResponse.status === 200) {
                  cache.put(request, networkResponse);
                }
              })
              .catch(() => {
                /* ignore background refresh failure when offline */
              });
            return cachedResponse;
          }
          // Fetch from network and cache
          return fetch(request).then((networkResponse) => {
            if (networkResponse.status === 200) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          });
        });
      }),
    );
  }
});
