/**
 * scripts/pw_v79_check.js — v79(案5会話の文脈記憶)のブラウザ実挙動検証。
 *   実際のヒーローチャットで2問続けて質問し、2問目のリクエストに
 *   ①直前の往復(history)が載ること ②「彼」の対象が引き継がれること を確認する。
 * 前提: python3 -m http.server 8787 がリポジトリ直下で起動していること。
 */
"use strict";
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const results = [];
  const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + String(detail).slice(0, 400) : ""}`); };

  const page = await browser.newPage();
  await page.addInitScript(() => { try { localStorage.setItem("appLang", "ja"); localStorage.setItem("duelMode", "0"); } catch (e) {} });

  const discussBodies = [];
  await page.route("**/api/**", (r) => {
    const req = r.request();
    if (req.url().includes("/api/discuss") && req.method() === "POST") {
      try { discussBodies.push(JSON.parse(req.postData() || "{}")); } catch (e) { discussBodies.push({ parseError: true }); }
      return r.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ok: true, facts: ["テスト根拠1"], stats: {},
          generalView: "一般論テスト", aiOpinion: "テスト意見", counterArgument: "反対意見テスト",
          finalConclusion: "テスト結論: 得点力が武器。", futureOutlook: "今後テスト", mostImportantOpinion: "最重要テスト",
          confidence: { stars: 3, reasonJa: "テスト" }, followUpQuestions: [],
          lang: "ja", meta: { parsedOk: true, llmModel: "claude-test", historyTurns: 0 },
        }),
      });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false }) });
  });

  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.waitForTimeout(1200);

  // 1問目: 登録選手名を含む「どんな選手?」— これはルールベースの即答経路で
  // 処理される(discussは呼ばれない)のが正しい仕様。v79はこの即答も記憶に残す。
  const playerName = await page.evaluate(() => {
    const p = PLAYERS[Object.keys(PLAYERS)[0]];
    return p.name || Object.keys(PLAYERS)[0];
  });
  await page.fill("#heroChatInput", `${playerName}はどんな選手？`);
  await page.click("#heroChatBtn");
  await page.waitForTimeout(1500);
  ck("1問目(登録選手の定番質問)は即答経路で処理される(discuss呼び出しゼロ)", discussBodies.length === 0, `count=${discussBodies.length}`);

  // 2問目: 代名詞だけの続きの質問 → AI考察へ。即答だった1問目の内容が文脈として載るべき
  await page.fill("#heroChatInput", "彼の弱点は？");
  await page.click("#heroChatBtn");
  await page.waitForTimeout(1500);

  const b2 = discussBodies[discussBodies.length - 1] || {};
  ck("2問目に、即答だった1問目の往復(history)が載る",
    Array.isArray(b2.history) && b2.history.length === 1
    && b2.history[0].q.includes(playerName) && b2.history[0].a.length > 10, JSON.stringify(b2.history).slice(0, 300));
  ck("2問目で「彼」の対象(subject)が直前から引き継がれる",
    !!(b2.subject && b2.subject.type), JSON.stringify(b2.subject));
  ck("2問目の質問文はそのまま送られる", b2.question === "彼の弱点は？", b2.question);

  // 3問目: AI考察→AI考察の連鎖でも履歴が積み上がる(2問目のAI回答の要旨が入る)
  await page.fill("#heroChatInput", "その選手の今後はどう思う？");
  await page.click("#heroChatBtn");
  await page.waitForTimeout(1500);
  const b3 = discussBodies[discussBodies.length - 1] || {};
  ck("3問目には2往復ぶんの履歴が載り、直前のAI回答の要旨(結論)を含む",
    Array.isArray(b3.history) && b3.history.length === 2 && /テスト結論/.test(b3.history[1].a), JSON.stringify(b3.history).slice(0, 300));

  // 回答の描画も従来どおり成立している(文脈機能が表示を壊していない)
  const chatTxt = await page.evaluate(() => document.getElementById("heroChatMessages").textContent || "");
  ck("回答の描画は従来どおり(意見・結論・生成モデル行)",
    /テスト意見/.test(chatTxt) && /テスト結論/.test(chatTxt) && /claude-test/.test(chatTxt), chatTxt.slice(0, 200));

  await browser.close();
  const okCount = results.filter(([, v]) => v).length;
  const ngCount = results.length - okCount;
  console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
  process.exit(ngCount ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
