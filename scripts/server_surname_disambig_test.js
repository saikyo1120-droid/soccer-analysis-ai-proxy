/**
 * Regression test replicating the exact real-world case discovered via the
 * /api/debug/raw-search endpoint in production: searching the full name
 * "Bukayo Saka" returns 0 results (API-Football indexes players by short/
 * surname), but searching "Saka" returns TWO players — Bukayo Saka AND Aaron
 * Wan-Bissaka (since "Wan-Bissaka" contains "saka" as a substring). Confirms
 * the surname-search fallback finds him, and that birthdate disambiguation
 * picks the correct one out of the two candidates rather than just taking
 * the first result blindly.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
process.env.SEARCH_LEAGUES = "39";

global.fetch = async (url) => {
  const u = new URL(url.toString());
  if (u.pathname === "/players" && u.searchParams.get("search") === "Bukayo Saka") {
    return { ok: true, json: async () => ({ errors: [], results: 0, response: [] }) }; // full name: no match, as observed live
  }
  if (u.pathname === "/players" && u.searchParams.get("search") === "Saka") {
    return { ok: true, json: async () => ({ errors: [], results: 2, response: [
      { player: { id: 1460, name: "B. Saka", birth: { date: "2001-09-05" } },
        statistics: [{ team: { name: "Arsenal" }, games: { appearences: 31 } }] },
      { player: { id: 18846, name: "A. Wan-Bissaka", birth: { date: "1997-11-26" } },
        statistics: [{ team: { name: "West Ham" }, games: { appearences: 25 } }] },
    ] }) };
  }
  if (u.pathname === "/players" && u.searchParams.get("id") === "1460") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 1460, name: "B. Saka" },
      statistics: [{ team: { name: "Arsenal" }, games: { appearences: 31, minutes: 2225, rating: "7.24" }, goals: { total: 7, assists: 5 }, cards: { yellow: 2, red: 0 } }],
    }] }) };
  }
  if (u.pathname === "/players" && u.searchParams.get("id") === "18846") {
    // if disambiguation picked the WRONG player, the test should catch it here
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 18846, name: "A. Wan-Bissaka" },
      statistics: [{ team: { name: "West Ham" }, games: { appearences: 25, minutes: 2084, rating: "6.64" }, goals: { total: 0, assists: 2 }, cards: { yellow: 4, red: 0 } }],
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

  const body = await get(port, "/api/player-season-stats?name=" + encodeURIComponent("Bukayo Saka") + "&team=" + encodeURIComponent("アーセナルFC") + "&birth=2001-09-05");
  console.log(JSON.stringify(body, null, 2));

  if (!body.found) { console.error("FAIL: expected found=true via surname search"); failures++; }
  if (body.player && body.player.id !== 1460) { console.error("FAIL: disambiguation picked the wrong player (id=" + (body.player && body.player.id) + "), expected Saka (1460)"); failures++; }
  if (body.stats && body.stats.goals !== 7) { console.error("FAIL: expected Saka's goals=7 (not Wan-Bissaka's), got " + JSON.stringify(body.stats)); failures++; }

  server.close();
  console.log(failures === 0 ? "\nSurname search + birthdate disambiguation PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
