const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.waitForSelector("#heroAiChat", { state: "attached", timeout: 15000 });

  // 2026年8月・第5次監査での修正:
  //   以前は固定で400ms待っていたが、その質問の種類を初めて扱うときは
  //   実測で約950msかかることがあり(2回目以降は約180ms)、
  //   本番のコードは正しく動いているのにテストだけが時々失敗していた。
  //   固定待ちをやめ、「返信が実際に増えるまで」待つ。
  async function ask(q, expect) {
    const before = await page.locator("#heroChatMessages .chat-msg").count();
    await page.fill("#heroChatInput", q);
    await page.click("#heroChatBtn");
    // 返信(利用者の発言+AIの返信=2件)が増えるまで最大8秒待つ
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(100);
      const now = await page.locator("#heroChatMessages .chat-msg").count();
      if (now >= before + 2) break;
    }
    // 議論モードの返信は「考え中」の吹き出しを先に出し、本文を後から差し替える。
    // 期待する内容が指定されていれば、それが現れるまでさらに待つ
    // (固定待ちだと、初回だけ約950msかかる経路で時々失敗していたため)。
    if (expect) {
      for (let i = 0; i < 80; i++) {
        const t = await page.evaluate(() => document.getElementById("heroChatMessages").innerText);
        if (expect.every((re) => re.test(t))) break;
        await page.waitForTimeout(100);
      }
    }
    await page.waitForTimeout(150); // 描画の完了を待つ
    return page.evaluate(() => document.getElementById("heroChatMessages").innerText);
  }

  const t1 = await ask("久保建英はどんな選手？", [/久保建英/]);
  const playerModeActive1 = await page.evaluate(() => document.getElementById("playerSection").style.display !== "none");
  const cardText1 = await page.evaluate(() => document.getElementById("playerCardWrap").innerText);
  // Stage C: a bare "なぜ" is now (deliberately, per spec) a discussion-mode
  // trigger, which routes through the new async RAG+LLM /api/discuss flow
  // instead of this synchronous keyword path — that combination is covered by
  // its own dedicated pw_discuss_mode_check.js. Use a phrasing with no trigger
  // words here so this test keeps exercising the plain rule-based club-answer path.
  const t2 = await ask("レアルの登録選手は？", [/レアル/, /評価/]);
  const t3 = await ask("今日見るべき試合は？");
  // Stage B: heroAskAI() triggers renderMatchAnalysis() without awaiting it (fire-
  // and-forget, same as before), but that function now itself awaits
  // /api/predict-match first (falling back to identical local computation,
  // PREDICT_MATCH_TIMEOUT_MS=1500ms in index.html) before filling in this panel —
  // so give it comfortably more time than ask()'s normal 400ms before reading it.
  await page.waitForTimeout(1700);
  const matchModeActive = await page.evaluate(() => document.getElementById("matchSection").style.display !== "none");
  const matchAnalysisText = await page.evaluate(() => document.getElementById("matchAnalysisWrap").innerText);
  const t4 = await ask("メッシとロナウドどっち？");
  const playerModeActive2 = await page.evaluate(() => document.getElementById("playerSection").style.display !== "none");
  await page.waitForTimeout(200);
  const compareVisible = await page.locator("#compareResultWrap").isVisible();
  const compareText = await page.evaluate(() => document.getElementById("compareResultWrap").innerText);

  // typed-question path still works alongside the new tabbed suggestion chips
  await page.click('#heroQuestionTabs button[data-cat="trending"]');
  await page.waitForTimeout(150);
  await page.click('#heroSuggestRow .hero-suggest-btn[data-q="久保建英はどんな選手？"]');
  await page.waitForTimeout(300);
  const chipHistoryCount = await page.locator("#heroChatMessages .chat-msg").count();

  await browser.close();
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_|Load failed|Failed to fetch/.test(e));
  const checks = [
    ["single-player switches to player mode", playerModeActive1 === true],
    ["single-player card shows Kubo", cardText1.includes("久保建英")],
    ["hero reply 1 mentions player", t1.includes("久保建英")],
    ["club answer mentions Real Madrid", /レアル/.test(t2) && /評価/.test(t2)],
    ["match-recommendation switches to match mode", matchModeActive === true],
    ["match analysis rendered", matchAnalysisText.length > 30],
    ["comparison switches to player mode", playerModeActive2 === true],
    ["comparison panel VISIBLE", compareVisible === true],
    ["comparison rendered", compareText.includes("メッシ") && compareText.includes("ロナウド")],
    ["comparison includes AI recommendation", compareText.includes("AIのおすすめ")],
    ["suggested chip (tabbed) still adds to hero chat history", chipHistoryCount >= 8],
    ["no real JS errors", realErrors.length === 0],
  ];
  checks.forEach(([label, ok]) => console.log(`  [${ok ? "OK" : "FAIL"}] ${label}`));
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "Hero chat PASSED." : "FAIL");
  process.exit(ok ? 0 : 1);
})();
