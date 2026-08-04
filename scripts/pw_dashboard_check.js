const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.waitForSelector("#dashboardCard", { state: "attached", timeout: 15000 });
  await page.waitForTimeout(300);

  const featuredPlayerText = await page.evaluate(() => document.getElementById("dashFeaturedPlayer").innerText);
  const featuredMatchText = await page.evaluate(() => document.getElementById("dashFeaturedMatch").innerText);

  await page.click("#dashFeaturedPlayerRow");
  await page.waitForTimeout(300);
  const playerModeActive = await page.evaluate(() => document.getElementById("playerSection").style.display !== "none");

  await page.click("#dashFeaturedMatchBtn");
  // Stage B: renderMatchAnalysis() now awaits /api/predict-match first (falling
  // back to identical local computation, PREDICT_MATCH_TIMEOUT_MS=1500ms in
  // index.html), so this must wait comfortably longer than the old instant render.
  await page.waitForTimeout(2000);
  const matchAnalysisText = await page.evaluate(() => document.getElementById("matchAnalysisWrap").innerText);

  // recently-viewed / recommended matches now live behind "もっと見る"
  await page.click("#dashMoreToggleBtn");
  await page.waitForTimeout(200);
  const recMatchesText = await page.evaluate(() => document.getElementById("dashRecommendedMatches").innerText);
  const recentText = await page.evaluate(() => document.getElementById("dashRecentlyViewed").innerText);

  await browser.close();
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_|Load failed|Failed to fetch/.test(e));
  const checks = [
    ["featured player widget has content", featuredPlayerText.length > 5],
    ["featured match widget has content", featuredMatchText.includes("vs")],
    ["clicking featured player switches mode", playerModeActive === true],
    ["match analysis rendered", matchAnalysisText.length > 30],
    ["recommended matches widget has content (after expand)", recMatchesText.includes("vs")],
    ["recently-viewed widget has content (after expand)", recentText.length > 5],
    ["no real JS errors", realErrors.length === 0],
  ];
  checks.forEach(([label, ok]) => console.log(`  [${ok ? "OK" : "FAIL"}] ${label}`));
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "Dashboard PASSED." : "FAIL");
  process.exit(ok ? 0 : 1);
})();
