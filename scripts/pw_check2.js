const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push('pageerror: ' + err.message));

  const fileUrl = 'file://' + path.resolve('/tmp/soccer-analysis-ai/index.html');
  await page.goto(fileUrl);
  await page.waitForTimeout(800); // let renderRealPerformancePanel / renderRealFixturesIfAvailable settle

  const livePerfHtml = await page.locator('#livePerfPanel').innerHTML();
  console.log('livePerfPanel innerHTML (should be empty, no proxy running):', JSON.stringify(livePerfHtml));

  const realFixturesDisplay = await page.locator('#realFixturesCard').evaluate(el => getComputedStyle(el).display);
  console.log('realFixturesCard display (should be none):', realFixturesDisplay);

  // simulated section should still render fine underneath
  const simBannerCount = await page.locator('.sim-banner').count();
  console.log('sim-banner count on default view:', simBannerCount);

  // switch to match tab, should be unaffected
  await page.click('#modeSwitch button[data-mode="match"]');
  await page.waitForTimeout(300);
  const matchRows = await page.locator('.match-row').count();
  console.log('match rows still render:', matchRows);

  console.log('pageerror count (should be 0 — thrown JS errors only, network fetch failures are caught):', pageErrors.length);
  if (pageErrors.length) console.log(pageErrors.join('\n'));

  await browser.close();
  process.exit(pageErrors.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
