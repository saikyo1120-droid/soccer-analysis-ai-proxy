"use strict";
/** v101(2026年11月9日): 「★2〜★5 の実装前の見立て」で決めた最初の1本=計測の物差し+確率の較正+不具合A〜D のテスト。
 *
 *  本番実測(11/8〜11/9)で分かったこと:
 *   ① 直近30日の 772 件で、自信 33〜45% の予想は実際には 52.7% 当たり、70% 以上は 74%(ECE 6.8%)。
 *      確率の歪みは的中率に影響しないが、確率の質(技能スコア)を下げる → ★4 温度較正(関門つき)。
 *   ② 無オッズ(自前モデル単独)の予想が 14.9% あるのに、その群の的中率が未計測だった → byOdds。
 *   ③ 引き分けは実際 21.3% なのに予想は 1.0%。リーグ別の「予想した引き分け確率 vs 実際」が無かった → 引き分け較正。
 *   ④ 直前版(確定スタメン+直前オッズ)は累計 Brier でしか比べておらず、的中率も30日窓も無かった → lineupCompare。
 *   A 週次バックアップが読み出し失敗を飲み込み ok:true(10/25 分は重み null・11/1 分は欠落)。
 *   B リーグ別の表が大会名キーで、イタリアとブラジルの「Serie A」が1行に合算。
 *   C 同日2回目の学習が OddsAPI 統計を 0 件で上書き。
 *   D OddsAPI の対象が12大会で、学習済みの J1・チャンピオンシップ・ブラジルが対象外。
 *
 *  このテストは実際にコードを動かし、戻り値・保存内容で確かめる(推測で合格にしない)。 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 保存先モック(失敗を注入できる) */
function mockStore() {
  const store = new Map(); const calls = []; const state = { failAll: false };
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (state.failAll) { const e = new Error("STORE_DOWN_TEST"); e.code = "STORE_DOWN_TEST"; throw e; }
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { if (a[2] === "NX" && store.has(a[0])) return null; store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) if (store.delete(k)) n++; return n; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "HGETALL") { const h = store.get(a[0]); return h ? Object.entries(h).flat() : []; }
    if (op === "HSET") { const h = store.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; store.set(a[0], h); return 1; }
    if (op === "LRANGE") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; return l.slice(s, e + 1); }
    if (op === "LLEN") return (store.get(a[0]) || []).length;
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LREM") { const l = store.get(a[0]) || []; store.set(a[0], l.filter((v) => v !== a[2])); return 1; }
    if (op === "LTRIM") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; store.set(a[0], l.slice(s, e + 1)); return "OK"; }
    if (op === "EXPIRE" || op === "PEXPIRE") return 1;
    if (op === "EXISTS") return a.filter((k) => store.has(k)).length;
    return null;
  }
  const upstashGetJSON = async (k) => { try { const r = await upstashCmd(["GET", k]); return r === null ? null : JSON.parse(r); } catch (e) { return null; } };
  const upstashSetJSON = async (k, v) => { try { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; } catch (e) { return false; } };
  const count = (op) => calls.filter((c) => c[0] === op).length;
  const setJSON = (k, v) => store.set(k, JSON.stringify(v));
  return { store, calls, count, state, upstashCmd, upstashGetJSON, upstashSetJSON, setJSON };
}

/** 決定的な疑似乱数(テストのたびに同じ結果) */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const PORT = 8916;
const req = (method, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) { j = { raw: d }; } resolve({ status: res.statusCode, body: j }); }); });
  r.on("error", reject); r.end();
});

(async () => {
  console.log("v101 計測の物差し・確率の較正・不具合A〜D テスト");

  /* ================= A: 確率の較正(温度スケーリング) ================= */
  const pc = require("./learning/probCalibration");
  await t("A1 temper: T=1 は恒等、T<1 で鋭く、T>1 で平らに。最大確率の勝敗(argmax)は変わらない", async () => {
    const p = { home: 0.5, draw: 0.3, away: 0.2 };
    const same = pc.temper(p, 1); assert.ok(Math.abs(same.home - 0.5) < 1e-12 && Math.abs(same.draw - 0.3) < 1e-12);
    const sharp = pc.temper(p, 0.7); assert.ok(sharp.home > 0.5 && sharp.away < 0.2, JSON.stringify(sharp));
    const flat = pc.temper(p, 1.5); assert.ok(flat.home < 0.5 && flat.away > 0.2, JSON.stringify(flat));
    assert.ok(Math.abs(sharp.home + sharp.draw + sharp.away - 1) < 1e-9 && Math.abs(flat.home + flat.draw + flat.away - 1) < 1e-9);
    const argmax = (q) => (q.home >= q.draw && q.home >= q.away ? "home" : q.away >= q.draw ? "away" : "draw");
    const R = rng(3);
    for (let i = 0; i < 500; i++) {
      const h = R(), d = R(), a = R(); const s = h + d + a; const q = { home: h / s, draw: d / s, away: a / s };
      for (const T of [0.6, 0.8, 1.2, 1.6]) assert.strictEqual(argmax(pc.temper(q, T)), argmax(q), "温度で予想の勝敗が変わってはいけない");
    }
  });

  await t("A2 fitCalibrationModel: 強い自信不足のデータでは T<1 を採用し検証 LogLoss が改善、較正済みデータでは採用しない、件数不足は T=1 のまま理由つき", async () => {
    const make = (seed, trueT, n, odds) => {
      const R = rng(seed); const recs = [];
      for (let i = 0; i < n; i++) {
        const h = 0.3 + R() * 0.4, d = 0.2 + R() * 0.15, a = Math.max(0.05, 1 - h - d); const s = h + d + a;
        const stated = { homeWin: h / s, draw: d / s, awayWin: a / s };
        const tru = pc.temper({ home: stated.homeWin, draw: stated.draw, away: stated.awayWin }, trueT);
        const u = R(); const actual = u < tru.home ? "home" : (u < tru.home + tru.draw ? "draw" : "away");
        recs.push({ resolved: true, actualWinner: actual, finalProbs: stated, marketImplied: odds ? { homePct: 50, drawPct: 25, awayPct: 25 } : null, resolvedAt: new Date(1700000000000 + i * 3600000).toISOString() });
      }
      return recs;
    };
    // 強い自信不足(本当の分布は述べた確率を T=0.5 で鋭くしたもの)・十分な件数
    const strong = pc.fitCalibrationModel([...make(11, 0.5, 1200, true), ...make(12, 0.5, 600, false)], { nowIso: "2026-11-09T00:00:00Z" });
    for (const k of ["odds", "noOdds"]) {
      const r = strong.regimes[k];
      assert.strictEqual(r.adopted, true, k + ": " + r.reasonJa);
      assert.ok(r.T < 1, k + ": T は 1 未満のはず: " + r.T);
      assert.ok(r.validNllT < r.validNllBase - 0.002, k + ": 検証 LogLoss が改善しているはず");
      assert.strictEqual(r.validAccTPct, r.validAccBasePct, k + ": 的中率は不変のはず");
      assert.ok(Number.isFinite(r.validGainZ) && r.validGainZ >= 1.64, k + ": z 値が関門以上のはず: " + r.validGainZ);
    }
    assert.strictEqual(strong.anyAdopted, true);
    // 較正済み(述べた確率どおりに起きる)のデータ → 採用しない(複数シードで確認)
    let falsePositives = 0;
    for (let seed = 21; seed < 31; seed++) {
      const m = pc.fitCalibrationModel(make(seed, 1.0, 900, true));
      if (m.regimes.odds.adopted) falsePositives++;
    }
    assert.ok(falsePositives <= 1, `較正済みデータで ${falsePositives}/10 回も採用してしまった(偶然の改善を採用している)`);
    // 件数不足
    const few = pc.fitCalibrationModel(make(5, 0.5, 60, true));
    assert.strictEqual(few.regimes.odds.adopted, false); assert.strictEqual(few.regimes.odds.T, 1);
    assert.ok(/達していない/.test(few.regimes.odds.reasonJa), few.regimes.odds.reasonJa);
    assert.strictEqual(few.regimes.noOdds.nTrain, 0);
    // 要約(日次レポート用)
    const sum = pc.summarizeModel(strong);
    assert.strictEqual(sum.available, true); assert.strictEqual(sum.anyAdopted, true); assert.ok(sum.regimes.odds.T < 1);
    assert.strictEqual(pc.summarizeModel(null).available, false);
  });

  await t("A3 applyCalibration: 採用されたレジームだけ適用、生の確率が保存されていれば学習はそちらを使う(二重較正しない)", async () => {
    const model = { fittedAt: "x", regimes: { odds: { adopted: true, T: 0.8 }, noOdds: { adopted: false, T: 1 } } };
    const a1 = pc.applyCalibration({ home: 0.45, draw: 0.3, away: 0.25 }, model, "odds");
    assert.strictEqual(a1.applied, true); assert.strictEqual(a1.T, 0.8); assert.ok(a1.probs.home > 0.45);
    const a2 = pc.applyCalibration({ home: 0.45, draw: 0.3, away: 0.25 }, model, "noOdds");
    assert.strictEqual(a2.applied, false); assert.strictEqual(a2.probs.home, 0.45);
    assert.strictEqual(pc.applyCalibration({ home: 0.5, draw: 0.3, away: 0.2 }, null, "odds").applied, false);
    assert.strictEqual(pc.regimeOf({ marketImplied: { homePct: 40, drawPct: 30, awayPct: 30 } }), "odds");
    assert.strictEqual(pc.regimeOf({ marketImplied: null }), "noOdds");
    // 生の確率(rawFinalProbs)があればそれを学習材料にする
    const raw = pc.rawProbsOf({ finalProbs: { homeWin: 0.6, draw: 0.25, awayWin: 0.15 }, rawFinalProbs: { homeWin: 0.5, draw: 0.3, awayWin: 0.2 } });
    assert.ok(Math.abs(raw.home - 0.5) < 1e-9);
    assert.strictEqual(pc.rawProbsOf({ finalProbs: { homeWin: NaN, draw: 0.3, awayWin: 0.2 } }), null);
  });

  /* ================= B: 精度集計の新しい物差し ================= */
  const acc = require("./learning/accuracyTracker");
  await t("B1 buildDailyAccuracy: オッズあり/なし別・リーグ別の引き分け較正・朝版 vs 直前版 が積まれ、要約に出る", async () => {
    const mk = (hit, league, country, oddsPresent, drawP, actual, lc) => ({
      official: true, league, leagueCountry: country, learned: true, oddsPresent,
      lineupCompare: lc || null,
      markets: { oneX2: { hit, brier: 0.5, logLoss: 0.7, confidence: 0.55, predicted: "home", actual, probs: { homeWin: 0.5 - drawP / 2, draw: drawP, awayWin: 0.5 - drawP / 2 } } },
    });
    const scored = [
      mk(true, "Serie A", "Italy", true, 0.25, "home", { morningBrier: 0.6, preKickBrier: 0.5, morningLogLoss: 0.8, preKickLogLoss: 0.7, morningHit: true, preKickHit: true, changed: false }),
      mk(false, "Serie A", "Italy", true, 0.30, "draw", { morningBrier: 0.9, preKickBrier: 0.6, morningLogLoss: 1.2, preKickLogLoss: 0.9, morningHit: false, preKickHit: true, changed: true }),
      mk(true, "Serie A", "Brazil", false, 0.20, "home"),
      mk(false, "Serie A", "Brazil", false, 0.22, "away"),
      mk(true, "UEFA Champions League", "World", true, 0.18, "home"),
    ];
    const agg = acc.buildDailyAccuracy(scored);
    // B: 同名大会は国名で区別される("World" は付かない)
    assert.deepStrictEqual(Object.keys(agg.oneX2.byLeague).sort(), ["Serie A(Brazil)", "Serie A(Italy)", "UEFA Champions League"]);
    assert.strictEqual(agg.oneX2.byLeague["Serie A(Italy)"].n, 2);
    assert.strictEqual(agg.oneX2.byLeague["Serie A(Italy)"].drawActual, 1);
    assert.strictEqual(agg.oneX2.byLeague["Serie A(Italy)"].drawPredN, 2);
    assert.ok(Math.abs(agg.oneX2.byLeague["Serie A(Italy)"].drawPredSum - 0.55) < 1e-9);
    // ① オッズあり/なし
    assert.strictEqual(agg.oneX2.byOdds.withOdds.n, 3); assert.strictEqual(agg.oneX2.byOdds.withOdds.hits, 2);
    assert.strictEqual(agg.oneX2.byOdds.noOdds.n, 2); assert.strictEqual(agg.oneX2.byOdds.noOdds.hits, 1);
    // ③ 朝版 vs 直前版(直前版のある2件だけ)
    assert.strictEqual(agg.oneX2.lineup.n, 2); assert.strictEqual(agg.oneX2.lineup.morningHits, 1); assert.strictEqual(agg.oneX2.lineup.preKickHits, 2);
    assert.strictEqual(agg.oneX2.lineup.changed, 1); assert.strictEqual(agg.oneX2.lineup.changedPreKickHits, 1); assert.strictEqual(agg.oneX2.lineup.changedMorningHits, 0);
    assert.ok(Math.abs(agg.oneX2.lineup.preKickBrierSum - 1.1) < 1e-9);
    // 要約
    const s = acc.summarizeAccuracy(agg).markets.oneX2;
    assert.strictEqual(s.byOdds.measurable, true); assert.strictEqual(s.byOdds.withOdds.hitRatePct, 66.7); assert.strictEqual(s.byOdds.noOdds.hitRatePct, 50); assert.strictEqual(s.byOdds.noOddsSharePct, 40); assert.strictEqual(s.byOdds.gapPt, 16.7);
    assert.ok(Number.isFinite(s.byOdds.noOdds.skill.logLossSkillPct));
    assert.strictEqual(s.lineupCompare.measurable, true); assert.strictEqual(s.lineupCompare.n, 2); assert.strictEqual(s.lineupCompare.morning.hitRatePct, 50); assert.strictEqual(s.lineupCompare.preKick.hitRatePct, 100);
    assert.strictEqual(s.lineupCompare.deltaHitPt, 50); assert.ok(s.lineupCompare.deltaBrier < 0, "直前版の方が Brier が良いのでマイナス");
    const italy = s.byLeague.rows.find((r) => r.league === "Serie A(Italy)");
    assert.strictEqual(italy.drawActualPct, 50); assert.strictEqual(italy.drawPredAvgPct, 27.5); assert.strictEqual(italy.drawGapPt, -22.5);
    // 母数10件未満なので drawCalibration の表には出ない(偶然で数字を動かさない)
    assert.strictEqual(s.byLeague.drawCalibration.measurable, false);
  });

  await t("B2 mergeDailyAccuracy: 新しい物差しが合算され、旧形式(無い記録)と混ぜても壊れない", async () => {
    const mk = (hit, oddsPresent, drawP, actual) => ({ official: true, league: "Eredivisie", leagueCountry: "Netherlands", learned: true, oddsPresent, markets: { oneX2: { hit, brier: 0.5, logLoss: 0.7, confidence: 0.55, predicted: "home", actual, probs: { homeWin: 0.5, draw: drawP, awayWin: 0.5 - drawP } } } });
    const rows = []; for (let i = 0; i < 12; i++) rows.push(mk(i % 2 === 0, true, 0.2, i % 3 === 0 ? "draw" : "home"));
    const d1 = acc.buildDailyAccuracy(rows.slice(0, 6));
    const d2 = acc.buildDailyAccuracy(rows.slice(6));
    const m = acc.mergeDailyAccuracy(d1, d2);
    assert.strictEqual(m.oneX2.byOdds.withOdds.n, 12);
    assert.strictEqual(m.oneX2.byLeague["Eredivisie(Netherlands)"].n, 12);
    assert.strictEqual(m.oneX2.byLeague["Eredivisie(Netherlands)"].drawPredN, 12);
    assert.strictEqual(m.oneX2.byLeague["Eredivisie(Netherlands)"].drawActual, 4);
    const s = acc.summarizeAccuracy(m).markets.oneX2;
    assert.strictEqual(s.byLeague.drawCalibration.measurable, true, "母数12件なので引き分け較正の表に出るはず");
    assert.strictEqual(s.byLeague.drawCalibration.rows[0].drawActualPct, 33.3); assert.strictEqual(s.byLeague.drawCalibration.rows[0].drawPredAvgPct, 20); assert.strictEqual(s.byLeague.drawCalibration.rows[0].drawGapPt, -13.3);
    assert.strictEqual(s.byLeague.drawCalibration.overall.n, 12);
    // 旧形式との合算
    const old = acc.emptyDailyAccuracy(); old.oneX2.n = 5; old.oneX2.hits = 3; old.oneX2.brierSum = 2.5; old.oneX2.logLossSum = 3.5;
    const m2 = acc.mergeDailyAccuracy(old, d1);
    assert.strictEqual(m2.oneX2.n, 11); assert.strictEqual(m2.oneX2.byOdds.withOdds.n, 6); assert.strictEqual(m2.oneX2.lineup, undefined);
    const s2 = acc.summarizeAccuracy(old).markets.oneX2;
    assert.strictEqual(s2.byOdds.measurable, false); assert.strictEqual(s2.lineupCompare.measurable, false);
  });

  await t("B3 leagueKeyOf: 国名で区別・World は付けない・空は「(大会名なし)」", async () => {
    assert.strictEqual(acc.leagueKeyOf("Serie A", "Italy"), "Serie A(Italy)");
    assert.strictEqual(acc.leagueKeyOf("Serie A", "Brazil"), "Serie A(Brazil)");
    assert.strictEqual(acc.leagueKeyOf("UEFA Champions League", "World"), "UEFA Champions League");
    assert.strictEqual(acc.leagueKeyOf("Premier League"), "Premier League");
    assert.strictEqual(acc.leagueKeyOf(""), "(大会名なし)");
  });

  /* ================= C: 直前版の採点(的中・LogLoss) ================= */
  await t("C1 lineupWatch.scoreResolvedPreKick: Brier に加えて的中・LogLoss・判定が変わったかを返す", async () => {
    const lw = require("./learning/lineupWatch");
    const rec = {
      resolved: true, actualWinner: "away", predictedWinner: "home",
      homeLambda: 1.6, awayLambda: 1.1, weightsSnapshot: { rho: 0, marketBlend: 0.9 },
      marketImplied: { homePct: 50, drawPct: 25, awayPct: 25 }, blendUsed: { w: 0.9 },
      preKick: { blended: { predictedWinner: "away", probsPct: { homeWinPct: 30, drawPct: 25, awayWinPct: 45 } } },
    };
    const s = lw.scoreResolvedPreKick(rec);
    assert.strictEqual(s.morningHit, false); assert.strictEqual(s.preKickHit, true); assert.strictEqual(s.changed, true);
    assert.ok(s.preKickBrier < s.morningBrier && s.preKickLogLoss < s.morningLogLoss, JSON.stringify(s));
    assert.strictEqual(lw.scoreResolvedPreKick({ resolved: true, actualWinner: "home" }), null, "直前版の無い記録は null");
  });

  /* ================= D: 同日再実行の合算規則(不具合C) ================= */
  const dj = require("./learning/dailyJob");
  await t("D1 mergeGrowthLogs: OddsAPI・xG 収集・直前観測は合算され、2回目の 0 件が1回目を消さない", async () => {
    const prev = { date: "2026-11-08", ranAt: "2026-11-08T02:00:00Z", runsToday: 1, firstRanAt: "2026-11-08T02:00:00Z",
      oddsApi: { enabled: true, leaguesFetched: 8, eventsTotal: 154, usedInPredictions: 30, failures: ["league40:http_404"], fixturesConsidered: 41, fixturesOutOfScope: 7 },
      xgCollect: { ran: true, leaguesChecked: 3, fixturesSeen: 20, statsFetched: 10, xgSaved: 8, alreadyHad: 2, noXgProvided: 0, errors: [] },
      lineupWatch: { comparedToday: 4, morningBrierAvgToday: 0.6, preKickBrierAvgToday: 0.5, morningHitsToday: 2, preKickHitsToday: 3, changedToday: 1, cumulative: { n: 270 } },
      marketBlendFit: { adopted: true, w: 0.9, samples: 1188 }, probCalibration: { fitted: true, appliedToday: 10, anyAdopted: true } };
    const cur = { date: "2026-11-08", ranAt: "2026-11-08T05:00:00Z",
      oddsApi: { enabled: true, leaguesFetched: 0, eventsTotal: 0, usedInPredictions: 0, failures: [], fixturesConsidered: 0, fixturesOutOfScope: 0 },
      xgCollect: { ran: false, leaguesChecked: 0, fixturesSeen: 0, statsFetched: 0, xgSaved: 0, alreadyHad: 0, noXgProvided: 0, errors: ["x"] },
      lineupWatch: { comparedToday: 2, morningBrierAvgToday: 0.3, preKickBrierAvgToday: 0.2, morningHitsToday: 1, preKickHitsToday: 1, changedToday: 0, cumulative: { n: 272 } },
      marketBlendFit: { adopted: false, w: 0, samples: 0, reasonJa: "見送り" }, probCalibration: { fitted: false, appliedToday: 0 } };
    const m = dj.mergeGrowthLogs(prev, cur);
    assert.strictEqual(m.runsToday, 2);
    assert.strictEqual(m.oddsApi.fixturesConsidered, 41, "2回目の 0 件が1回目を消した"); assert.strictEqual(m.oddsApi.usedInPredictions, 30); assert.deepStrictEqual(m.oddsApi.failures, ["league40:http_404"]);
    assert.strictEqual(m.xgCollect.ran, true); assert.strictEqual(m.xgCollect.xgSaved, 8); assert.deepStrictEqual(m.xgCollect.errors, ["x"]);
    assert.strictEqual(m.lineupWatch.comparedToday, 6); assert.strictEqual(m.lineupWatch.morningBrierAvgToday, 0.5); assert.strictEqual(m.lineupWatch.preKickHitsToday, 4); assert.strictEqual(m.lineupWatch.cumulative.n, 272);
    assert.strictEqual(m.marketBlendFit.samples, 1188, "記録のある方を残す");
    assert.strictEqual(m.probCalibration.fitted, true); assert.strictEqual(m.probCalibration.appliedToday, 10);
    // 片方しか無くても壊れない
    const m2 = dj.mergeGrowthLogs({ date: "2026-11-08", ranAt: "x" }, cur);
    assert.strictEqual(m2.oddsApi.fixturesConsidered, 0); assert.strictEqual(m2.runsToday, 2);
    const m3 = dj.mergeGrowthLogs(prev, { date: "2026-11-08", ranAt: "y" });
    assert.strictEqual(m3.oddsApi.fixturesConsidered, 41); assert.strictEqual(m3.lineupWatch.comparedToday, 4);
  });

  /* ================= E: 市場比率ごとの正確さの曲線 ================= */
  await t("E1 fitMarketBlend: 比率 0〜1.0 の検証 NLL の曲線(w=1.0 は市場単独の参考値)が返り、採用上限は 0.9 のまま", async () => {
    const pm = require("./learning/predictionModel");
    const R = rng(9); const recs = [];
    for (let i = 0; i < 200; i++) {
      // 市場の方が当たりやすいデータ(市場 60/20/20 でホームが 60% 勝つ・自前は 40/30/30)
      const u = R(); const actual = u < 0.6 ? "home" : u < 0.8 ? "draw" : "away";
      recs.push({ resolved: true, actualWinner: actual, homeLambda: 1.2, awayLambda: 1.1, marketImplied: { homePct: 60, drawPct: 20, awayPct: 20 }, weightsSnapshot: { rho: 0 } });
    }
    const fit = pm.fitMarketBlend(recs);
    assert.ok(Array.isArray(fit.curve) && fit.curve.length === 11, "曲線は w=0〜1.0 の11点");
    assert.strictEqual(fit.curve[0].w, 0); assert.strictEqual(fit.curve[10].w, 1);
    assert.ok(fit.curve.every((c) => Number.isFinite(c.validNll) && Number.isFinite(c.trainNll) && Number.isFinite(c.validAccPct)));
    assert.ok(Number.isFinite(fit.marketAloneValidNll));
    assert.ok(fit.w <= 0.9, "採用上限は 0.9");
    assert.strictEqual(fit.marketAloneValidNll, fit.curve[10].validNll);
  });

  /* ================= F: 自己診断のリーグ表(不具合B) ================= */
  await t("F1 selfImprovement: リーグ表のキーが国名つきになり、イタリアとブラジルの Serie A が別行になる", async () => {
    const si = require("./learning/selfImprovement");
    assert.strictEqual(si.leagueLabelOf({ league: "Serie A", leagueCountry: "Italy" }), "Serie A(Italy)");
    assert.strictEqual(si.leagueLabelOf({ league: "UEFA Champions League", leagueCountry: "World" }), "UEFA Champions League");
    assert.strictEqual(si.leagueLabelOf({ league: "Serie A" }), "Serie A");
    const recs = [];
    for (let i = 0; i < 4; i++) recs.push({ resolved: true, actualWinner: "home", correct: i % 2 === 0, predictedWinner: "home", league: "Serie A", leagueCountry: "Italy" });
    for (let i = 0; i < 3; i++) recs.push({ resolved: true, actualWinner: "away", correct: false, predictedWinner: "home", league: "Serie A", leagueCountry: "Brazil" });
    const d = si.buildSelfDiagnosis({ recentRecords: recs, featureEffectiveness: null, apiCallStats: null, errors: [], accuracyTrend: null });
    const names = d.leagueTable.map((r) => r.league).sort();
    assert.deepStrictEqual(names, ["Serie A(Brazil)", "Serie A(Italy)"]);
    assert.strictEqual(d.leagueTable.find((r) => r.league === "Serie A(Italy)").n, 4);
    assert.ok(/国名で区別/.test(d.leagueTableNoteJa));
  });

  /* ================= G: OddsAPI の対象(不具合D) ================= */
  await t("G1 oddsApi.SPORT_KEYS: 学習済み15大会がすべてコンセンサスの対象", async () => {
    const { SPORT_KEYS } = require("./learning/oddsApi");
    const { DEFAULT_BACKFILL_LEAGUES } = require("./learning/historicalBackfill");
    const missing = DEFAULT_BACKFILL_LEAGUES.map((l) => l.id).filter((id) => !SPORT_KEYS[id]);
    assert.deepStrictEqual(missing, [], "学習済みなのに OddsAPI の対象外の大会: " + missing.join(","));
    assert.strictEqual(SPORT_KEYS[98], "soccer_japan_j_league"); assert.strictEqual(SPORT_KEYS[40], "soccer_efl_champ"); assert.strictEqual(SPORT_KEYS[71], "soccer_brazil_campeonato");
  });

  /* ================= H: サーバー(バックアップ export・較正済み記録の表示・日次レポート) ================= */
  process.env.PORT = String(PORT);
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.API_FOOTBALL_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.LINEUP_WATCH = "0";
  process.env.SELF_HEAL_DAILY_LEARNING = "0";
  const srvMod = require("./server.js");
  const V = srvMod.__v101ForTest;
  const m = mockStore();
  srvMod.__setTestHooks({ upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON, callApiFootball: async () => ({ response: [] }) });
  await sleep(300);
  const now = Date.now();
  const jstToday = new Date(now + 9 * 3600000).toISOString().slice(0, 10);

  await t("H1 /api/backup/export(不具合A): 中核が揃えば ok:true・中核が無ければ ok:false+partial+missing・読めなければ ok:false、個別 GET の嵐にしない", async () => {
    m.store.clear(); m.calls.length = 0;
    m.setJSON("learn:weights", { version: 33 }); m.setJSON("learn:growthlog:latest", { date: jstToday });
    m.store.set("learn:weights:history", [JSON.stringify({ version: 33 })]);
    m.setJSON(`learn:accuracy:${jstToday}`, acc.emptyDailyAccuracy());
    const ok = await V.handleBackupExport();
    assert.strictEqual(ok.body.ok, true); assert.strictEqual(ok.body.partial, false); assert.deepStrictEqual(ok.body.missing, []);
    assert.strictEqual(ok.body.data.weights.version, 33); assert.strictEqual(ok.body.data.weightsHistory.length, 1); assert.ok(ok.body.data.accuracyByDay[jstToday]);
    assert.ok(m.count("GET") <= 2, `個別 GET が多すぎる: ${m.count("GET")}`); assert.ok(m.count("MGET") >= 2 && m.count("MGET") <= 4, `MGET=${m.count("MGET")}`);
    // 中核(重み)が無い → ok:false + partial
    m.store.delete("learn:weights");
    const part = await V.handleBackupExport();
    assert.strictEqual(part.body.ok, false); assert.strictEqual(part.body.partial, true); assert.deepStrictEqual(part.body.missing, ["learn:weights"]); assert.ok(/不完全/.test(part.body.reasonJa));
    // 保存先が読めない → ok:false(空のバックアップを成功と呼ばない)
    m.state.failAll = true;
    const down = await V.handleBackupExport();
    assert.strictEqual(down.body.ok, false); assert.strictEqual(down.body.partial, true); assert.ok(/読み出しに失敗/.test(down.body.reasonJa), down.body.reasonJa);
    m.state.failAll = false;
    // Actions 側は partial を失敗扱いにして再試行する
    const yml = fs.readFileSync(path.join(__dirname, ".github/workflows/weekly-backup.yml"), "utf8");
    assert.ok(/"partial":true/.test(yml) && /ATTEMPT/.test(yml) && /sleep 60/.test(yml), "weekly-backup.yml に partial 判定と再試行が無い");
  });

  await t("H2 buildTodayPredictionEntry: 温度較正済みの記録は表示側の帯補正を重ねず、生値(較正前)を併記する", async () => {
    const fixture = { id: 1, date: new Date(now + 3600000).toISOString(), status: "NS", league: "Serie A", home: { name: "A" }, away: { name: "B" } };
    const calMap = { available: true, minN: 20, bins: { "55-70%": { n: 50, avgConfPct: 60, actualHitPct: 70 } } };
    const base = { fixtureId: 1, predictedWinner: "home", homeLambda: 1.5, awayLambda: 1.0, finalProbs: { homeWin: 0.62, draw: 0.22, awayWin: 0.16, source: "market_blend" }, factorImportance: [] };
    // 較正なしの記録 → 従来どおり帯補正(60→70)
    const e1 = V.buildTodayPredictionEntry(fixture, base, calMap);
    assert.strictEqual(e1.confidence.calibrated, true); assert.strictEqual(e1.confidence.method, "bin"); assert.strictEqual(e1.confidence.displayPct, 72); assert.strictEqual(e1.confidence.rawPct, 62);
    // 温度較正済みの記録 → 帯補正は掛けない。表示=較正後(62)、生値=較正前(55)
    const e2 = V.buildTodayPredictionEntry(fixture, { ...base, rawFinalProbs: { homeWin: 0.55, draw: 0.25, awayWin: 0.2 }, probCalibration: { applied: true, regime: "odds", T: 0.8 } }, calMap);
    assert.strictEqual(e2.confidence.calibrated, true); assert.strictEqual(e2.confidence.method, "temperature"); assert.strictEqual(e2.confidence.displayPct, 62); assert.strictEqual(e2.confidence.rawPct, 55); assert.strictEqual(e2.confidence.gapPt, 7); assert.strictEqual(e2.confidence.temperature, 0.8);
    assert.strictEqual(e2.calibrated, null, "帯補正の結果を重ねてはいけない");
    assert.strictEqual(e2.probs.homeWinPct, 62);
  });

  await t("H3 /api/learning/daily-report: probCalibration(model/today)・marketBlendFit.curve・byOdds・lineupCompare が載る", async () => {
    srvMod.__clearCache();
    m.setJSON("learn:weights", { version: 34, updatedAt: new Date(now).toISOString(), marketBlend: 0.9 });
    m.setJSON("learn:growthlog:latest", {
      date: jstToday, ranAt: new Date(now).toISOString(), runsToday: 1, errors: [], warnings: { count: 0, items: [] },
      marketBlendFit: { adopted: true, w: 0.9, samples: 1200, curve: [{ w: 0, validNll: 0.99 }, { w: 0.9, validNll: 0.963 }, { w: 1, validNll: 0.961 }], marketAloneValidNll: 0.961 },
      probCalibration: { fitted: true, saved: true, appliedToday: 12, available: true, anyAdopted: true, regimes: { odds: { adopted: true, T: 0.85 } } },
    });
    m.setJSON("learn:calibration:model", { version: 1, fittedAt: new Date(now).toISOString(), samples: 900, anyAdopted: true, regimes: { odds: { adopted: true, T: 0.85, nTrain: 500, nValid: 200, validNllBase: 0.97, validNllT: 0.96, validGain: 0.01, reasonJa: "採用" }, noOdds: { adopted: false, T: 1, nTrain: 100, nValid: 40, reasonJa: "見送り" } } });
    const scored = [
      { official: true, league: "Serie A", leagueCountry: "Italy", learned: true, oddsPresent: true, lineupCompare: { morningBrier: 0.6, preKickBrier: 0.5, morningLogLoss: 0.8, preKickLogLoss: 0.7, morningHit: true, preKickHit: true, changed: false }, markets: { oneX2: { hit: true, brier: 0.4, logLoss: 0.5, confidence: 0.6, predicted: "home", actual: "home", probs: { homeWin: 0.6, draw: 0.25, awayWin: 0.15 } } } },
      { official: true, league: "Allsvenskan", leagueCountry: "Sweden", learned: false, oddsPresent: false, markets: { oneX2: { hit: false, brier: 0.9, logLoss: 1.3, confidence: 0.4, predicted: "home", actual: "draw", probs: { homeWin: 0.4, draw: 0.3, awayWin: 0.3 } } } },
    ];
    const yKey = new Date(now + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
    m.setJSON(`learn:accuracy:${yKey}`, acc.buildDailyAccuracy(scored));
    const r = await req("GET", `/api/learning/daily-report?d=${jstToday}&t=${Date.now()}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const b = r.body;
    assert.strictEqual(b.probCalibration.model.available, true); assert.strictEqual(b.probCalibration.model.regimes.odds.T, 0.85); assert.strictEqual(b.probCalibration.model.regimes.noOdds.adopted, false);
    assert.strictEqual(b.probCalibration.today.appliedToday, 12);
    assert.strictEqual(b.marketBlendFit.curve.length, 3); assert.strictEqual(b.marketBlendFit.marketAloneValidNll, 0.961);
    const y = b.accuracy.yesterday.markets.oneX2;
    assert.strictEqual(y.byOdds.measurable, true); assert.strictEqual(y.byOdds.withOdds.n, 1); assert.strictEqual(y.byOdds.noOdds.n, 1); assert.strictEqual(y.byOdds.noOddsSharePct, 50);
    assert.strictEqual(y.lineupCompare.measurable, true); assert.strictEqual(y.lineupCompare.n, 1);
    assert.ok(y.byLeague.rows.some((row) => row.league === "Serie A(Italy)"));
    // 較正モデルが無い環境でも壊れない
    m.store.delete("learn:calibration:model"); srvMod.__clearCache();
    const r2 = await req("GET", `/api/learning/daily-report?d=${jstToday}&t=${Date.now() + 1}`);
    assert.strictEqual(r2.status, 200); assert.strictEqual(r2.body.probCalibration.model.available, false);
  });

  /* ================= I: 画面(引き分け注意・較正済み確信度)と版 ================= */
  await t("I1 index.html: 引き分け注意と較正済み確信度の行があり、辞書(EN/ZH/ES)に訳がある。sw.js の版が上がっている", async () => {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(html.includes("<span>引き分け注意</span>"), "引き分け注意の行が無い");
    assert.ok(html.includes('c.method === "temperature"'), "温度較正の分岐が無い");
    const dictPart = html.slice(0, html.indexOf("/* ==== 辞書ここまで ==== */"));
    for (const k of ["確信度(較正済み)", "実測で学習した較正", "引き分け注意", "引き分けの確率が", "と高めの試合です(予想は最も確率の高い勝敗のまま)"]) {
      assert.ok(new RegExp(`"${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*\\[`).test(dictPart), "辞書に無い: " + k);
    }
    const sw = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
    assert.ok(/soccer-ai-shell-v101/.test(sw), "sw.js の版が v101 になっていない");
  });

  /* ================= J: 本物の日次学習で較正が予想に適用される ================= */
  await t("J1 runDailyLearning: 保存済みの較正モデル(採用あり)が翌日の新規予想に適用され、生の確率と T が記録に残る。成長ログに probCalibration が載る", async () => {
    const mk = mockStore();
    // 前夜の学習が保存した較正モデル(オッズなし=このモックは市場オッズを返さない)
    mk.setJSON(probCalibrationLibKeyModel(), { version: 1, fittedAt: "2026-11-08T22:00:00Z", samples: 500, anyAdopted: true, regimes: { noOdds: { adopted: true, T: 0.8 }, odds: { adopted: false, T: 1 } } });
    function probCalibrationLibKeyModel() { return pc.MODEL_KEY; }
    const callApiFootball = async (endpoint, params) => {
      if (endpoint === "/teams") return { response: [{ team: { id: 100, name: params.search } }] };
      if (endpoint === "/fixtures" && params.next) {
        return { response: [{ fixture: { id: 424242, date: new Date(Date.now() + 86400e3).toISOString(), status: { short: "NS" } }, teams: { home: { id: 100, name: "Home FC" }, away: { id: 2, name: "Away FC" } }, goals: { home: null, away: null }, league: { id: 39, name: "Premier League", country: "England", season: 2026 } }] };
      }
      if (endpoint === "/fixtures" && params.last) {
        const list = []; for (let i = 0; i < 10; i++) list.push({ fixture: { id: 1000 + i, date: new Date(Date.now() - i * 86400e3).toISOString(), status: { short: "FT" } }, teams: { home: { id: 100 }, away: { id: 2 } }, goals: { home: i < 5 ? 3 : 0, away: i < 5 ? 0 : 2 } });
        return { response: list };
      }
      return { response: [] };
    };
    const out = await dj.runDailyLearning({ callApiFootball, resolveTeamId: async () => 100, upstashEnabled: true, ...mk, now: () => new Date("2026-11-09T03:00:00Z") });
    assert.strictEqual(out.ok, true, JSON.stringify(out.errors || []).slice(0, 300));
    const rec = await mk.upstashGetJSON("learn:ownpred:424242");
    assert.ok(rec, "新規予想が保存されていない: " + JSON.stringify((out.errors || []).slice(0, 5)));
    assert.strictEqual(rec.leagueCountry, "England", "国名が記録されていない");
    assert.ok(rec.probCalibration && rec.probCalibration.applied === true, "較正が適用されていない: " + JSON.stringify(rec.probCalibration));
    assert.strictEqual(rec.probCalibration.T, 0.8); assert.strictEqual(rec.probCalibration.regime, "noOdds");
    assert.ok(rec.rawFinalProbs && Number.isFinite(rec.rawFinalProbs.homeWin), "生の確率が残っていない");
    const re = pc.temper({ home: rec.rawFinalProbs.homeWin, draw: rec.rawFinalProbs.draw, away: rec.rawFinalProbs.awayWin }, 0.8);
    assert.ok(Math.abs(re.home - rec.finalProbs.homeWin) < 1e-3 && Math.abs(re.draw - rec.finalProbs.draw) < 1e-3, "finalProbs が生の確率に T を掛けたものと一致しない");
    const argmax = (q) => (q.homeWin >= q.draw && q.homeWin >= q.awayWin ? "home" : q.awayWin >= q.draw ? "away" : "draw");
    assert.strictEqual(argmax(rec.finalProbs), argmax(rec.rawFinalProbs), "較正で最大確率の勝敗が変わってはいけない");
    const g = await mk.upstashGetJSON("learn:growthlog:latest");
    assert.ok(g.probCalibration && g.probCalibration.fitted === true, "成長ログに較正の学習経過が無い");
    assert.strictEqual(g.probCalibration.appliedToday, 1);
    // 答え合わせ済みの記録が少ないので、今夜の学習では採用されない(件数不足の理由つき)が、モデルは保存される
    const saved = await mk.upstashGetJSON(pc.MODEL_KEY);
    assert.ok(saved && saved.regimes && saved.regimes.noOdds, "較正モデルが保存されていない");
    assert.strictEqual(saved.regimes.noOdds.adopted, false); assert.ok(/達していない/.test(saved.regimes.noOdds.reasonJa));
  });

  await t("K1 v92方針: 今回触った learning/ のファイルに黙った catch を増やしていない", async () => {
    for (const f of ["learning/probCalibration.js", "learning/accuracyTracker.js", "learning/dailyJob.js", "learning/lineupWatch.js", "learning/selfImprovement.js", "learning/oddsApi.js", "learning/predictionModel.js"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      const n = (src.match(/catch \(e\) \{ \/\*/g) || []).length;
      if (f === "learning/accuracyTracker.js") assert.strictEqual(n, 1, f + ": 許可リストの1か所だけのはず: " + n);
      else assert.strictEqual(n, 0, f + " に黙った catch がある: " + n);
    }
  });

  console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
  try { srvMod.server.close(); } catch (e) { /* テスト終了時の後片づけ */ }
  process.exit(fail ? 1 : 0);
})();
