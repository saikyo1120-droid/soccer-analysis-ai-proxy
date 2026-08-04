const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.click('#modeSwitch button[data-mode="player"]');
  await page.fill("#playerSearchInput", "久保建英");
  await page.click("#playerSearchBtn");
  await page.waitForTimeout(300);

  const verdictVisible = await page.locator(".verdict-block").isVisible();
  const moreDisplayBefore = await page.evaluate(() => document.getElementById("playerMoreDetails").style.display);
  const attrMetersVisible = await page.locator(".attr-meter").first().isVisible();
  await page.click("#moreDetailsToggleBtn");
  await page.waitForTimeout(200);
  const moreDisplayAfter = await page.evaluate(() => document.getElementById("playerMoreDetails").style.display);
  const chatCardVisibleAfter = await page.locator("#chatMessages").isVisible();

  await browser.close();
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_|Load failed|Failed to fetch/.test(e));
  const checks = [
    ["verdict visible initially", verdictVisible === true],
    ["more-details hidden by default", moreDisplayBefore === "none"],
    ["ability meters visible without expanding", attrMetersVisible === true],
    ["more-details shown after click", moreDisplayAfter === "block"],
    ["chat card visible after expand", chatCardVisibleAfter === true],
    ["no real JS errors", realErrors.length === 0],
  ];
  checks.forEach(([label, ok]) => console.log(`  [${ok ? "OK" : "FAIL"}] ${label}`));
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "Card collapse PASSED." : "FAIL");
  process.exit(ok ? 0 : 1);
})();
