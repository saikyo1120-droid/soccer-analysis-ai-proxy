const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.waitForSelector("#aiAccuracyCard", { state: "attached", timeout: 15000 });
  await page.waitForSelector("#growthLogCard", { state: "attached", timeout: 15000 });
  // No backend proxy is running in this static-file check, so fetchAccuracyStats()
  // will fail fast and the widget must fall back to the honest "not configured /
  // no proxy" message rather than crash or show a fabricated number. Same rule
  // applies to the newer "昨日学んだこと" (growth log) widget.
  await page.waitForTimeout(500);
  const summaryText = await page.evaluate(() => document.getElementById("aiAccuracySummary").innerText);
  const noFabricatedPercent = !/\d+(\.\d+)?%/.test(summaryText) || /記録/.test(summaryText);
  const growthSummaryText = await page.evaluate(() => document.getElementById("growthLogSummary").innerText);
  const growthHonestFallback = /昨日学んだこと/.test(growthSummaryText) && !/今日追加した知識: \d+件/.test(growthSummaryText);

  await browser.close();
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_|Load failed|Failed to fetch/.test(e));
  const checks = [
    ["accuracy card present", summaryText.length > 0],
    ["mentions AI prediction record honestly (no proxy -> no fabricated %)", noFabricatedPercent],
    ["growth-log card present and honestly reports no data (no proxy)", growthHonestFallback],
    ["no real JS errors", realErrors.length === 0],
  ];
  checks.forEach(([label, ok]) => console.log(`  [${ok ? "OK" : "FAIL"}] ${label}`));
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "Accuracy widget PASSED." : "FAIL");
  process.exit(ok ? 0 : 1);
})();
