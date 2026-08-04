const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

  const fileUrl = 'file://' + path.resolve('/tmp/soccer-analysis-ai/index.html');
  await page.goto(fileUrl);
  await page.waitForTimeout(500);

  // 1) default Messi card renders, avatar-lg present, contract card present
  const hasAvatar = await page.locator('#playerAvatar').count();
  const hasContract = await page.locator('text=現在の契約').count();
  console.log('default view: avatar el=' + hasAvatar + ' contract heading=' + hasContract);

  // 2) switch to a chip (Saka) via filter-less click, verify photo/chat/compare present
  await page.click('#modeSwitch button[data-mode="player"]');
  await page.waitForTimeout(200);
  await page.fill('#playerSearchInput', 'ブカヨ・サカ');
  await page.click('#playerSearchBtn');
  await page.waitForTimeout(300);
  const chatBox = await page.locator('#chatMessages').count();
  const compareSelect = await page.locator('#compareSelect option').count();
  console.log('Saka view: chatMessages=' + chatBox + ' compareSelect options=' + compareSelect);

  // 3) use chat suggestion button
  await page.click('.chat-suggest-btn >> text=弱点は？');
  await page.waitForTimeout(200);
  const chatBubbles = await page.locator('.chat-bubble').count();
  console.log('after chat click: bubbles=' + chatBubbles);

  // 4) comparison
  await page.selectOption('#compareSelect', { value: 'ronaldo' });
  await page.waitForTimeout(200);
  const compareRows = await page.locator('.compare-attr-row').count();
  console.log('comparison rows=' + compareRows);

  // 5) beginner mode toggle
  await page.click('#beginnerModeToggle');
  await page.waitForTimeout(200);
  const toggleText = await page.locator('#beginnerModeToggle').textContent();
  console.log('beginner toggle text=' + toggleText);

  // 6) switch to match analysis AI tab and analyze bayern-arsenal
  await page.click('#modeSwitch button[data-mode="match"]');
  await page.waitForTimeout(200);
  const matchRows = await page.locator('.match-row').count();
  console.log('match rows=' + matchRows);
  await page.click('.match-analyze-btn >> nth=0');
  await page.waitForTimeout(500);
  const scoreText = await page.locator('#matchAnalysisWrap').innerText();
  console.log('match analysis snippet=' + scoreText.slice(0, 200).replace(/\n/g, ' | '));

  // 7) position/country filters on player tab
  await page.click('#modeSwitch button[data-mode="player"]');
  await page.waitForTimeout(200);
  await page.selectOption('#posFilter', 'GK');
  await page.waitForTimeout(200);
  const gkChips = await page.locator('#playerChips .chip').count();
  console.log('GK-filtered chip count=' + gkChips);

  console.log('CONSOLE_ERRORS_COUNT=' + consoleErrors.length);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 15).join('\n---\n'));

  await page.screenshot({ path: '/tmp/soccer-analysis-ai/pw_saka.png', fullPage: false });
  await page.click('#modeSwitch button[data-mode="match"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/soccer-analysis-ai/pw_match.png', fullPage: false });

  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
