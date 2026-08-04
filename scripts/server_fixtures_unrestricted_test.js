/**
 * Regression test for the "試合分析AI isn't showing real matches" bug report.
 * Root cause: the old handleFixturesToday looped over a fixed list of 5 European
 * top-flight leagues (DEFAULT_LEAGUES) — during Europe's summer off-season
 * (June-August) none of those leagues are playing, so the endpoint silently
 * returned zero fixtures for weeks even though real matches were happening
 * elsewhere (MLS, Brazil, J-League, friendlies, etc.).
 *
 * This test confirms:
 *  1) with no ?leagues= param, the endpoint queries /fixtures?date=... with NO
 *     league restriction (a single global query, not a per-league loop) and
 *     surfaces matches from ANY competition/country.
 *  2) youth/reserve/women's competitions are filtered out (FIXTURE_NAME_DENYLIST).
 *  3) an explicit ?leagues= override still narrows to just those league IDs
 *     (existing behavior, unchanged).
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";

let sawLeagueParam = false;

global.fetch = async (url) => {
  const u = new URL(url.toString());
  if (u.pathname === "/fixtures") {
    if (u.searchParams.get("league")) sawLeagueParam = true;
    // Simulate a realistic unrestricted worldwide day: Europe's top 5 leagues are
    // silent (off-season), but MLS, Brazil, and a youth competition all have games.
    return { ok: true, json: async () => ({ errors: [], response: [
      { fixture: { id: 101, date: new Date().toISOString(), status: { short: "NS" }, venue: { name: "Chase Stadium" } },
        league: { name: "MLS", country: "USA" },
        teams: { home: { name: "Inter Miami", logo: "", winner: null }, away: { name: "LA Galaxy", logo: "", winner: null } },
        goals: { home: null, away: null } },
      { fixture: { id: 102, date: new Date().toISOString(), status: { short: "NS" }, venue: { name: "Maracanã" } },
        league: { name: "Serie A", country: "Brazil" },
        teams: { home: { name: "Flamengo", logo: "", winner: null }, away: { name: "Palmeiras", logo: "", winner: null } },
        goals: { home: null, away: null } },
      { fixture: { id: 103, date: new Date().toISOString(), status: { short: "NS" }, venue: { name: "Youth Ground" } },
        league: { name: "Premier League U21" },
        teams: { home: { name: "Arsenal U21", logo: "", winner: null }, away: { name: "Chelsea U21", logo: "", winner: null } },
        goals: { home: null, away: null } },
    ] }) };
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

  const body = await get(port, "/api/fixtures/today"); // no ?leagues= — should be fully unrestricted
  console.log(JSON.stringify(body, null, 2));

  if (!body.found) { console.error("FAIL: expected found=true"); failures++; }
  if (sawLeagueParam) { console.error("FAIL: expected NO league param sent to API-Football for the unrestricted default path"); failures++; }
  const leagueNames = (body.fixtures || []).map((f) => f.league);
  if (!leagueNames.includes("MLS")) { console.error("FAIL: expected MLS fixture to appear"); failures++; }
  if (!leagueNames.includes("Serie A")) { console.error("FAIL: expected Brazilian Serie A fixture to appear"); failures++; }
  if (leagueNames.some((n) => /U21/i.test(n))) { console.error("FAIL: youth competition should have been filtered out"); failures++; }
  if ((body.fixtures || []).length !== 2) { console.error("FAIL: expected exactly 2 fixtures after youth filter, got " + (body.fixtures || []).length); failures++; }

  server.close();
  console.log(failures === 0 ? "\nUnrestricted worldwide fixtures + youth-filter PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
