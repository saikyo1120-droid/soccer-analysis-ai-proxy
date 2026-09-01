/**
 * scripts/pw_v76_check.js — v76のブラウザ実表示検証(自己完結)。
 *   還元B: 「今日のAI予想」カードに実績への導線(外れも含む全採点記録=反省タブ)が
 *          出て、タップで反省タブへ切り替わり、実測の的中率が文言に差し込まれる
 *   還元C: AI会話の回答末尾に「生成モデル名+根拠件数」の開示行が出る
 *          (metaを持たない旧応答では何も出ない=劣化なし)
 *   i18n : 新規文言3種が英語へ翻訳される(長い型が短い型に飲まれない)
 * 前提: python3 -m http.server 8787 がリポジトリ直下で起動していること。
 */
const { chromium } = require("playwright");

const PRED_BODY = {
  found: true,
  noteJa: "テスト注記",
  bestPick: null,
  predictions: [{
    fixtureId: 101, league: "テストリーグ", kickoff: new Date().toISOString(), status: "NS",
    home: { name: "チームA" }, away: { name: "チームB" },
    predictedWinner: "home", probs: { homeWinPct: 50, drawPct: 30, awayWinPct: 20 },
    weightsVersion: 12, topFactorJa: "得点力・失点率",
  }],
};
const REFL_BODY = {
  officialSummary: { n: 170, hits: 81, hitRatePct: 47.6, scoreline: null, noteJa: "" },
  learnedSummary: { learned: { n: 170, hits: 81, hitRatePct: 47.6 }, unlearned: { n: 50, hits: 24, hitRatePct: 48.0 }, noteJa: "" },
  resolvedCount: 220, hitCount: 105, missCount: 115, items: [], honestyJa: "",
};

async function newAppPage(browser, lang) {
  const page = await browser.newPage();
  await page.addInitScript((l) => { try { localStorage.setItem("appLang", l); localStorage.setItem("duelMode", "0"); } catch (e) {} }, lang);
  await page.route("**/api/**", (r) => {
    const u = r.request().url();
    if (u.includes("/api/predictions/today")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PRED_BODY) });
    if (u.includes("/api/reflections")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REFL_BODY) });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false }) });
  });
  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.waitForTimeout(1500);
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const results = [];
  const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + detail : ""}`); };

  const page = await newAppPage(browser, "ja");

  // ---- 還元B: 導線の存在と実測値の差し込み ----
  const linkInfo = await page.evaluate(() => {
    const a = document.getElementById("predsToReflectionsLink");
    return a ? { text: a.textContent } : null;
  });
  ck("B: 予想カードに実績への導線リンクがある", !!linkInfo, "predsToReflectionsLink が見つからない");
  ck("B: リンク文言に実測の的中率 47.6%(81/170件)が差し込まれている",
    !!linkInfo && /47\.6%/.test(linkInfo.text) && /81\/170/.test(linkInfo.text), linkInfo && linkInfo.text);
  ck("B: 「外れも含む」の明示がある", !!linkInfo && /外れも含む/.test(linkInfo.text), linkInfo && linkInfo.text);

  // 差し込み関数を単体でも検証(読込順に依存しないことの担保)
  const applied = await page.evaluate(() => {
    reflHeadlineForHero = { hitRatePct: 55.4, hits: 56, n: 101 };
    applyReflHeadlineToHeroLink();
    return document.getElementById("predsToReflectionsLink").textContent;
  });
  ck("B: applyReflHeadlineToHeroLink 単体で文言が更新される", /55\.4%/.test(applied) && /56\/101/.test(applied), applied);

  // タップで反省タブへ切り替わる
  await page.click("#predsToReflectionsLink");
  await page.waitForTimeout(300);
  const tabState = await page.evaluate(() => ({
    refl: document.getElementById("reflectionsSection").style.display,
    match: document.getElementById("matchSection").style.display,
    activeBtn: (document.querySelector("#modeSwitch button.active") || {}).dataset ? document.querySelector("#modeSwitch button.active").dataset.mode : null,
  }));
  ck("B: リンクのタップで反省タブが開く", tabState.refl === "block" && tabState.match === "none" && tabState.activeBtn === "reflections",
    JSON.stringify(tabState));

  // ---- 還元C: 生成情報の開示行 ----
  const withMeta = await page.evaluate(() => renderDiscussReplyHtml({
    ok: true, aiOpinion: "テスト意見", facts: ["根拠1", "根拠2"],
    confidence: { stars: 3, reasonJa: "テスト" },
    meta: { parsedOk: true, llmModel: "claude-test-model-1", llmProvider: "anthropic" },
  }).extras);
  ck("C: モデル名の開示行が出る", /生成モデル/.test(withMeta) && /claude-test-model-1/.test(withMeta), withMeta.slice(0, 300));
  ck("C: 根拠件数(2件)が併記される", /実データ 2件/.test(withMeta), withMeta.slice(0, 300));

  const noFacts = await page.evaluate(() => renderDiscussReplyHtml({
    ok: true, aiOpinion: "テスト", facts: [],
    confidence: { stars: 2, reasonJa: "テスト" },
    meta: { parsedOk: true, llmModel: "claude-test-model-1" },
  }).extras);
  ck("C: 根拠0件のときは件数・参照先を書かない(モデル名のみ)",
    /生成モデル: claude-test-model-1/.test(noFacts) && !/実データ 0件/.test(noFacts) && !/根拠にした事実」に全て記載/.test(noFacts), noFacts.slice(0, 300));

  const noMeta = await page.evaluate(() => renderDiscussReplyHtml({
    ok: true, aiOpinion: "テスト", facts: ["a"],
    confidence: { stars: 2, reasonJa: "テスト" },
  }).extras);
  ck("C: metaが無い旧応答では開示行を出さない(劣化なし)", !/生成モデル/.test(noMeta) && !/🏷️/.test(noMeta), noMeta.slice(0, 200));

  // ---- i18n: 新規文言の英語翻訳(別ページで英語起動) ----
  const en = await newAppPage(browser, "en");
  const tOut = await en.evaluate(() => ({
    staticLink: window.t("🙈 これまでの的中実績(外れも含む全試合の採点記録)を見る"),
    dynamicLink: window.t("🙈 実測の的中率 47.6%(81/170件)— 外れも含む全試合の採点記録を見る"),
    genLong: window.t("🏷️ 生成モデル: claude-x ・ 根拠にした実データ 5件(上の「📊 根拠にした事実」に全て記載)"),
    genShort: window.t("🏷️ 生成モデル: claude-x"),
  }));
  ck("i18n: 導線(静的文言)が英語になる", /track record/.test(tOut.staticLink) && /misses included/.test(tOut.staticLink), tOut.staticLink);
  ck("i18n: 導線(実測値入り)が英語になる", /Measured accuracy 47\.6%/.test(tOut.dynamicLink) && /81\/170/.test(tOut.dynamicLink), tOut.dynamicLink);
  ck("i18n: 生成モデル行(長い型)が正しく英語になる(短い型に飲まれない)",
    /Model: claude-x/.test(tOut.genLong) && /5 real-data facts used/.test(tOut.genLong), tOut.genLong);
  ck("i18n: 生成モデル行(短い型)も英語になる", tOut.genShort === "🏷️ Model: claude-x", tOut.genShort);

  // ---- 既存機能の無事確認(予想カード本体が従来どおり描けている) ----
  const heroTxt = await page.evaluate(() => document.getElementById("todayPredictionsBody").textContent || "");
  ck("既存: 予想カード本体は従来どおり描画されている(AIの予想・根拠行)",
    /AIの予想/.test(heroTxt) && /根拠.最重要要素./.test(heroTxt) && /チームA/.test(heroTxt), heroTxt.slice(0, 300));

  await browser.close();
  const okCount = results.filter(([, v]) => v).length;
  const ngCount = results.length - okCount;
  console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
  process.exit(ngCount ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
