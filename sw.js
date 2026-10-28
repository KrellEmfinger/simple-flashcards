/* Offline support for Simple Flashcards.
 * - The app files are cached when the app is first opened and refreshed in the background.
 * - Deck and pack files are fetched fresh when online and served from the cache when offline.
 * Bump VERSION when the list of app files changes. */
const VERSION = "v1";
const CACHE = "flashcards-" + VERSION;
const FONT_CACHE = "flashcards-fonts";
const APP_FILES = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon-64.png"];

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(APP_FILES);
  // decks and packs listed in their index files
  for (const [folder, pick] of [["decks", (j) => (j.decks || []).map((d) => d.file)], ["packs", (j) => (Array.isArray(j) ? j : []).map((p) => p.file)]]) {
    try {
      const res = await fetch(`${folder}/index.json`, { cache: "no-cache" });
      if (!res.ok) continue;
      await cache.put(`${folder}/index.json`, res.clone());
      const files = pick(await res.json()).filter(Boolean).map((f) => `${folder}/${f}`);
      await Promise.all(files.map((f) => cache.add(f).catch(() => {})));
    } catch (e) { /* offline during install: cached on first use instead */ }
  }
}
self.addEventListener("install", (e) => { e.waitUntil(precache().then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("flashcards-") && k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const update = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await update) || (req.mode === "navigate" ? cache.match("index.html") : Response.error());
}
async function cacheFirst(req) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try { const res = await fetch(req); if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }
  catch (e) { return Response.error(); }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") { e.respondWith(cacheFirst(req)); return; }
  if (url.origin !== location.origin) return;            // GitHub and Anthropic API calls go straight to the network
  if (/\/(decks|packs)\/[^/]+\.json$/.test(url.pathname)) { e.respondWith(networkFirst(req)); return; }
  e.respondWith(staleWhileRevalidate(req));
});
