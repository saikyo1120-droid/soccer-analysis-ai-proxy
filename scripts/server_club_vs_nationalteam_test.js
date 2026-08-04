/**
 * Regression test for the exact bug the user hit in production: a player's
 * /players?id=...&season=... response can contain BOTH a club statistics
 * entry (e.g. Arsenal) AND a national-team entry (e.g. England) in the same
 * season array. Early in a new season the club entry may have 0 appearances
 * while the national-team entry already has several caps (e.g. summer
 * friendlies/qualifiers) - the old code's plain "highest appearances" reduce()
 * picked England over Arsenal, which is wrong for a club-scouting-focused app.
 *
 * This test mocks exactly that shape for season 2026 (0 club apps, 7 national
 * caps) and confirms the server:
 *   1) does NOT report team="England" for the current season fallback slot,
 *   2) falls through to season 2025 (which has real Arsenal stats) and
 *      reports team="Arsenal" with the season-2025 numbers.
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
        statistics: [{ team: { name: "Arsenal" }, games: { appearences: 0 } }] },
    ] }) };
  }

  if (u.pathname === "/players" && u.searchParams.get("id") === "1460" && u.searchParams.get("season") === "2026") {
    // Current (new/off-)season: club has 0 apps so far, but national team already
    // has caps (e.g. summer internationals) - this is the shape that caused the bug.
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 1460, name: "B. Saka", nationality: "England" },
      statistics: [
        { team: { name: "England" }, games: { appearences: 7, minutes: 357, rating: "7.33" }, goals: { total: 3, assists: 3 }, cards: { yellow: 0, red: 0 } },
        { team: { name: "Arsenal" }, games: { appearences: 0, minutes: 0, rating: null }, goals: { total: 0, assists: 0 }, cards: { yellow: 0, red: 0 } },
      ],
    }] }) };
  }

  if (u.pathname === "/players" && u.searchParams.get("id") === "1460" && u.searchParams.get("season") === "2025") {
    // Previous completed season: real, substantial Arsenal club stats.
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 1460, name: "B. Saka", nationality: "England" },
      statistics: [
        { team: { name: "Arsenal" }, games: { appearences: 31, minutes: 2225, rating: "7.24" }, goals: { total: 7, assists: 5 }, cards: { yellow: 2, red: 0 } },
        { team: { name: "England" }, games: { appearences: 5, minutes: 300, rating: "7.10" }, goals: { total: 1, assists: 1 }, cards: { yellow: 0, red: 0 } },
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
  if (body.team !== "Arsenal") { console.error("FAIL: expected team=Arsenal, got " + body.team); failures++; }
  if (body.season !== 2025) { console.error("FAIL: expected fallback to season 2025 (2026 club apps=0), got " + body.season); failures++; }
  if (body.stats && body.stats.appearances !== 31) { console.error("FAIL: expected Arsenal appearances=31, got " + JSON.stringify(body.stats)); failures++; }
  if (body.stats && body.stats.goals !== 7) { console.error("FAIL: expected Arsenal goals=7 (not England's), got " + JSON.stringify(body.stats)); failures++; }

  server.close();
  console.log(failures === 0 ? "\nClub-vs-national-team stats selection PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
