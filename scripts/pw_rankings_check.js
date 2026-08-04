const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.click('#modeSwitch button[data-mode="player"]');
  await page.waitForSelector("#aiRankingsCard", { state: "attached", timeout: 15000 });
  await page.waitForTimeout(300);

  const dribbleRows = await page.locator("#rankingList .similar-row").count();
  await page.click('#rankingSwitch button[data-rank="finishing"]');
  await page.waitForTimeout(200);
  await page.click("#rankingList .similar-row");
  await page.waitForTimeout(300);
  const playerModeActive = await page.evaluate(() => document.getElementById("playerSection").style.display !== "none");

  await browser.close();
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_|Load failed|Failed to fetch/.test(e));
  const checks = [
    ["ranking rows exist", dribbleRows > 0],
    ["clicking a ranking row opens player mode", playerModeActive === true],
    ["no real JS errors", realErrors.length === 0],
  ];
  checks.forEach(([label, ok]) => console.log(`  [${ok ? "OK" : "FAIL"}] ${label}`));
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "Rankings PASSED." : "FAIL");
  process.exit(ok ? 0 : 1);
})();
