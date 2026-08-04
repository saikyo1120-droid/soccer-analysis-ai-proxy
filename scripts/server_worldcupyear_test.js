/**
 * Regression test built from the ACTUAL raw API-Football response the user pasted
 * back from the /api/debug/raw-player endpoint in production (2026, a World Cup
 * year): for player id=1460 (Saka), season=2026 has statistics=[] with ONLY two
 * England national-team entries (Friendlies + World Cup) - Arsenal has not
 * recorded any statistics entry for this season at all yet. The previous fix
 * (filtering out national-team entries) correctly emptied the club pool for this
 * season, but then incorrectly fell back to using the national-team entries
 * anyway, so the bug persisted. This test confirms the "continue to an earlier
 * season instead of falling back to country stats" fix actually resolves it.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
process.env.SEARCH_LEAGUES = "39";

global.fetch = async (url) => {
  const u = new URL(url.toString());

  if (u.pathname === "/players" && u.searchParams.get("search") === "Saka") {
    return { ok: true, json: async () => ({ errors: [], results: 1, response: [
      { player: { id: 1460, name: "B. Saka", nationality: "England", birth: { date: "2001-09-05" } },
        statistics: [{ team: { name: "England" }, games: { appearences: 7 } }] },
    ] }) };
  }

  if (u.pathname === "/players" && u.searchParams.get("id") === "1460" && u.searchParams.get("season") === "2026") {
    // Exact shape reported live: statistics has ONLY national-team entries, no Arsenal at all.
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 1460, name: "B. Saka", nationality: "England" },
      statistics: [
        { team: { name: "England" }, league: { name: "Friendlies" }, games: { appearences: 1, minutes: 27, rating: "6.9" }, goals: { total: 0, assists: 0 }, cards: { yellow: 0, red: 0 } },
        { team: { name: "England" }, league: { name: "World Cup" }, games: { appearences: 7, minutes: 357, rating: "7.33" }, goals: { total: 3, assists: 3 }, cards: { yellow: 0, red: 0 } },
      ],
    }] }) };
  }

  if (u.pathname === "/players" && u.searchParams.get("id") === "1460" && u.searchParams.get("season") === "2025") {
    // Previous completed club season: real Arsenal stats.
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 1460, name: "B. Saka", nationality: "England" },
      statistics: [
        { team: { name: "Arsenal" }, games: { appearences: 31, minutes: 2225, rating: "7.24" }, goals: { total: 7, assists: 5 }, cards: { yellow: 2, red: 0 } },
      ],
    }] }) };
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

  const body = await get(port, "/api/player-season-stats?name=" + encodeURIComponent("Bukayo Saka") + "&team=Arsenal&birth=2001-09-05&season=2026");
  console.log(JSON.stringify(body, null, 2));

  if (!body.found) { console.error("FAIL: expected found=true"); failures++; }
  if (body.team !== "Arsenal") { console.error("FAIL: expected team=Arsenal (got national-team data leaking through), got " + body.team); failures++; }
  if (body.season !== 2025) { console.error("FAIL: expected fallback to season 2025 (2026 has no club entry at all), got " + body.season); failures++; }
  if (body.stats && body.stats.appearances !== 31) { console.error("FAIL: expected Arsenal appearances=31, got " + JSON.stringify(body.stats)); failures++; }
  if (body.stats && body.stats.goals !== 7) { console.error("FAIL: expected Arsenal goals=7 (not England's 3), got " + JSON.stringify(body.stats)); failures++; }

  server.close();
  console.log(failures === 0 ? "\nWorld-Cup-year (club-absent-this-season) fix PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
