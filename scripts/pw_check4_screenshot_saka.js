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
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.click('#modeSwitch button[data-mode="player"]');
  await page.fill("#playerSearchInput", "ブカヨ・サカ");
  await page.click("#playerSearchBtn");
  await page.waitForTimeout(600);
  await page.locator("#livePerfPanel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(__dirname, "..", "pw_live_api_saka2.png") });
  await browser.close();
  server.close();
})();
