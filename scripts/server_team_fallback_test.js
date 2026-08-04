/**
 * Tests the new team-name fallback path added so that newly-registered players
 * from leagues NOT in SEARCH_LEAGUES (e.g. J1 League) can still be found
 * automatically, without needing to look up and register that league's numeric
 * ID first. When the frontend supplies an English club name (clubEn), the
 * server resolves it to a team ID via /teams?search=..., then searches
 * /players?search=<surname>&team=<id>&season=... directly - bypassing the
 * league loop entirely.
 *
 * Mocks a player on "Vissel Kobe" (J1 League, NOT in SEARCH_LEAGUES=39 for this
 * test) to confirm the team-id path finds them even though the league-loop path
 * would fail.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
process.env.SEARCH_LEAGUES = "39"; // deliberately NOT including J1 League, to prove the team-id path is what finds this player

global.fetch = async (url) => {
  const u = new URL(url.toString());

  if (u.pathname === "/teams" && u.searchParams.get("search") === "Vissel Kobe") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { team: { id: 292, name: "Vissel Kobe" } },
    ] }) };
  }

  if (u.pathname === "/players" && u.searchParams.get("team") === "292" && u.searchParams.get("search") === "Osako") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { player: { id: 5001, name: "Y. Osako", birth: { date: "1990-05-18" } },
        statistics: [{ team: { name: "Vissel Kobe" }, games: { appearences: 20 } }] },
    ] }) };
  }

  if (u.pathname === "/players" && u.searchParams.get("id") === "5001") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 5001, name: "Y. Osako", nationality: "Japan" },
      statistics: [{ team: { name: "Vissel Kobe" }, games: { appearences: 20, minutes: 1600, rating: "7.05" }, goals: { total: 10, assists: 4 }, cards: { yellow: 1, red: 0 } }],
    }] }) };
  }

  // Deliberately fail any league-based search (league=39) for this player, to prove
  // the team-id path — not the league loop — is what makes this test pass.
  if (u.pathname === "/players" && u.searchParams.get("league")) {
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

  const url = "/api/player-season-stats?name=" + encodeURIComponent("Yuya Osako") +
    "&teamEn=" + encodeURIComponent("Vissel Kobe") + "&birth=1990-05-18&season=2026";
  const body = await get(port, url);
  console.log(JSON.stringify(body, null, 2));

  if (!body.found) { console.error("FAIL: expected found=true via team-id fallback"); failures++; }
  if (body.team !== "Vissel Kobe") { console.error("FAIL: expected team=Vissel Kobe, got " + body.team); failures++; }
  if (body.stats && body.stats.goals !== 10) { console.error("FAIL: expected goals=10, got " + JSON.stringify(body.stats)); failures++; }

  server.close();
  console.log(failures === 0 ? "\nTeam-name (clubEn) fallback resolution PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
