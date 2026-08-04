/**
 * Tests the new "real prediction accuracy tracking" system:
 *   - When an upcoming fixture is analyzed, a real API-Football /predictions
 *     percentage is fetched and logged to Upstash (mocked here) exactly once.
 *   - When that same fixture later comes back as finished, the logged
 *     prediction is resolved against the real final score and the aggregate
 *     stats (total/resolved/correct) update atomically.
 *   - /api/accuracy-stats honestly reports "not configured" when Upstash env
 *     vars are absent, and real numbers once they are present.
 *   - The "ながら解決" sweep inside /api/fixtures/today resolves a pending
 *     prediction using only the fixture list's own score data (no extra
 *     API-Football call).
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

// ---- Minimal in-memory fake of the pieces of Redis we actually use ----
const store = new Map(); // key -> string value
const lists = new Map(); // key -> array of strings
let apiFootballCalls = 0;
let upstashCalls = 0;

global.fetch = async (url, opts) => {
  const u = new URL(url.toString());

  // Fake Upstash: opts.body is a JSON-encoded command array, e.g. ["SET","k","v"]
  if (u.hostname === "fake-upstash.example.com") {
    upstashCalls++;
    const [cmd, key, ...rest] = JSON.parse(opts.body);
    const C = cmd.toUpperCase();
    if (C === "GET") return { ok: true, json: async () => ({ result: store.has(key) ? store.get(key) : null }) };
    if (C === "SET") {
      if (rest[0] !== undefined && String(rest[rest.length - 1]).toUpperCase() === "NX" && store.has(key)) {
        return { ok: true, json: async () => ({ result: null }) };
      }
      store.set(key, rest[0]);
      return { ok: true, json: async () => ({ result: "OK" }) };
    }
    if (C === "INCR") {
      const n = (parseInt(store.get(key), 10) || 0) + 1;
      store.set(key, String(n));
      return { ok: true, json: async () => ({ result: n }) };
    }
    if (C === "RPUSH") {
      const arr = lists.get(key) || [];
      arr.push(rest[0]);
      lists.set(key, arr);
      return { ok: true, json: async () => ({ result: arr.length }) };
    }
    if (C === "LRANGE") {
      const arr = lists.get(key) || [];
      return { ok: true, json: async () => ({ result: arr.slice() }) };
    }
    if (C === "LREM") {
      const arr = lists.get(key) || [];
      const idx = arr.indexOf(rest[1]);
      if (idx !== -1) arr.splice(idx, 1);
      lists.set(key, arr);
      return { ok: true, json: async () => ({ result: idx !== -1 ? 1 : 0 }) };
    }
    if (C === "LTRIM") {
      return { ok: true, json: async () => ({ result: "OK" }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  }

  // Fake API-Football
  apiFootballCalls++;
  if (u.pathname === "/fixtures" && u.searchParams.get("id") === "301") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 301, date: new Date(Date.now() + 3600e3).toISOString(), status: { short: "NS" }, venue: { name: "Anfield" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Liverpool", logo: "" }, away: { name: "Everton", logo: "" } },
      goals: { home: null, away: null },
    }] }) };
  }
  if (u.pathname === "/predictions" && u.searchParams.get("fixture") === "301") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      predictions: { percent: { home: "55%", draw: "25%", away: "20%" } },
    }] }) };
  }
  // Same fixture, now finished 2-0 home win (matches predicted winner "home")
  if (u.pathname === "/fixtures" && u.searchParams.get("id") === "301b") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 301, date: new Date(Date.now() - 3600e3).toISOString(), status: { short: "FT" }, venue: { name: "Anfield" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Liverpool", logo: "" }, away: { name: "Everton", logo: "" } },
      goals: { home: 2, away: 0 },
    }] }) };
  }
  if (u.pathname === "/fixtures/players") return { ok: true, json: async () => ({ errors: [], response: [] }) };
  if (u.pathname === "/fixtures/events") return { ok: true, json: async () => ({ errors: [], response: [] }) };
  if (u.pathname === "/fixtures" && u.searchParams.get("date")) {
    // "today" fixture list sweep test: fixture 301 shows up already finished 2-0
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 301, date: new Date().toISOString(), status: { short: "FT" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Liverpool", winner: true }, away: { name: "Everton", winner: false } },
      goals: { home: 2, away: 0 },
    }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const {
  server,
  handleFixtureAnalysis,
  handleAccuracyStats,
  outcomeFromScore,
} = require(path.join(__dirname, "..", "server", "server.js"));

function fakeQuery(obj) {
  const p = new URLSearchParams(obj);
  return p;
}

(async () => {
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };

  // 0. outcomeFromScore sanity
  if (outcomeFromScore(2, 0) !== "home") fail("outcomeFromScore(2,0) should be home");
  if (outcomeFromScore(0, 2) !== "away") fail("outcomeFromScore(0,2) should be away");
  if (outcomeFromScore(1, 1) !== "draw") fail("outcomeFromScore(1,1) should be draw");
  if (outcomeFromScore(null, 1) !== null) fail("outcomeFromScore with null goal should be null");

  // 1. Upcoming fixture analysis logs a real prediction (from mocked /predictions)
  const upcoming = await handleFixtureAnalysis(fakeQuery({ id: "301" }));
  console.log("---- upcoming (with prediction logging) ----");
  console.log(JSON.stringify(upcoming.body, null, 2));
  if (upcoming.body.phase !== "upcoming") fail("expected phase upcoming");
  if (!upcoming.body.aiPrediction) fail("expected aiPrediction to be logged from mocked /predictions");
  else {
    if (upcoming.body.aiPrediction.predictedWinner !== "home") fail("expected predictedWinner=home (55% > 25%/20%)");
    if (upcoming.body.aiPrediction.homePct !== 55) fail("expected homePct=55");
  }

  // Calling it again should NOT re-log (idempotent) — total should still be 1
  await handleFixtureAnalysis(fakeQuery({ id: "301" }));
  const totalAfterTwoCalls = store.get("pred:total");
  if (totalAfterTwoCalls !== "1") fail("expected pred:total to stay 1 after a second upcoming-analysis call, got " + totalAfterTwoCalls);

  // 2. Resolve via the finished-fixture path (id "301b" maps to the same underlying fixture 301, now FT 2-0)
  const finished = await handleFixtureAnalysis(fakeQuery({ id: "301b" }));
  console.log("---- finished (with prediction resolution) ----");
  console.log(JSON.stringify(finished.body.aiPredictionResult, null, 2));
  if (!finished.body.aiPredictionResult) fail("expected aiPredictionResult after resolving a finished match");
  else {
    if (finished.body.aiPredictionResult.actualWinner !== "home") fail("expected actualWinner=home (2-0)");
    if (finished.body.aiPredictionResult.correct !== true) fail("expected correct=true (predicted home, actual home)");
  }
  if (store.get("pred:resolved") !== "1") fail("expected pred:resolved=1, got " + store.get("pred:resolved"));
  if (store.get("pred:correct") !== "1") fail("expected pred:correct=1, got " + store.get("pred:correct"));
  const pendingList = lists.get("pred:pending") || [];
  if (pendingList.includes("301")) fail("fixture 301 should have been removed from pred:pending after resolving");

  // 3. /api/accuracy-stats reflects the real recorded numbers
  const stats = await handleAccuracyStats();
  console.log("---- accuracy stats ----");
  console.log(JSON.stringify(stats.body, null, 2));
  if (!stats.body.configured) fail("expected configured=true (Upstash env vars are set in this test)");
  if (stats.body.total !== 1) fail("expected total=1");
  if (stats.body.resolved !== 1) fail("expected resolved=1");
  if (stats.body.correct !== 1) fail("expected correct=1");
  if (stats.body.accuracyPct !== 100) fail("expected accuracyPct=100, got " + stats.body.accuracyPct);
  if (!Array.isArray(stats.body.recent) || stats.body.recent.length !== 1) fail("expected 1 recent record");

  server.close();
  console.log(failures === 0 ? "\nPrediction tracking PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
