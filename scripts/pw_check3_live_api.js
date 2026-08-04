/**
 * Strongest verification available in this sandbox: run the REAL server.js
 * (zero-dependency Node http server) in this process with global.fetch mocked
 * to emulate API-Football responses, then drive a REAL headless browser against
 * http://localhost:<port>/ to confirm the frontend's "🟢 実データ" panel and the
 * "📡 本日の実際の試合" card actually populate correctly end-to-end (browser -> our
 * proxy -> mocked API-Football -> back to browser). Only the actual outbound call
 * to api-football.com is faked, since this sandbox cannot reach that host.
 */
const path = require("path");
const { chromium } = require("playwright");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";

global.fetch = async (url) => {
  const u = new URL(url.toString());
  if (u.pathname === "/players" && u.searchParams.get("search")) {
    return { ok: true, json: async () => ({ errors: [], response: [
      { player: { id: 999, name: "Bukayo Saka", photo: "http://example.com/saka.png" },
        statistics: [{ team: { name: "Arsenal FC" }, games: { appearences: 20 } }] },
    ] }) };
  }
  if (u.pathname === "/players" && u.searchParams.get("id")) {
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 999, name: "Bukayo Saka" },
      statistics: [{ team: { name: "Arsenal FC" }, games: { appearences: 20, minutes: 1700, rating: "7.42" },
        goals: { total: 8, assists: 6 }, cards: { yellow: 2, red: 0 } }],
    }] }) };
  }
  if (u.pathname === "/fixtures") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      fixture: { id: 1, date: new Date().toISOString(), status: { short: "NS" }, venue: { name: "Emirates Stadium" } },
      league: { name: "Premier League" },
      teams: { home: { name: "Arsenal", logo: "", winner: null }, away: { name: "Chelsea", logo: "", winner: null } },
      goals: { home: null, away: null },
    }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  console.log(`live server on http://127.0.0.1:${port}/`);

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.click('#modeSwitch button[data-mode="player"]');
  await page.fill("#playerSearchInput", "ブカヨ・サカ");
  await page.click("#playerSearchBtn");
  await page.waitForTimeout(600); // allow renderRealPerformancePanel's fetch to resolve

  const liveBannerText = await page.locator("#livePerfPanel .live-data-banner").innerText().catch(() => null);
  console.log("live performance banner text:", liveBannerText);
  const statNums = await page.locator("#livePerfPanel .live-stat-item .num").allTextContents();
  console.log("live stat numbers (appearances, goals, assists, avgRating, minutes):", statNums);

  let failures = 0;
  if (!liveBannerText || !liveBannerText.includes("実データ")) { console.error("FAIL: live banner missing/wrong"); failures++; }
  if (statNums.join(",") !== "20,8,6,7.42,1700") { console.error("FAIL: stat numbers mismatch, got " + statNums.join(",")); failures++; }

  // the simulated section underneath should still be present too (both shown together)
  const simStillThere = await page.locator(".sim-banner").count();
  console.log("sim-banner count still present alongside live data:", simStillThere);
  if (simStillThere < 1) { console.error("FAIL: simulated section should remain visible too"); failures++; }

  await page.click('#modeSwitch button[data-mode="match"]');
  await page.waitForTimeout(500);
  const realFixturesVisible = await page.locator("#realFixturesCard").evaluate((el) => getComputedStyle(el).display);
  const realFixtureText = await page.locator("#realFixturesList").innerText().catch(() => null);
  console.log("realFixturesCard display:", realFixturesVisible, "| text:", realFixtureText);
  if (realFixturesVisible !== "block" || !realFixtureText || !realFixtureText.includes("Arsenal")) {
    console.error("FAIL: real fixtures card did not populate correctly"); failures++;
  }

  console.log("page errors:", pageErrors.length, pageErrors);
  if (pageErrors.length) failures++;

  await page.screenshot({ path: path.join(__dirname, "..", "pw_live_api_saka.png") });
  await page.click('#modeSwitch button[data-mode="match"]');
  await page.screenshot({ path: path.join(__dirname, "..", "pw_live_api_fixtures.png") });

  await browser.close();
  server.close();
  console.log(failures === 0 ? "\nAll live-API integration checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
