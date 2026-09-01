/**
 * scripts/pw_v74_check.js — v74のブラウザ実表示検証(自己完結)。
 *   ① 未登録選手(推定ダミー)には能力値・診断・総評などを表示しない
 *   ② 登録選手のシミュレーション区画(直近5試合の調子/コンディション/能力推移/得点パターン)が消えている
 *   ③ 実データパネルは残り、取得できない場合も正直な文言を出す
 *   ④ AI考察の待ち時間が75秒に延長されている(15秒打ち切り=毎回失敗、の修正)
 * 前提: python3 -m http.server 8787 がリポジトリ直下で起動していること。
 */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const results = [];
  const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + detail : ""}`); };

  const page = await browser.newPage();
  await page.addInitScript(() => { try { localStorage.setItem("appLang", "ja"); localStorage.setItem("duelMode", "0"); } catch (e) {} });
  await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false }) }));
  await page.goto("http://localhost:8787/", { waitUntil: "load" });
  await page.waitForTimeout(1200);

  // ---- ④ タイムアウト定数 ----
  const t = await page.evaluate(() => (typeof DISCUSS_TIMEOUT_MS !== "undefined" ? DISCUSS_TIMEOUT_MS : null));
  ck("④ AI考察の待ち時間が75秒(旧15秒)", t === 75000, `DISCUSS_TIMEOUT_MS=${t}`);

  // ---- 登録選手カードを直接描画して検証 ----
  const reg = await page.evaluate(() => {
    const key = Object.keys(PLAYERS)[0];
    renderPlayerCard(PLAYERS[key], "standard");
    const txt = document.getElementById("playerCardWrap").textContent || "";
    return { key, txt: txt.slice(0, 20000) };
  });
  ck("② 登録選手: 能力値・プレースタイル・診断は従来どおり出る",
    /能力値/.test(reg.txt) && /プレースタイル/.test(reg.txt) && /AI総合評価/.test(reg.txt), reg.txt.slice(0, 200));
  ck("② 登録選手: 「直近5試合の調子(シミュレーション)」が消えている", !/直近5試合の調子/.test(reg.txt), "");
  ck("② 登録選手: 「現在のコンディション(シミュレーション)」が消えている", !/現在のコンディション/.test(reg.txt), "");
  ck("② 登録選手: 「能力推移(…シミュレーション)」が消えている", !/能力推移/.test(reg.txt), "");
  ck("③ 実データカード(今シーズンの実データ)は残っている", /今シーズンの実データ/.test(reg.txt), "");
  ck("③ 取得できない場合の正直な文言が出る(APIスタブ環境)",
    /実データを確認中|取得できませんでした/.test(reg.txt), reg.txt.slice(-300));

  // ---- 未登録(フォールバック)選手カード ----
  const fb = await page.evaluate(() => {
    const p = buildFallbackPlayer("Unknown Test Player");
    renderPlayerCard(p, "standard");
    const txt = document.getElementById("playerCardWrap").textContent || "";
    return txt.slice(0, 20000);
  });
  ck("① 未登録選手: 能力値セクションを出さない", !/📊 能力値|能力値\n/.test(fb) && !/AI総合評価/.test(fb), fb.slice(0, 260));
  ck("① 未登録選手: プレースタイル診断・スカウト評価を出さない", !/AIプレースタイル診断 & スカウト評価/.test(fb) && !/即戦力/.test(fb), "");
  ck("① 未登録選手: 総評・長所/改善点・適性・比較・簡易チャットも出さない",
    !/AI総評/.test(fb) && !/長所/.test(fb) && !/適性/.test(fb) && !/他の選手と比較/.test(fb) && !/この選手についてAIに質問/.test(fb), "");
  ck("① 未登録選手: 「推定表示は行いません」の説明が出る", /推定(の能力値|表示)は(表示しません|行いません)/.test(fb) || /推定表示は行いません/.test(fb), fb.slice(0, 400));
  ck("③ 未登録選手にも実データカードは出る(実データだけは探しに行く)", /今シーズンの実データ/.test(fb), "");

  await browser.close();
  const okCount = results.filter(([, v]) => v).length;
  const ngCount = results.length - okCount;
  console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
  process.exit(ngCount ? 1 : 0);
})();
