const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.click('#modeSwitch button[data-mode="match"]');
  await page.waitForTimeout(300);
  await page.click('#matchList .match-analyze-btn[data-id="bayern-arsenal"]');
  // Stage B: renderMatchAnalysis() now awaits /api/predict-match (falling back to
  // identical local computation on failure/timeout, PREDICT_MATCH_TIMEOUT_MS=1500ms
  // in index.html) before it fills in this panel, so the wait here must comfortably
  // exceed that worst case rather than the old near-instant synchronous render.
  await page.waitForTimeout(2000);

  const text = await page.evaluate(() => document.getElementById("matchAnalysisWrap").innerText);
  const svgCount = await page.locator("#matchAnalysisWrap svg").count();

  await browser.close();
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_|Load failed|Failed to fetch/.test(e));
  const checks = [
    ["win factor section present", text.includes("予想勝因")],
    ["match flow heading present", text.includes("試合の流れ(予想)")],
    ["tactics board heading present", text.includes("戦術ボード")],
    ["3 SVG diagrams rendered", svgCount === 3],
    ["no real JS errors", realErrors.length === 0],
  ];
  checks.forEach(([label, ok]) => console.log(`  [${ok ? "OK" : "FAIL"}] ${label}`));
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "Match visual PASSED." : "FAIL");
  process.exit(ok ? 0 : 1);
})();
