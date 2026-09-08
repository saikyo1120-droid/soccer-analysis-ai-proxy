/**
 * scripts/pw_i18n_check.js — 多言語の「日本語漏れゼロ」実表示検査(v82新設・v83拡張)。
 *   EN/ZH/ES の各言語で全タブを実際に開き、見えているテキストノードに
 *   日本語が残っていないかを機械検査する(ZHは漢字を共有するため仮名のみ検査)。
 *
 * v83(2026年9月8日)の拡張 — 利用者の実機指摘で見つかった検査の盲点をふさぐ:
 *   v82の検査は「APIデータ無し」の描画しか通らず、マイクラブカードや
 *   今日のベスト予想など**実データがあるときだけ描かれる行**が未検査だった。
 *   → 本番APIの応答形をそのまま模した固定データ(下のSTUB)をPlaywrightの
 *     ルート横取りで返し、データ表示行も含めて漏れゼロを検査する。
 *   さらに「データ行が本当に描画されたか」を番兵文字列で確認する
 *   (描画されずに素通りして合格、という偽の合格を防ぐ)。
 *
 * 実行: 事前に `python3 -m http.server 8787` をルートで起動してから
 *       node scripts/pw_i18n_check.js
 * 意図した例外(検査から除外):
 *   ・言語セレクタの「🌐 日本語」「🌐 中文(简体)」(言語名の自己表記)
 *   ・input等の値(データ値は日本語のまま検索に使う設計。表示訳はpick時に適用)
 */
"use strict";
const path = require("path");
const fs = require("fs");

const ROOT = (() => {
  if (fs.existsSync(path.join(__dirname, "..", "server", "server.js"))) return path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(__dirname, "server.js")) && fs.existsSync(path.join(__dirname, "learning"))) return __dirname;
  if (fs.existsSync(path.join(__dirname, "..", "server.js")) && fs.existsSync(path.join(__dirname, "..", "learning"))) return path.resolve(__dirname, "..");
  return path.resolve(__dirname, "..", "..");
})();

/* ================================================================
 * v83: 本番API応答の形をそのまま模した固定データ(テスト専用)。
 *   文言(noteJa等)はserver.js/learningの実リテラルを byte 一致で写した。
 *   クラブ名は「追跡100クラブ(訳語あり)」と「対象外(英名のまま)」の
 *   両方を意図的に混ぜる(実機で漏れたSabah FA型の素通り経路も検査)。
 * ================================================================ */
const STUB = {
  predictionsToday: {
    ok: true, found: true,
    noteJa: "AI自身の予測モデル(実データで毎日学習した重み)による予想です。予想は毎朝の学習時に生成・保存され、試合終了後に必ず答え合わせされて学習に使われます。",
    bestPick: { fixtureId: 9101, reasonJa: "本日のAI予想の中で補正後の勝率が最も高い試合です(51%・最重要要素: 直近フォーム)。" },
    predictions: [
      {
        fixtureId: 9101, kickoff: "2026-09-08T11:30:00Z", status: "FT", resolved: true, correct: true,
        score: { home: 2, away: 1 },
        home: { name: "Manchester United" }, away: { name: "Sabah FA" },
        league: "Friendlies Clubs", official: false, learnedCompetition: false,
        predictedWinner: "home", predictedScoreline: "1-0",
        probs: { homeWinPct: 51, drawPct: 27, awayWinPct: 22 },
        topFactorJa: "直近フォーム", weightsVersion: 12,
        factors: [{ labelJa: "直近フォーム", stars: 3 }, { labelJa: "得点力・失点率", stars: 2 }, { labelJa: "順位・勝点", stars: 1 }],
        similarPastJa: "特徴量(フォーム・得点力・順位・xG・怪我・日程)が似た状況の過去3試合の実結果: ホーム勝ち2・アウェイ勝ち1",
        market: { edgePt: 1.3 }, oddsSource: { kind: "consensus", nBooks: 12 },
        blend: { marketPct: 35, aiPct: 65 }, apifbBlend: { pct: 15 },
        confidence: { displayPct: 51, rawPct: 48, calibrated: true, basisN: 120, gapPt: 3, outOfRange: false },
        scenarios: [{ scoreline: "1-0", pct: 14 }, { scoreline: "2-1", pct: 11 }],
        derived: { bttsPct: 48, over25Pct: 52, homeCleanSheetPct: 30, awayCleanSheetPct: 22 },
        loggedAt: "2026-09-08T04:35:00Z",
      },
      {
        fixtureId: 9102, kickoff: "2026-09-08T19:00:00Z", status: "NS", resolved: false,
        home: { name: "Arsenal" }, away: { name: "Real Madrid" },
        league: "UEFA Champions League", official: true, learnedCompetition: true,
        predictedWinner: "draw", predictedScoreline: "1-1",
        probs: { homeWinPct: 34, drawPct: 36, awayWinPct: 30 },
        topFactorJa: "xG(期待得点)の質", weightsVersion: 12,
        factors: [{ labelJa: "xG(期待得点)の質", stars: 3 }, { labelJa: "怪我人", stars: 2 }],
        similarPastJa: "特徴量(フォーム・得点力・順位・xG・怪我・日程)が似た状況の過去5試合の実結果: ホーム勝ち2・引き分け2・アウェイ勝ち1",
        market: { edgePt: -0.8 }, oddsSource: { kind: "consensus", nBooks: 10 },
        blend: { marketPct: 35, aiPct: 65 },
        confidence: { displayPct: 41, rawPct: 55, calibrated: true, basisN: 88, gapPt: -14, outOfRange: true },
        preKick: {
          confirmed: true, oddsSource: { kind: "consensus", nBooks: 10 },
          blended: { predictedWinner: "home", probsPct: { homeWinPct: 44, drawPct: 31, awayWinPct: 25 }, changedFromMorning: true },
        },
        scenarios: [{ scoreline: "1-1", pct: 13 }],
        derived: { bttsPct: 55, over25Pct: 49, homeCleanSheetPct: 21, awayCleanSheetPct: 18 },
        loggedAt: "2026-09-08T04:35:00Z",
      },
      {
        fixtureId: 9103, kickoff: "2026-09-08T16:00:00Z", status: "NS", resolved: false,
        home: { name: "Leeds United" }, away: { name: "Everton" },
        league: "Premier League", official: true, learnedCompetition: true,
        predictedWinner: "away", predictedScoreline: "0-1",
        probs: { homeWinPct: 28, drawPct: 30, awayWinPct: 42 },
        topFactorJa: "怪我人", weightsVersion: 12,
        loggedAt: "2026-09-08T04:35:00Z",
      },
    ],
  },
  clubSummary: {
    ok: true, available: true, clubEn: "Manchester United", clubJa: "マンチェスター・ユナイテッド",
    nextPrediction: {
      kickoff: "2026-09-09T18:30:00Z", homeEn: "Manchester United", awayEn: "Sabah FA",
      predictedJa: "Manchester United勝利", predictedScoreline: "1-0", official: false,
    },
    condition: {
      standings: { position: 3, points: 12, agoDays: 1 },
      injuries: { count: 2, players: ["L. Martinez", "R. Varane"], agoHours: 5 },
      form: { score: 1.2, agoHours: 5 },
    },
    record: {
      n: 12, hits: 7, hitRatePct: 58.3, official: { hits: 1, n: 2 },
      last: [
        { correct: true, kickoff: "2026-09-06T14:00:00Z", homeEn: "Manchester United", actualScore: "2-1", awayEn: "Leeds United", official: true },
        { correct: false, kickoff: "2026-09-02T18:30:00Z", homeEn: "Arsenal", actualScore: "2-0", awayEn: "Manchester United", official: true },
        { correct: true, kickoff: "2026-08-30T13:00:00Z", homeEn: "Manchester United", actualScore: "1-0", awayEn: "Sabah FA", official: false },
      ],
    },
  },
  reflections: {
    ok: true, available: true, resolvedCount: 297, hitCount: 163, missCount: 134,
    streak: { official: { current: 2, best: 5, windowN: 200, noteJa: "連続的中は保存済みの直近200件の公式戦の実測です。" } },
    officialSummary: {
      n: 256, hits: 141, hitRatePct: 55.1, referenceN: 41,
      noteJa: "公式戦のみの成績です。親善試合・2軍戦は主力を休ませるため予測が難しく、参考扱いとして分けています(予想自体は出し続けています)。",
      scoreline: { n: 240, hits: 11, hitRatePct: 4.6, noteJa: "予想時に保存した「最も可能性の高いスコア」が実スコアと完全一致した割合です。勝敗より桁違いに難しく、世界の強い予測モデルでも10%前後が普通です。" },
    },
    learnedSummary: {
      learned: { n: 195, hits: 107, hitRatePct: 54.9 }, unlearned: { n: 61, hits: 34, hitRatePct: 55.7 },
      noteJa: "AIが過去試合を学習しているのは欧州12大会(9リーグ+CL・EL・ECL)です。それ以外の大会は学習データが無いため、予想は出しますが実力を測る集計とは分けています。",
    },
    items: [
      {
        homeEn: "Arsenal", awayEn: "Manchester United", league: "Premier League", kickoff: "2026-09-02T18:30:00Z",
        predictedJa: "Manchester United勝利", predictedScoreline: "1-2", actualJa: "Arsenal勝利", actualScore: "2-0",
        official: true, learnedCompetition: true,
        reasons: [
          { labelJa: "直近フォームを重視しすぎた", detailJa: "直近フォームの差(1.20)を根拠に予想しましたが、実際の結果(ホームチームの勝利)はそれを裏付けませんでした。" },
          { labelJa: "怪我人を軽視した", detailJa: "怪我人の差(-2.00)は実際の結果(ホームチームの勝利)の方向を示していましたが、モデルはこの要素をまだ十分に学習していませんでした。" },
        ],
      },
      {
        homeEn: "Everton", awayEn: "Leeds United", league: "Friendlies Clubs", kickoff: "2026-08-28T18:30:00Z",
        predictedJa: "引き分け", predictedScoreline: "1-1", actualJa: "Everton勝利", actualScore: "3-1",
        official: false, referenceJa: "親善試合・2軍戦は主力を休ませるため、参考扱いにしています。",
        reasons: [{ labelJa: "ホーム補正が強すぎた", detailJa: "ホームアドバンテージ(基礎値の差+0.35)の影響でホームチーム優位と予想しましたが、実際はホームチームの勝利でした。" }],
      },
    ],
    topReasons: [{ labelJa: "直近フォームを重視しすぎた", count: 12 }, { labelJa: "ホーム補正が強すぎた", count: 9 }],
    honestyJa: "理由は、答え合わせの時点で実測データから機械的に分類したものです。AIが後から言い訳の文章を作っているのではありません。",
  },
  rankings: {
    ok: true, available: true, updatedAt: "2026-09-08T05:00:00Z", matchesUsed: 5321,
    noteJa: "12大会×5シーズン(欧州カップ戦を含む)の実試合(5321試合)から、各クラブの攻撃力と守備力をAIが学習した結果です(Dixon-Coles法・時間減衰つき・毎日更新)。強さ=攻撃力+守備力。順位の↑↓は前週との比較です。主観のランキングではなく、すべて実測データからの機械的な計算で、人手の調整は入っていません。対象は、このデータの中に8試合以上の実績があり、かつ他の対象クラブと十分に対戦しているクラブだけです(数試合だけの記録から地力を断定しないため)。",
    teams: [
      { rank: 1, move: 1, nameJa: "アーセナル", name: "Arsenal", strength: 1.92, att: 2.05, def: 0.87 },
      { rank: 2, move: -1, nameJa: "レアル・マドリード", name: "Real Madrid", strength: 1.88, att: 1.98, def: 0.9 },
      { rank: 3, move: 0, nameJa: "マンチェスター・シティ", name: "Manchester City", strength: 1.8, att: 1.9, def: 0.95 },
    ],
  },
};

/** APIルート横取り: 本番APIのURL(絶対)・相対 /api/ のどちらでも同じ固定データを返す */
async function routeApiStub(ctx) {
  await ctx.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    const reply = (obj, status) => route.fulfill({
      status: status || 200,
      headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
      body: JSON.stringify(obj),
    });
    if (p.endsWith("/api/predictions/today")) return reply(STUB.predictionsToday);
    if (p.endsWith("/api/club/summary")) return reply(STUB.clubSummary);
    if (p.endsWith("/api/reflections")) return reply(STUB.reflections);
    if (p.endsWith("/api/ratings/rankings")) return reply(STUB.rankings);
    return reply({}, 404); // その他はデータ無し経路(v82検査で担保済み)のまま
  });
}

const results = [];
const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + String(detail).slice(0, 400) : ""}`); };

(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const BASE = "http://127.0.0.1:8787/index.html";

  async function walkAllTabs(page) {
    const tabs = await page.$$eval("#modeSwitch button", (bs) => bs.map((b) => b.dataset.mode).filter(Boolean)).catch(() => []);
    for (const mode of tabs) {
      await page.click(`#modeSwitch button[data-mode="${mode}"]`).catch(() => {});
      await page.waitForTimeout(1200);
      await page.$$eval("details:not([open])", (ds) => ds.forEach((d) => { d.open = true; })).catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1500);
  }

  async function scanLeaks(page, lang) {
    return page.evaluate((lg) => {
      const kanaRe = /[ぁ-んァ-ヶ]/;
      const jaRe = /[ぁ-んァ-ヶ一-龥]/;
      const re = lg === "zh" ? kanaRe : jaRe;
      const bad = new Map();
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = w.nextNode())) {
        const p = n.parentElement;
        if (!p) continue;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") continue;
        if (!p.offsetParent && getComputedStyle(p).position !== "fixed") continue;
        const s = (n.nodeValue || "").trim();
        if (!s || !re.test(s)) continue;
        if (s === "🌐 日本語" || s === "🌐 中文(简体)" || s === "日本語" || s === "中文(简体)") continue;
        bad.set(s.slice(0, 120), (bad.get(s.slice(0, 120)) || 0) + 1);
      }
      return [...bad.entries()];
    }, lang);
  }

  // ---- v82: データ無し(サーバー未接続の正直表示)での漏れ検査 ----
  async function collectLeaks(lang) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript((lg) => { try { localStorage.setItem("appLang", lg); } catch (e) {} }, lang);
    let packStatus = null;
    page.on("response", (r) => { if (r.url().includes(`i18n.${lang}.json`)) packStatus = r.status(); });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await walkAllTabs(page);
    const leaks = await scanLeaks(page, lang);
    await ctx.close();
    return { leaks, packStatus };
  }

  // ---- v83: 本番形の実データを返した状態での漏れ検査(利用者指摘の盲点対策) ----
  //   マイクラブ登録済み(Manchester United)+対決モードOFFで、実データ行を全部描かせる。
  async function collectLeaksWithData(lang, opts) {
    const o = opts || {};
    const ctx = await browser.newContext();
    await routeApiStub(ctx);
    const page = await ctx.newPage();
    await page.addInitScript((cfg) => {
      try {
        localStorage.setItem("appLang", cfg.lang);
        localStorage.setItem("myClubEn", "Manchester United");
        if (!cfg.duelOn) localStorage.setItem("duelMode", "0");
      } catch (e) {}
    }, { lang, duelOn: !!o.duelOn });
    let packReqs = 0;
    page.on("request", (r) => { if (r.url().includes("i18n.")) packReqs++; });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await walkAllTabs(page);
    const leaks = await scanLeaks(page, lang);
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    await ctx.close();
    return { leaks, bodyText, packReqs };
  }

  for (const lang of ["en", "zh", "es"]) {
    const { leaks, packStatus } = await collectLeaks(lang);
    ck(`${lang}: 言語パック(i18n.${lang}.json)が読み込まれる`, packStatus === 200, `status=${packStatus}`);
    ck(`${lang}: [データ無し] 表示テキストに日本語${lang === "zh" ? "(仮名)" : ""}が残っていない — 漏れ${leaks.length}種`,
      leaks.length === 0,
      leaks.slice(0, 12).map(([s, c]) => `[×${c}] ${s}`).join(" | "));
    if (leaks.length) {
      fs.writeFileSync(path.join(__dirname, `i18n_leaks_${lang}.json`), JSON.stringify(leaks, null, 1));
      console.log(`    → 全${leaks.length}種を scripts/i18n_leaks_${lang}.json に保存`);
    }
  }

  // ---- v83: 実データあり(マイクラブ・今日の予想・実績・ランキング) ----
  const SENTINELS = {
    en: ["My club", "Sabah FA", "🎯"],
    zh: ["我的俱乐部", "Sabah FA", "🎯"],
    es: ["Mi club", "Sabah FA", "🎯"],
  };
  for (const lang of ["en", "zh", "es"]) {
    const { leaks, bodyText } = await collectLeaksWithData(lang);
    const missing = SENTINELS[lang].filter((s) => !bodyText.includes(s));
    ck(`${lang}: [実データ] マイクラブ/ベスト予想などのデータ行が実際に描画されている`, missing.length === 0,
      `番兵が見つからない: ${missing.join(", ")}`);
    ck(`${lang}: [実データ] 表示テキストに日本語${lang === "zh" ? "(仮名)" : ""}が残っていない — 漏れ${leaks.length}種`,
      leaks.length === 0,
      leaks.slice(0, 12).map(([s, c]) => `[×${c}] ${s}`).join(" | "));
    if (leaks.length) {
      fs.writeFileSync(path.join(__dirname, `i18n_leaks_${lang}_data.json`), JSON.stringify(leaks, null, 1));
      console.log(`    → 全${leaks.length}種を scripts/i18n_leaks_${lang}_data.json に保存`);
    }
  }

  // ---- v83: 対決モードON(本番の既定値)でも漏れゼロ(ENで代表検査) ----
  {
    const { leaks } = await collectLeaksWithData("en", { duelOn: true });
    ck(`en: [実データ・対決モードON] 表示テキストに日本語が残っていない — 漏れ${leaks.length}種`,
      leaks.length === 0,
      leaks.slice(0, 12).map(([s, c]) => `[×${c}] ${s}`).join(" | "));
    if (leaks.length) fs.writeFileSync(path.join(__dirname, "i18n_leaks_en_duel.json"), JSON.stringify(leaks, null, 1));
  }

  // ---- ja: 実データありでも日本語表示は無傷+言語パックを一切読み込まない ----
  {
    const { bodyText, packReqs } = await collectLeaksWithData("ja");
    ck("ja: [実データ] 言語パックを一切読み込まない(日本語利用者への影響ゼロ)", packReqs === 0, `requests=${packReqs}`);
    ck("ja: [実データ] マイクラブの日本語表示が保たれている", bodyText.includes("マイクラブ: マンチェスター・ユナイテッド"), bodyText.slice(0, 120));
  }

  // 日本語表示の無傷確認(データ無し): ja では辞書もパックも一切適用されない
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem("appLang", "ja"); } catch (e) {} });
    const reqs = [];
    page.on("request", (r) => { if (r.url().includes("i18n.")) reqs.push(r.url()); });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const heroJa = await page.$eval("h1, .hero, header", (el) => document.body.innerText.slice(0, 400)).catch(() => "");
    ck("ja: 言語パックを一切読み込まない(日本語利用者への影響ゼロ)", reqs.length === 0, JSON.stringify(reqs));
    ck("ja: 日本語表示が保たれている", /サッカー分析AI|予想/.test(heroJa), heroJa.slice(0, 80));
    await ctx.close();
  }

  await browser.close();
  const okCount = results.filter(([, v]) => v).length;
  const ngCount = results.length - okCount;
  console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
  process.exit(ngCount ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
