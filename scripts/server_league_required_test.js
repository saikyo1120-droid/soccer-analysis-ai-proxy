/**
 * Regression test for the real production bug the user hit: API-Football's
 * /players endpoint rejects `search` used alone ("The League or Team field is
 * required with the Search field."). This mock enforces that exact rule (unlike
 * the earlier looser mocks) and confirms resolvePlayerId now always includes a
 * `league` id, so search calls succeed instead of erroring out.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
process.env.SEARCH_LEAGUES = "39,140,78"; // small set for the test

let sawBareSearchError = false;
global.fetch = async (url) => {
  const u = new URL(url.toString());
  if (u.pathname === "/players") {
    const hasSearch = u.searchParams.has("search");
    const hasLeagueOrTeam = u.searchParams.has("league") || u.searchParams.has("team");
    if (hasSearch && !hasLeagueOrTeam) {
      sawBareSearchError = true;
      return { ok: true, json: async () => ({
        errors: { team: "The League or Team field is required with the Search field.", league: "The League or Team field is required with the Search field." },
        response: [],
      }) };
    }
    if (hasSearch && hasLeagueOrTeam) {
      // only league 78 (Bundesliga) "has" this player, to prove the loop actually tries multiple leagues
      if (u.searchParams.get("league") !== "78") return { ok: true, json: async () => ({ errors: [], response: [] }) };
      return { ok: true, json: async () => ({ errors: [], response: [
        { player: { id: 7, name: "Joshua Kimmich", photo: "http://example.com/kimmich.png" },
          statistics: [{ team: { name: "Bayern Munich" }, games: { appearences: 10 } }] },
      ] }) };
    }
    if (u.searchParams.has("id")) {
      return { ok: true, json: async () => ({ errors: [], response: [{
        player: { id: 7, name: "Joshua Kimmich" },
        statistics: [{ team: { name: "Bayern Munich" }, games: { appearences: 25, minutes: 2100, rating: "7.80" }, goals: { total: 3, assists: 9 }, cards: { yellow: 4, red: 0 } }],
      }] }) };
    }
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

  const body = await get(port, "/api/player-season-stats?name=" + encodeURIComponent("Joshua Kimmich") + "&team=" + encodeURIComponent("Bayern"));
  console.log(JSON.stringify(body, null, 2));
  console.log("A bare search (no league/team) was attempted at some point:", sawBareSearchError);

  if (sawBareSearchError) { console.error("FAIL: resolvePlayerId must never call /players with search alone"); failures++; }
  if (!body.found) { console.error("FAIL: expected found=true (via the Bundesliga league fallback)"); failures++; }
  if (body.stats && body.stats.assists !== 9) { console.error("FAIL: expected Kimmich's assists=9, got " + JSON.stringify(body.stats)); failures++; }

  server.close();
  console.log(failures === 0 ? "\nLeague-required fix PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
