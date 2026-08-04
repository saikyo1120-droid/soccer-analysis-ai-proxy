/**
 * Confirms that when Upstash env vars are absent, the accuracy-stats endpoint
 * honestly reports "not configured" with all-zero numbers (never fabricated
 * figures), and that fixture analysis still works normally without crashing.
 */
const path = require("path");
process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

global.fetch = async (url) => {
  const u = new URL(url.toString());
  if (u.pathname === "/fixtures" && u.searchParams.get("id") === "401") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 401, date: new Date(Date.now() + 3600e3).toISOString(), status: { short: "NS" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Liverpool", logo: "" }, away: { name: "Everton", logo: "" } },
      goals: { home: null, away: null },
    }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server, handleFixtureAnalysis, handleAccuracyStats } = require(path.join(__dirname, "..", "server", "server.js"));

(async () => {
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };

  const stats = await handleAccuracyStats();
  console.log(JSON.stringify(stats.body, null, 2));
  if (stats.body.configured !== false) fail("expected configured=false with no Upstash env vars");
  if (stats.body.total !== 0 || stats.body.resolved !== 0 || stats.body.correct !== 0) fail("expected all-zero stats, not fabricated numbers");
  if (stats.body.accuracyPct !== null) fail("expected accuracyPct=null (not 0%, not fabricated) when nothing recorded");

  const upcoming = await handleFixtureAnalysis(new URLSearchParams({ id: "401" }));
  if (upcoming.body.aiPrediction !== null) fail("expected aiPrediction=null when Upstash isn't configured (feature silently disabled)");
  if (!upcoming.body.found || upcoming.body.phase !== "upcoming") fail("fixture analysis itself should still work fine without Upstash");

  server.close();
  console.log(failures === 0 ? "\nNot-configured honesty check PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
