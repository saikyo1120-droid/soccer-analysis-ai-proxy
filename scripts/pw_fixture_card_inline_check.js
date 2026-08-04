/**
 * 2026年8月・優先順位⑩のE2Eチェック。
 *
 * ご指示:
 *   「今日の試合カードはAIマッチ分析と同じ見やすいカードUIに統一してください。
 *     全項目を表示するだけでなく、『AIが今回最も重要だと判断した要因』を最初に
 *     表示してください。表示速度を維持するため、分析結果は事前生成・キャッシュを
 *     活用し、毎回LLMを呼ばない設計にしてください。」
 *
 * 実ブラウザで次を検証する:
 *   1. 試合カードの「中」に分析が展開されること(画面下部の別領域ではない)
 *   2. 最重要要因が、分析本文より「先」に表示されること
 *   3. もう一度押すと閉じること
 *   4. 開き直しても通信が発生しないこと(キャッシュが効いていること)
 */
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const pageServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, rel));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": rel.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    res.end(data);
  });
});

const FIXTURES_PAYLOAD = {
  found: true,
  fixtures: [{
    id: 4242, date: new Date(Date.now() + 3600e3).toISOString(), status: "NS",
    league: "Premier League", country: "England", venue: "Test Stadium",
    home: { name: "Arsenal" }, away: { name: "Chelsea" },
    score: { home: null, away: null },
  }],
};

const ANALYSIS_PAYLOAD = {
  found: true, phase: "upcoming",
  fixture: { id: 4242, home: { name: "Arsenal" }, away: { name: "Chelsea" }, date: new Date().toISOString(), league: "Premier League" },
  prediction: {
    mostImportantFactor: "怪我人",
    keyFactors: [
      { key: "injuryDiff", labelJa: "怪我人", stars: 5, starsDisplay: "★★★★★" },
      { key: "formDiff", labelJa: "直近フォーム", stars: 2, starsDisplay: "★★" },
    ],
  },
};

(async () => {
  await new Promise((resolve) => pageServer.listen(0, resolve));
  const pagePort = pageServer.address().port;
  let failures = 0;
  const fail = (m) => { console.error("FAIL: " + m); failures++; };
  const ok = (c, m) => { if (c) console.log("  [OK] " + m); else fail(m); };

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  let analysisRequests = 0;
  // 注意: Playwrightのrouteは「後から登録したものが優先」される。
  // そのため、包括的なパターンを先に登録し、個別パターンを後から登録する。
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ found: false }) }));
  await page.route("**/fixtures/today*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURES_PAYLOAD) }));
  await page.route("**/fixtures/analysis*", (route) => {
    analysisRequests++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYSIS_PAYLOAD) });
  });

  await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
  await page.waitForSelector('[data-fixture-card="4242"]', { state: "attached", timeout: 15000 });

  // ---- 1. カード構造になっているか ----
  ok(await page.locator('[data-fixture-card="4242"]').count() === 1, "試合がカード要素として描画される");
  ok(await page.locator('[data-fixture-card="4242"] .fixture-analysis-slot').count() === 1,
    "カードの中に分析を展開するスロットがある(下部の別領域ではない)");
  const slotHiddenBefore = await page.locator("#fixtureAnalysis-4242").evaluate((el) => el.style.display === "none");
  ok(slotHiddenBefore, "最初はスロットが閉じている");

  const btn = page.locator('[data-fixture-card="4242"] .real-fixture-analyze-btn');
  ok((await btn.textContent()).includes("AI分析を見る"), "未終了の試合は「AI分析を見る」ボタンになる");

  // ---- 2. クリックでカード内に展開されるか ----
  await btn.click();
  await page.waitForFunction(() => {
    const s = document.getElementById("fixtureAnalysis-4242");
    return s && s.style.display !== "none" && s.dataset.loaded === "1";
  }, { timeout: 15000 });

  ok(await page.locator('[data-fixture-card="4242"].is-expanded').count() === 1,
    "展開中はカードに is-expanded が付き、見た目が切り替わる");
  const slotText = await page.locator("#fixtureAnalysis-4242").innerText();
  ok(slotText.includes("AIが今回もっとも重要だと判断した要因"), "最重要要因の見出しがカード内に出る");
  ok(slotText.includes("怪我人"), "最重要要因の内容が出る, got: " + slotText.slice(0, 120));

  // ---- 3. 最重要要因が「本文より先」に来ているか ----
  const bannerIsFirst = await page.evaluate(() => {
    const slot = document.getElementById("fixtureAnalysis-4242");
    const text = slot.innerText;
    const bannerPos = text.indexOf("AIが今回もっとも重要だと判断した要因");
    // 分析本文には必ずチーム名が現れる。バナーがそれより前にあることを確認する。
    const bodyPos = text.indexOf("Arsenal", bannerPos + 1);
    return bannerPos >= 0 && (bodyPos === -1 || bannerPos < bodyPos);
  });
  ok(bannerIsFirst, "最重要要因が分析本文より先に表示される");

  // ---- 4. 開閉と、キャッシュによる通信抑制 ----
  const requestsAfterFirstOpen = analysisRequests;
  ok(requestsAfterFirstOpen === 1, "初回は1回だけ分析を取得する, got " + requestsAfterFirstOpen);

  await btn.click(); // 閉じる
  await page.waitForFunction(() => document.getElementById("fixtureAnalysis-4242").style.display === "none", { timeout: 5000 });
  ok(await page.locator('[data-fixture-card="4242"].is-expanded').count() === 0, "閉じると is-expanded が外れる");
  ok((await btn.textContent()).includes("AI分析を見る"), "閉じるとボタン文言が元に戻る");

  await btn.click(); // 開き直す
  await page.waitForFunction(() => document.getElementById("fixtureAnalysis-4242").style.display !== "none", { timeout: 5000 });
  ok(analysisRequests === requestsAfterFirstOpen,
    `開き直しても再取得しない(キャッシュが効いている), got ${analysisRequests} requests`);
  const reopenedText = await page.locator("#fixtureAnalysis-4242").innerText();
  ok(reopenedText.includes("怪我人"), "開き直しても内容が保持されている");

  const realErrors = errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e));
  ok(realErrors.length === 0, "JSエラーが出ない, got: " + JSON.stringify(realErrors));

  await browser.close();
  pageServer.close();
  console.log(failures === 0 ? "\nFixture-card inline (優先順位⑩) E2E PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
