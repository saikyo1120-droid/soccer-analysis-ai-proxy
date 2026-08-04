/**
 * Tests /api/predictions/auto-collect — the endpoint that lets predictions be
 * logged and resolved automatically (e.g. via an external cron ping) WITHOUT
 * any real user visiting the site.
 *
 * Scenario:
 *  - Two fixtures already have unresolved pending predictions: one kicked off
 *    3 hours ago (should be checked+resolved this run) and one 30 minutes ago
 *    (too recent — should be skipped this run, per AUTO_COLLECT_RESOLVE_MIN_AGE_MS).
 *  - Today's fixture list includes one brand-new upcoming (NS) fixture that
 *    hasn't been logged yet — it should get logged (capped by AUTO_COLLECT_LOG_CAP).
 *  - Also confirms the secret-key gate (AUTO_COLLECT_SECRET) via an HTTP request.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.AUTO_COLLECT_SECRET = "s3cr3t";

const store = new Map();
const lists = new Map();

global.fetch = async (url, opts) => {
  const u = new URL(url.toString());

  if (u.hostname === "fake-upstash.example.com") {
    const [cmd, key, ...rest] = JSON.parse(opts.body);
    const C = cmd.toUpperCase();
    if (C === "GET") return { ok: true, json: async () => ({ result: store.has(key) ? store.get(key) : null }) };
    if (C === "SET") {
      if (String(rest[rest.length - 1]).toUpperCase() === "NX" && store.has(key)) return { ok: true, json: async () => ({ result: null }) };
      store.set(key, rest[0]);
      return { ok: true, json: async () => ({ result: "OK" }) };
    }
    if (C === "INCR") { const n = (parseInt(store.get(key), 10) || 0) + 1; store.set(key, String(n)); return { ok: true, json: async () => ({ result: n }) }; }
    if (C === "RPUSH") { const arr = lists.get(key) || []; arr.push(rest[0]); lists.set(key, arr); return { ok: true, json: async () => ({ result: arr.length }) }; }
    if (C === "LRANGE") { const arr = lists.get(key) || []; return { ok: true, json: async () => ({ result: arr.slice() }) }; }
    if (C === "LREM") { const arr = lists.get(key) || []; const idx = arr.indexOf(rest[1]); if (idx !== -1) arr.splice(idx, 1); lists.set(key, arr); return { ok: true, json: async () => ({ result: idx !== -1 ? 1 : 0 }) }; }
    if (C === "LTRIM") return { ok: true, json: async () => ({ result: "OK" }) };
    return { ok: true, json: async () => ({ result: null }) };
  }

  // Fake API-Football
  if (u.pathname === "/fixtures" && u.searchParams.get("id") === "501") {
    // kicked off 3h ago, finished 1-1
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 501, date: new Date(Date.now() - 3 * 3600e3).toISOString(), status: { short: "FT" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Fulham", logo: "" }, away: { name: "Brentford", logo: "" } },
      goals: { home: 1, away: 1 },
    }] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("date")) {
    // today's list: fixture 502 (already has a pending prediction, kicked off 30 min ago,
    // realistically still in progress -> too recent to check, and NOT finished yet either)
    // and fixture 503 (brand-new upcoming fixture, not yet logged)
    return { ok: true, json: async () => ({ errors: [], response: [
      {
        fixture: { id: 502, date: new Date(Date.now() - 0.5 * 3600e3).toISOString(), status: { short: "1H" } },
        league: { name: "Premier League" },
        teams: { home: { name: "Wolves", winner: null }, away: { name: "Burnley", winner: null } },
        goals: { home: 0, away: 0 },
      },
      {
        fixture: { id: 503, date: new Date(Date.now() + 3600e3).toISOString(), status: { short: "NS" } },
        league: { name: "Premier League" },
        teams: { home: { name: "Newcastle", winner: null }, away: { name: "Bournemouth", winner: null } },
        goals: { home: null, away: null },
      },
    ] }) };
  }
  if (u.pathname === "/predictions" && u.searchParams.get("fixture") === "503") {
    return { ok: true, json: async () => ({ errors: [], response: [{ predictions: { percent: { home: "40%", draw: "30%", away: "30%" } } }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server, handleAutoCollectPredictions } = require(path.join(__dirname, "..", "server", "server.js"));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(data); } catch (e) { return data; } })() }));
    }).on("error", reject);
  });
}

(async () => {
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };

  // Attach this BEFORE any other awaits — server.listen() runs synchronously at
  // require-time, and the "listening" event can fire before later code gets a
  // chance to attach a listener for it (which would hang this promise forever).
  const listeningPromise = server.listening ? Promise.resolve() : new Promise((resolve) => server.on("listening", resolve));

  // Pre-seed: fixture 501 has a 3h-old pending prediction (should resolve this run)
  store.set("pred:501", JSON.stringify({
    fixtureId: 501, home: "Fulham", away: "Brentford", predictedWinner: "draw",
    kickoff: new Date(Date.now() - 3 * 3600e3).toISOString(), resolved: false, homePct: 30, drawPct: 40, awayPct: 30,
  }));
  lists.set("pred:pending", ["501", "502"]);
  // fixture 502 also has a pending prediction, but kicked off only 30 min ago -> should be SKIPPED this run
  store.set("pred:502", JSON.stringify({
    fixtureId: 502, home: "Wolves", away: "Burnley", predictedWinner: "home",
    kickoff: new Date(Date.now() - 0.5 * 3600e3).toISOString(), resolved: false, homePct: 50, drawPct: 30, awayPct: 20,
  }));

  const result = await handleAutoCollectPredictions();
  console.log(JSON.stringify(result.body, null, 2));

  if (!result.body.upstashConfigured) fail("expected upstashConfigured=true");
  if (result.body.resolved !== 1) fail("expected exactly 1 resolution this run (fixture 501 only), got " + result.body.resolved);
  if (result.body.logged !== 1) fail("expected exactly 1 new prediction logged this run (fixture 503), got " + result.body.logged);

  const rec501 = JSON.parse(store.get("pred:501"));
  if (!rec501.resolved || rec501.actualWinner !== "draw" || rec501.correct !== true) fail("fixture 501 should resolve as draw/correct (predicted draw, actual 1-1)");

  const rec502 = JSON.parse(store.get("pred:502"));
  if (rec502.resolved) fail("fixture 502 (kicked off only 30 min ago) should NOT have been touched this run");

  if (!store.has("pred:503")) fail("fixture 503 should have been newly logged");
  else {
    const rec503 = JSON.parse(store.get("pred:503"));
    if (rec503.predictedWinner !== "home") fail("fixture 503 should be predicted home (40% highest)");
  }

  // HTTP-level secret gate check
  await listeningPromise;
  const port = server.address().port;
  const denied = await get(port, "/api/predictions/auto-collect");
  if (denied.status !== 403) fail("expected 403 when calling auto-collect without the secret key, got " + denied.status);
  const allowed = await get(port, "/api/predictions/auto-collect?key=s3cr3t");
  if (allowed.status !== 200) fail("expected 200 when calling auto-collect WITH the correct secret key, got " + allowed.status);

  server.close();
  console.log(failures === 0 ? "\nAuto-collect PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
