/**
 * Tests the new /api/fixtures/analysis endpoint, which powers real (not
 * simulated) AI-assisted pre-match and post-match analysis for a specific
 * real fixture the user picks from "本日の実際の試合".
 *
 * Case A: fixture id=201 hasn't kicked off yet (status "NS") -> phase "upcoming",
 *   no extra API-Football calls should be made beyond the single /fixtures?id= lookup.
 * Case B: fixture id=202 is finished (status "FT") -> phase "finished", with real
 *   per-player ratings (sorted, subs-with-no-minutes excluded) and a real goal/
 *   card events timeline pulled from /fixtures/players and /fixtures/events.
 * Case C(2026年8月・優先順位④で追加): fixture id=203 is in-play (status "1H") ->
 *   phase "live", with real partial player ratings/events so far (same data
 *   source as "finished", but no prediction-resolution and a short cache TTL).
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";

const calls = [];

global.fetch = async (url) => {
  const u = new URL(url.toString());
  calls.push(u.pathname + "?" + u.searchParams.toString());

  if (u.pathname === "/fixtures" && u.searchParams.get("id") === "201") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 201, date: new Date(Date.now() + 3600e3).toISOString(), status: { short: "NS" }, venue: { name: "Anfield" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Liverpool", logo: "" }, away: { name: "Everton", logo: "" } },
      goals: { home: null, away: null },
    }] }) };
  }

  if (u.pathname === "/fixtures" && u.searchParams.get("id") === "202") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 202, date: new Date(Date.now() - 7200e3).toISOString(), status: { short: "FT" }, venue: { name: "Emirates Stadium" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Arsenal", logo: "" }, away: { name: "Chelsea", logo: "" } },
      goals: { home: 2, away: 1 },
    }] }) };
  }

  if (u.pathname === "/fixtures/players" && u.searchParams.get("fixture") === "202") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { team: { name: "Arsenal" }, players: [
        { player: { name: "B. Saka", photo: "" }, statistics: [{ games: { minutes: 90, position: "F", rating: "8.40" }, goals: { total: 1, assists: 1 }, cards: { yellow: 0, red: 0 } }] },
        { player: { name: "M. Ødegaard", photo: "" }, statistics: [{ games: { minutes: 90, position: "M", rating: "7.10" }, goals: { total: 0, assists: 1 }, cards: { yellow: 1, red: 0 } }] },
        { player: { name: "Bench Player", photo: "" }, statistics: [{ games: { minutes: 0, position: "M", rating: null }, goals: { total: 0, assists: 0 }, cards: { yellow: 0, red: 0 } }] },
      ] },
      { team: { name: "Chelsea" }, players: [
        { player: { name: "C. Palmer", photo: "" }, statistics: [{ games: { minutes: 90, position: "F", rating: "7.50" }, goals: { total: 1, assists: 0 }, cards: { yellow: 0, red: 0 } }] },
      ] },
    ] }) };
  }

  if (u.pathname === "/fixtures/events" && u.searchParams.get("fixture") === "202") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { time: { elapsed: 23, extra: null }, team: { name: "Arsenal" }, player: { name: "B. Saka" }, assist: { name: "M. Ødegaard" }, type: "Goal", detail: "Normal Goal" },
      { time: { elapsed: 55, extra: null }, team: { name: "Chelsea" }, player: { name: "C. Palmer" }, assist: {}, type: "Goal", detail: "Normal Goal" },
      { time: { elapsed: 78, extra: null }, team: { name: "Arsenal" }, player: { name: "B. Saka" }, assist: {}, type: "Goal", detail: "Normal Goal" },
    ] }) };
  }

  // Case C(2026年8月・優先順位④で追加): 試合中(status "1H")のケース。
  if (u.pathname === "/fixtures" && u.searchParams.get("id") === "203") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 203, date: new Date(Date.now() - 1800e3).toISOString(), status: { short: "1H", elapsed: 30 }, venue: { name: "Old Trafford" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Man United", logo: "" }, away: { name: "Man City", logo: "" } },
      goals: { home: 1, away: 0 },
    }] }) };
  }
  if (u.pathname === "/fixtures/players" && u.searchParams.get("fixture") === "203") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { team: { name: "Man United" }, players: [
        { player: { name: "B. Fernandes", photo: "" }, statistics: [{ games: { minutes: 30, position: "M", rating: "7.20" }, goals: { total: 1, assists: 0 }, cards: { yellow: 0, red: 0 } }] },
      ] },
      { team: { name: "Man City" }, players: [] },
    ] }) };
  }
  if (u.pathname === "/fixtures/events" && u.searchParams.get("fixture") === "203") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { time: { elapsed: 12, extra: null }, team: { name: "Man United" }, player: { name: "B. Fernandes" }, assist: {}, type: "Goal", detail: "Normal Goal" },
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

  // Case A: upcoming match
  const upcoming = await get(port, "/api/fixtures/analysis?id=201");
  console.log("---- upcoming ----");
  console.log(JSON.stringify(upcoming, null, 2));
  if (!upcoming.found || upcoming.phase !== "upcoming") { console.error("FAIL: expected phase=upcoming"); failures++; }
  if (calls.some((c) => c.startsWith("/fixtures/players") || c.startsWith("/fixtures/events"))) {
    console.error("FAIL: should not call /fixtures/players or /fixtures/events for an upcoming match");
    failures++;
  }

  // Case B: finished match
  const finished = await get(port, "/api/fixtures/analysis?id=202");
  console.log("---- finished ----");
  console.log(JSON.stringify(finished, null, 2));
  if (!finished.found || finished.phase !== "finished") { console.error("FAIL: expected phase=finished"); failures++; }
  if (!finished.homePlayers || finished.homePlayers.length !== 2) { console.error("FAIL: expected 2 home players with minutes>0 (bench player excluded)"); failures++; }
  if (!finished.motmHome || finished.motmHome.name !== "B. Saka") { console.error("FAIL: expected Saka (highest rating 8.40) as home MOTM, got " + JSON.stringify(finished.motmHome)); failures++; }
  if (!finished.events || finished.events.length !== 3) { console.error("FAIL: expected 3 timeline events"); failures++; }

  // Case C: live (in-play) match
  const live = await get(port, "/api/fixtures/analysis?id=203");
  console.log("---- live ----");
  console.log(JSON.stringify(live, null, 2));
  if (!live.found || live.phase !== "live") { console.error("FAIL: expected phase=live, got " + JSON.stringify(live.phase)); failures++; }
  if (!live.homePlayers || live.homePlayers.length !== 1 || live.homePlayers[0].name !== "B. Fernandes") { console.error("FAIL: expected 1 real home player rating so far"); failures++; }
  if (!live.events || live.events.length !== 1) { console.error("FAIL: expected 1 real event so far"); failures++; }
  if (live.elapsed !== 30) { console.error("FAIL: expected elapsed=30, got " + JSON.stringify(live.elapsed)); failures++; }
  if (live.aiPredictionResult !== undefined) { console.error("FAIL: live phase should not resolve/expose a final prediction result yet"); failures++; }
  if (live.motmHome !== undefined) { console.error("FAIL: live phase should not declare a final MOTM (match not over)"); failures++; }

  server.close();
  console.log(failures === 0 ? "\nFixture analysis endpoint PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
