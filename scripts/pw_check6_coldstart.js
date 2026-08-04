/**
 * Regression test for the cold-start timeout fix. Simulates a Render free-tier
 * "waking up" delay (a slow but eventually-successful response, well past the
 * old 4-second timeout that caused this exact bug) and confirms the frontend now
 * waits it out and still shows the 🟢実データ badge, plus shows a loading note
 * while waiting instead of looking frozen.
 */
const { chromium } = require("playwright");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

global.fetch = async (url) => {
  const u = new URL(url.toString());
  await delay(7000); // simulate a slow cold-started response — longer than the old 4s timeout, shorter than the new 60s one
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
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require("/tmp/coldstart_site/server/server.js");

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.click('#modeSwitch button[data-mode="player"]');
  await page.fill("#playerSearchInput", "ブカヨ・サカ");
  await page.click("#playerSearchBtn");

  // right after the click, before the 7s mock delay resolves, we should see the loading note
  await page.waitForTimeout(500);
  const loadingText = await page.locator("#livePerfPanel").innerText().catch(() => "");
  console.log("shortly after click, livePerfPanel shows:", JSON.stringify(loadingText));

  // now wait past the simulated 7s cold-start delay
  await page.waitForTimeout(8000);
  const bannerText = await page.locator("#livePerfPanel .live-data-banner").innerText().catch(() => null);
  console.log("after waiting out the cold start, banner:", bannerText);

  let failures = 0;
  if (!loadingText.includes("確認中")) { console.error("FAIL: expected loading note while waiting"); failures++; }
  if (!bannerText || !bannerText.includes("実データ")) { console.error("FAIL: expected live badge to eventually appear despite 7s delay (old 4s timeout would have missed this)"); failures++; }

  await browser.close();
  server.close();
  console.log(failures === 0 ? "\nCold-start timeout fix PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
