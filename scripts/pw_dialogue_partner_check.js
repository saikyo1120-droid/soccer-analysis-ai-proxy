// Playwright regression check for the "AI対話パートナー" (dialogue partner) feature:
// confirms the dialogue-extra block (reflect question / alternative perspective /
// follow-up chips) actually renders in a real browser for both the hero chat and the
// per-player chat, that clicking a follow-up chip continues the conversation, and that
// switching to beginner level omits the "別の視点" (perspective) line as designed.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.waitForSelector("#heroAiChat", { state: "attached", timeout: 15000 });

  // chat history accumulates every turn, so a page-wide element count would count
  // earlier turns too. These helpers scope checks to only the LATEST ai bubble.
  async function lastAiBubbleHtml(containerId) {
    return page.evaluate((id) => {
      const nodes = document.querySelectorAll(`#${id} .chat-msg.ai .chat-bubble`);
      const last = nodes[nodes.length - 1];
      return last ? last.innerHTML : "";
    }, containerId);
  }

  // ---- hero chat: ask a player question (standard level is default-ish; force it) ----
  await page.click('#levelSwitch button[data-level="standard"]');
  await page.waitForTimeout(100);
  await page.fill("#heroChatInput", "久保建英はどんな選手？");
  await page.click("#heroChatBtn");
  await page.waitForTimeout(400);

  const heroBubble1 = await lastAiBubbleHtml("heroChatMessages");
  const heroExtraCount1 = heroBubble1.includes("dialogue-extra") ? 1 : 0;
  const heroReflectText1 = await page.locator("#heroChatMessages .dialogue-reflect").last().innerText().catch(() => "");
  const heroPerspectiveCount1 = heroBubble1.includes("dialogue-perspective") ? 1 : 0;
  const heroChipCount1 = await page.locator("#heroChatMessages .chat-followup-btn").count();
  const heroMsgCountBeforeChip = await page.locator("#heroChatMessages .chat-msg").count();

  // click a follow-up chip and confirm the conversation continues (message count grows)
  if (heroChipCount1 > 0) {
    await page.locator("#heroChatMessages .chat-followup-btn").first().click();
    await page.waitForTimeout(400);
  }
  const heroMsgCountAfterChip = await page.locator("#heroChatMessages .chat-msg").count();

  // ---- hero chat: match-topic question should surface the user's literal example follow-ups ----
  await page.fill("#heroChatInput", "今日見るべき試合は？");
  await page.click("#heroChatBtn");
  await page.waitForTimeout(400);
  const heroLastText = await page.evaluate(() => document.getElementById("heroChatMessages").innerText);

  // ---- beginner level: perspective line should be omitted ----
  await page.click('#levelSwitch button[data-level="beginner"]');
  await page.waitForTimeout(100);
  await page.fill("#heroChatInput", "メッシはどんな選手？");
  await page.click("#heroChatBtn");
  await page.waitForTimeout(400);
  const heroBubbleBeginner = await lastAiBubbleHtml("heroChatMessages");
  const heroPerspectiveCountBeginner = heroBubbleBeginner.includes("dialogue-perspective") ? 1 : 0;
  const heroExtraCountBeginner = heroBubbleBeginner.includes("dialogue-extra") ? 1 : 0;

  // ---- per-player chat: open a player card and ask a question directly ----
  // (the chat card lives inside the collapsible "もっと見る" section, same as pw_card_collapse_check.js)
  await page.click('#levelSwitch button[data-level="standard"]');
  await page.waitForTimeout(100);
  await page.click('#modeSwitch button[data-mode="player"]');
  await page.fill("#playerSearchInput", "メッシ");
  await page.click("#playerSearchBtn");
  await page.waitForTimeout(300);
  await page.click("#moreDetailsToggleBtn");
  await page.waitForTimeout(200);
  await page.fill("#chatInput", "弱点は？");
  await page.click("#chatSendBtn");
  await page.waitForTimeout(400);
  const cardExtraCount = await page.locator("#chatMessages .dialogue-extra").count();
  const cardChipCount = await page.locator("#chatMessages .chat-followup-btn").count();
  const cardMsgCountBefore = await page.locator("#chatMessages .chat-msg").count();
  if (cardChipCount > 0) {
    await page.locator("#chatMessages .chat-followup-btn").first().click();
    await page.waitForTimeout(400);
  }
  const cardMsgCountAfter = await page.locator("#chatMessages .chat-msg").count();

  await browser.close();
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_|Load failed|Failed to fetch/.test(e));
  const checks = [
    ["hero chat (standard): dialogue-extra block rendered", heroExtraCount1 > 0],
    ["hero chat: reflect question text is non-empty", heroReflectText1.length > 0],
    ["hero chat (standard): perspective line present", heroPerspectiveCount1 > 0],
    ["hero chat: follow-up chips rendered", heroChipCount1 > 0],
    ["hero chat: clicking a follow-up chip continues the conversation", heroMsgCountAfterChip > heroMsgCountBeforeChip],
    ["hero chat (match topic): includes the '5バック' scenario follow-up", heroLastText.includes("5バック")],
    ["hero chat (match topic): includes the 'most important player' follow-up", heroLastText.includes("一番重要な選手")],
    ["hero chat (beginner): dialogue-extra still rendered (reflect+chips)", heroExtraCountBeginner > 0],
    ["hero chat (beginner): perspective line OMITTED", heroPerspectiveCountBeginner === 0],
    ["per-player chat: dialogue-extra block rendered", cardExtraCount > 0],
    ["per-player chat: follow-up chips rendered", cardChipCount > 0],
    ["per-player chat: clicking a follow-up chip continues the conversation", cardMsgCountAfter > cardMsgCountBefore],
    ["no real JS errors", realErrors.length === 0],
  ];
  checks.forEach(([label, ok]) => console.log(`  [${ok ? "OK" : "FAIL"}] ${label}`));
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "Dialogue partner PASSED." : "FAIL");
  process.exit(ok ? 0 : 1);
})();
