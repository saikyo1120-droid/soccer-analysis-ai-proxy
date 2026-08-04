/**
 * Regression test for the off-season fallback fix: when the brand-new season
 * (e.g. 2026) has 0 official appearances yet, the server should automatically
 * fall back to the most recent season that actually has stats (e.g. 2025)
 * instead of reporting found:false / "no_statistics". This is exactly the bug
 * the user hit in production on 2026-07-31 (pre-season for most European
 * leagues): /api/health was fine but no player ever showed the 🟢実データ badge.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";

global.fetch = async (url) => {
  const u = new URL(url.toString());
  if (u.pathname === "/players" && u.searchParams.get("search")) {
    return { ok: true, json: async () => ({ errors: [], response: [
      { player: { id: 42, name: "Lionel Messi", photo: "http://example.com/messi.png" },
        statistics: [{ team: { name: "Inter Miami CF" }, games: { appearences: 0 } }] },
    ] }) };
  }
  if (u.pathname === "/players" && u.searchParams.get("id")) {
    const season = u.searchParams.get("season");
    if (season === "2026") {
      // brand-new season just started: no official matches played yet
      return { ok: true, json: async () => ({ errors: [], response: [{
        player: { id: 42, name: "Lionel Messi" },
        statistics: [{ team: { name: "Inter Miami CF" }, games: { appearences: 0, minutes: 0, rating: null }, goals: { total: 0, assists: 0 }, cards: { yellow: 0, red: 0 } }],
      }] }) };
    }
    if (season === "2025") {
      // last completed season: real full-season numbers
      return { ok: true, json: async () => ({ errors: [], response: [{
        player: { id: 42, name: "Lionel Messi" },
        statistics: [{ team: { name: "Inter Miami CF" }, games: { appearences: 28, minutes: 2300, rating: "8.10" }, goals: { total: 22, assists: 15 }, cards: { yellow: 3, red: 0 } }],
      }] }) };
    }
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
    }).on("error", reject);
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  let failures = 0;

  const body = await get(port, "/api/player-season-stats?name=" + encodeURIComponent("Lionel Messi") + "&team=" + encodeURIComponent("Inter Miami"));
  console.log(JSON.stringify(body, null, 2));

  if (!body.found) { console.error("FAIL: expected found=true via fallback"); failures++; }
  if (body.season !== 2025) { console.error("FAIL: expected fallback to season 2025, got " + body.season); failures++; }
  if (body.requestedSeason !== 2026) { console.error("FAIL: expected requestedSeason 2026, got " + body.requestedSeason); failures++; }
  if (body.stats.goals !== 22 || body.stats.appearances !== 28) { console.error("FAIL: expected 2025 season stats (28 apps, 22 goals), got " + JSON.stringify(body.stats)); failures++; }

  server.close();
  console.log(failures === 0 ? "\nOff-season fallback test PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
