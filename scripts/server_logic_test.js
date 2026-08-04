/**
 * server/server.js は外部パッケージ不使用(npm install不要)なので、実際にサーバーを
 * 起動し、本物のHTTPリクエストを送って動作確認できる。API-Football側のレスポンスだけ
 * global.fetch を差し替えて模擬する(このサンドボックスからは api-football.com へ
 * 到達できないため、実際のキーでのエンドツーエンド確認ではない点に注意)。
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0"; // OSに空きポートを選ばせる

let fetchLog = [];
global.fetch = async (url) => {
  fetchLog.push(url.toString());
  const u = new URL(url.toString());
  if (u.pathname === "/players" && u.searchParams.get("search")) {
    return {
      ok: true,
      json: async () => ({
        errors: [],
        response: [
          { player: { id: 999, name: "Bukayo Saka", photo: "http://example.com/saka.png" },
            statistics: [{ team: { name: "Arsenal FC" }, games: { appearences: 20 } }] },
        ],
      }),
    };
  }
  if (u.pathname === "/players" && u.searchParams.get("id")) {
    return {
      ok: true,
      json: async () => ({
        errors: [],
        response: [{
          player: { id: 999, name: "Bukayo Saka" },
          statistics: [{
            team: { name: "Arsenal FC" },
            games: { appearences: 20, minutes: 1700, rating: "7.42" },
            goals: { total: 8, assists: 6 },
            cards: { yellow: 2, red: 0 },
          }],
        }],
      }),
    };
  }
  if (u.pathname === "/fixtures") {
    return {
      ok: true,
      json: async () => ({
        errors: [],
        response: [{
          fixture: { id: 1, date: new Date().toISOString(), status: { short: "NS" }, venue: { name: "Emirates Stadium" } },
          league: { name: "Premier League" },
          teams: { home: { name: "Arsenal", logo: "", winner: null }, away: { name: "Chelsea", logo: "", winner: null } },
          goals: { home: null, away: null },
        }],
      }),
    };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    }).on("error", reject);
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  console.log(`test server listening on 127.0.0.1:${port}`);
  let failures = 0;

  // 1) health
  {
    const r = await get(port, "/api/health");
    console.log("GET /api/health ->", r.status, JSON.stringify(r.body));
    if (!r.body.hasKey) { console.error("FAIL: expected hasKey true"); failures++; }
  }

  // 2) player-season-stats happy path
  {
    fetchLog = [];
    const r = await get(port, "/api/player-season-stats?name=" + encodeURIComponent("Bukayo Saka") + "&team=" + encodeURIComponent("Arsenal"));
    console.log("GET /api/player-season-stats ->", r.status, JSON.stringify(r.body));
    if (!r.body.found) { console.error("FAIL: expected found true"); failures++; }
    if (r.body.stats.goals !== 8 || r.body.stats.assists !== 6 || r.body.stats.avgRating !== 7.42) {
      console.error("FAIL: stats mismatch"); failures++;
    }
    console.log("  outbound API-Football calls:", fetchLog.length, fetchLog);
  }

  // 3) player-season-stats cached (second call should NOT hit fetch again)
  {
    fetchLog = [];
    const r = await get(port, "/api/player-season-stats?name=" + encodeURIComponent("Bukayo Saka") + "&team=" + encodeURIComponent("Arsenal"));
    if (fetchLog.length !== 0) { console.error("FAIL: expected cache hit with 0 outbound calls, got " + fetchLog.length); failures++; }
    else console.log("cache hit on 2nd request: OK (0 outbound calls)");
  }

  // 4) missing name -> 400
  {
    const r = await get(port, "/api/player-season-stats");
    if (r.status !== 400) { console.error("FAIL: expected 400 for missing name, got " + r.status); failures++; }
    else console.log("missing-name-400: OK");
  }

  // 5) fixtures/today
  {
    const r = await get(port, "/api/fixtures/today?leagues=39");
    console.log("GET /api/fixtures/today ->", r.status, JSON.stringify(r.body).slice(0, 200));
    if (!r.body.found || !r.body.fixtures.length) { console.error("FAIL: expected fixtures found"); failures++; }
  }

  // 6) API-Football returns HTTP error -> graceful found:false, not a crash
  {
    const savedFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const r = await get(port, "/api/player-season-stats?name=" + encodeURIComponent("Someone Never Cached Before XYZ"));
    console.log("GET with simulated 401 ->", r.status, JSON.stringify(r.body));
    if (r.body.found !== false) { console.error("FAIL: expected found=false on HTTP error"); failures++; }
    global.fetch = savedFetch;
  }

  // 7) static file serving: index.html should be served at /
  {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }).on("error", reject);
    });
    const ok = r.status === 200 && r.body.includes("<html") && r.body.includes("livePerfPanel");
    console.log("GET / (static index.html) -> status " + r.status + ", contains expected markers: " + ok);
    if (!ok) { console.error("FAIL: index.html not served correctly"); failures++; }
  }

  server.close();
  console.log(failures === 0 ? "\nAll server logic checks passed (real HTTP server, mocked API-Football fetch)." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
