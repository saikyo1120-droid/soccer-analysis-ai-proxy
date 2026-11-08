/* サッカー分析AI — サービスワーカー(v77・2026年9月1日・集客④PWA)
 * ----------------------------------------------------------------------------
 * 方針(劣化禁止):
 *   ・ネットワーク優先。常に最新のindex.htmlを届け、オフライン時だけキャッシュで代替。
 *     (キャッシュ優先にすると、更新のたびに古い画面が残る事故が起きるため採用しない)
 *   ・/api/ へのリクエストは一切触らない(鮮度・予算計測・レート制限をそのまま保つ)。
 *   ・POST等のGET以外・別オリジンも触らない。
 */
const CACHE_NAME = "soccer-ai-shell-v101"; // v101: 画面更新(引き分け注意・較正済み確信度の表示)に合わせて更新
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => { /* 事前キャッシュ失敗でもSW自体は動かす(次のfetchで再取得される) */ })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // APIはSWを素通し

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // キャッシュするのはアプリの殻(シェル)だけ。試合ページ等はサーバー側の
      // キャッシュ制御に任せる(端末に古いページを残さない)。
      if (fresh && fresh.ok && (url.pathname === "/" || SHELL.indexOf(url.pathname) !== -1)) {
        const cache = await caches.open(CACHE_NAME);
        // v97: トップページは「/?from=x」のような検索文字列つきで開かれることが多い(流入計測)。
        //   そのままの URL で保存すると、オフライン時の代替(caches.match("/"))に一致しない。
        //   トップページはパス名「/」で保存する(他のシェル資産は従来どおり)。
        const putKey = url.pathname === "/" ? new Request("/") : req;
        cache.put(putKey, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === "navigate") {
        const home = await caches.match("/");
        if (home) return home;
      }
      throw err;
    }
  })());
});
