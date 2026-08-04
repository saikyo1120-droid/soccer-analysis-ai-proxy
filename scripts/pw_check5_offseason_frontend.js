/**
 * Full end-to-end check of the off-season fallback fix, using a temporary local
 * copy of index.html with API_PROXY_BASE pointed at the local test server instead
 * of the production Render URL (which this sandbox cannot reach). Confirms the
 * browser-side rendering correctly shows the 🟢実データ badge + the "off-season,
 * showing last completed season" note when the current season has 0 appearances.
 */
const path = require("path");
const { chromium } = require("playwright");

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
      return { ok: true, json: async () => ({ errors: [], response: [{
        player: { id: 42, name: "Lionel Messi" },
        statistics: [{ team: { name: "Inter Miami CF" }, games: { appearences: 0, minutes: 0, rating: null }, goals: { total: 0, assists: 0 }, cards: { yellow: 0, red: 0 } }],
      }] }) };
    }
    if (season === "2025") {
      return { ok: true, json: async () => ({ errors: [], response: [{
        player: { id: 42, name: "Lionel Messi" },
        statistics: [{ team: { name: "Inter Miami CF" }, games: { appearences: 28, minutes: 2300, rating: "8.10" }, goals: { total: 22, assists: 15 }, cards: { yellow: 3, red: 0 } }],
      }] }) };
    }
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require("/tmp/local_test_site/server/server.js");

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(`http://127.0.0.1:${port}/`);
  // default view already shows Messi's card
  await page.waitForTimeout(700);

  const bannerText = await page.locator("#livePerfPanel .live-data-banner").innerText().catch(() => null);
  console.log("banner text:", bannerText);
  const nums = await page.locator("#livePerfPanel .live-stat-item .num").allTextContents();
  console.log("stat numbers:", nums);

  let failures = 0;
  if (!bannerText || !bannerText.includes("実データ")) { console.error("FAIL: banner missing"); failures++; }
  if (!bannerText || !bannerText.includes("2025")) { console.error("FAIL: expected mention of fallback season 2025"); failures++; }
  if (!bannerText || !bannerText.includes("直近の完了シーズン")) { console.error("FAIL: expected off-season fallback note text"); failures++; }
  if (nums.join(",") !== "28,22,15,8.1,2300") { console.error("FAIL: stat numbers mismatch: " + nums.join(",")); failures++; }

  console.log("page errors:", pageErrors.length, pageErrors);
  if (pageErrors.length) failures++;

  await page.screenshot({ path: "/tmp/soccer-analysis-ai/pw_offseason_fix.png" });
  await browser.close();
  server.close();
  console.log(failures === 0 ? "\nOff-season frontend fallback check PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
