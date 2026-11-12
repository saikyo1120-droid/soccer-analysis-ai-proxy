"use strict";
/**
 * v104 J「試合内容の予測」の検証(learning/matchContent.js・accuracyTracker の連結)
 *   ・公開中の勝敗確率(finalProbs)を再現する λ の組を解けること(5種類の確率で誤差 1e-3 以内)
 *   ・content(λ版 raw / 整合版 fin / 表示 shown)が作られ、勝敗の予想を変えないこと
 *   ・採点(2.5点以上・両チーム得点の Brier、Top1/Top3)と日次集計の合算・要約
 *   ・表示元の切り替え関門: 合成データで「整合版が本当に良いときだけ切り替わり、偶然では切り替わらない」、
 *     採用後に有意に悪化したら戻る
 *   ・二値の温度較正: 件数不足は T=1、系統的な自信過剰には T>1 が採用され、無作為ノイズでは不採用
 */
const assert = require("assert");
const mc = require("./learning/matchContent");
const at = require("./learning/accuracyTracker");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

// 決定的な疑似乱数(テストの再現性)
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function poissonSample(lambda, r) { const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }

t("finalProbs を再現する λ を解ける(5種類・残差 2e-3 以内・ρ込み)", () => {
  for (const [h, d, a] of [[0.52, 0.26, 0.22], [0.33, 0.34, 0.33], [0.75, 0.15, 0.10], [0.20, 0.25, 0.55], [0.45, 0.30, 0.25]]) {
    const sol = mc.solveLambdasForProbs(h, a, -0.05, { homeLambda: 1.4, awayLambda: 1.1 });
    assert.ok(sol.ok, JSON.stringify(sol));
    const m = mc.gridMetrics(sol.homeLambda, sol.awayLambda, -0.05);
    assert.ok(Math.abs(m.pHome - h) < 2e-3 && Math.abs(m.pAway - a) < 2e-3, JSON.stringify({ h, a, m }));
  }
  assert.strictEqual(mc.solveLambdasForProbs(0.99, 0.005, 0).ok, false, "範囲外の確率は解かない");
});

t("buildMatchContent: raw/fin/shown が揃い、既定は λ版表示・較正なし。整合版を表示に選ぶと shown が fin になる", () => {
  const c = mc.buildMatchContent({ homeLambda: 1.6, awayLambda: 1.0, finalProbs: { homeWin: 0.38, draw: 0.33, awayWin: 0.29 }, rho: 0, model: null });
  assert.strictEqual(c.disp, "lambda"); assert.strictEqual(c.cal, null);
  assert.ok(c.fin && c.fin.ok && c.fin.exp < c.raw.exp, "引き分け33%の最終確率は λ版より低い合計得点を含意する");
  assert.strictEqual(c.shown.ou25, c.raw.ou25);
  const c2 = mc.buildMatchContent({ homeLambda: 1.6, awayLambda: 1.0, finalProbs: { homeWin: 0.38, draw: 0.33, awayWin: 0.29 }, rho: 0, model: { display: "final", calibration: { over25: { adopted: true, T: 1.3 }, btts: { adopted: false, T: 1 } } } });
  assert.strictEqual(c2.disp, "final"); assert.strictEqual(c2.cal.ou, 1.3);
  assert.ok(Math.abs(c2.shown.btts - c2.fin.btts) < 1e-9 && c2.shown.ou25 !== c2.fin.ou25, "較正は採用された市場だけに掛かる");
  assert.ok(c2.shown.styleJa.includes("接戦") || c2.shown.styleJa.includes("優勢"));
  assert.strictEqual(mc.buildMatchContent({ homeLambda: NaN, awayLambda: 1 }), null);
  const noFin = mc.buildMatchContent({ homeLambda: 1.2, awayLambda: 1.1, finalProbs: null, rho: 0, model: { display: "final" } });
  assert.strictEqual(noFin.disp, "lambda", "整合版が作れない記録は λ版のまま");
});

t("describeContent: 画面向けの%と注記(較正中の件数)", () => {
  const c = mc.buildMatchContent({ homeLambda: 1.6, awayLambda: 1.0, finalProbs: { homeWin: 0.5, draw: 0.27, awayWin: 0.23 }, rho: 0 });
  const d = mc.describeContent(c, { calibrationSamples: 42 });
  assert.ok(d.over25Pct + d.under25Pct === 100 && d.topScorelines.length === 3 && /42件/.test(d.calibrationNoteJa), JSON.stringify(d));
  assert.strictEqual(mc.describeContent(null), null);
});

t("採点: 実スコアから 2.5点以上/両チーム得点の Brier・Top1/Top3・期待得点の誤差を raw/fin/shown ごとに出す", () => {
  const c = mc.buildMatchContent({ homeLambda: 1.6, awayLambda: 1.0, finalProbs: { homeWin: 0.5, draw: 0.27, awayWin: 0.23 }, rho: 0 });
  const sc = mc.scoreContent({ content: c }, { home: 2, away: 1 });
  assert.ok(sc.raw && sc.fin && sc.shown && Number.isFinite(sc.d));
  assert.strictEqual(sc.yOu, 1); assert.strictEqual(sc.yBt, 1);
  assert.ok(sc.raw.ouBrier === Math.round(Math.pow(c.raw.ou25 - 1, 2) * 10000) / 10000);
  assert.strictEqual(mc.scoreContent({ content: null }, { home: 1, away: 0 }), null);
  assert.strictEqual(mc.scoreContent({ content: c }, null), null);
});

t("scorePrediction → buildDailyAccuracy → merge → summarize の連結(content が無い旧記録は壊れない)", () => {
  const c = mc.buildMatchContent({ homeLambda: 1.6, awayLambda: 1.0, finalProbs: { homeWin: 0.5, draw: 0.27, awayWin: 0.23 }, rho: 0 });
  const rec = { homeLambda: 1.6, awayLambda: 1.0, predictedWinner: "home", finalProbs: { homeWin: 0.5, draw: 0.27, awayWin: 0.23 }, predictedScoreline: "2-1", actualScore: { home: 2, away: 1 }, actualWinner: "home", content: c };
  const old = { ...rec, content: undefined };
  const s1 = at.scorePrediction(rec), s2 = at.scorePrediction(old);
  assert.ok(s1.content && !s2.content);
  const agg = at.buildDailyAccuracy([{ ...s1, official: true }, { ...s2, official: true }]);
  assert.strictEqual(agg.content.n, 1);
  const merged = at.mergeDailyAccuracy(agg, at.buildDailyAccuracy([{ ...s1, official: true }]));
  assert.strictEqual(merged.content.n, 2);
  const legacyMerged = at.mergeDailyAccuracy({ oneX2: { n: 1, hits: 1, brierSum: 0.2, logLossSum: 0.5, calibration: {}, perClass: {} } }, agg);
  assert.strictEqual(legacyMerged.content.n, 1, "片方に content が無くても合算できる");
  const sum = at.summarizeAccuracy(merged);
  assert.ok(sum.matchContent.measurable && sum.matchContent.raw.n === 2 && sum.matchContent.shown.n === 2, JSON.stringify(sum.matchContent));
  assert.strictEqual(at.summarizeAccuracy(at.buildDailyAccuracy([])).matchContent.measurable, false);
});

// ---- 合成データ: 整合版が本当に良い世界 / 違いが無い世界 ----
function synthRecords(n, seed, finBetter) {
  const r = rng(seed);
  const recs = [];
  for (let i = 0; i < n; i++) {
    const trueH = 0.8 + r() * 1.6, trueA = 0.6 + r() * 1.2;
    // λ版: 真の値に大きなノイズ / 整合版の元になる finalProbs: 真の分布から(finBetter のとき)
    const noise = finBetter ? 1.6 : 0.0; // λ版の誤差を大きく(±0.8)。実運用で検出できる差は n≈2,000 で Brier 0.0015 程度
    const rawH = Math.max(0.3, trueH + (r() - 0.5) * noise), rawA = Math.max(0.3, trueA + (r() - 0.5) * noise);
    const tm = mc.gridMetrics(trueH, trueA, 0);
    const finalProbs = finBetter ? { homeWin: tm.pHome, draw: tm.pDraw, awayWin: tm.pAway } : (() => { const m = mc.gridMetrics(rawH, rawA, 0); return { homeWin: m.pHome, draw: m.pDraw, awayWin: m.pAway }; })();
    const content = mc.buildMatchContent({ homeLambda: rawH, awayLambda: rawA, finalProbs, rho: 0 });
    recs.push({ fixtureId: i, homeLambda: rawH, awayLambda: rawA, finalProbs, content, resolved: true, resolvedAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(i / 5))).toISOString(), actualScore: { home: poissonSample(trueH, r), away: poissonSample(trueA, r) } });
  }
  return recs;
}

t("表示元の関門: 整合版が本当に良い合成データでは切り替わり、違いの無いデータでは切り替わらない(偶然で通さない)", () => {
  const good = synthRecords(800, 7, true);
  const cmp = mc.compareContentSources(good);
  assert.ok(cmp.n === 800 && cmp.gain > 0 && cmp.z > 1.64, JSON.stringify(cmp));
  const dec = mc.decideDisplay("lambda", cmp);
  assert.strictEqual(dec.display, "final"); assert.strictEqual(dec.changed, true);
  const same = synthRecords(800, 11, false);
  const cmp2 = mc.compareContentSources(same);
  const dec2 = mc.decideDisplay("lambda", cmp2);
  assert.strictEqual(dec2.display, "lambda", JSON.stringify(cmp2));
  // 件数不足では動かない
  assert.strictEqual(mc.decideDisplay("lambda", mc.compareContentSources(good.slice(0, 50))).display, "lambda");
  assert.strictEqual(mc.decideDisplay("final", mc.compareContentSources(good.slice(0, 50))).display, "final", "件数不足のときは前回の表示元を維持");
});

t("採用後に整合版が有意に悪化したら λ版へ戻る(ヒステリシス: 微差では戻らない)", () => {
  // 整合版が悪い世界: finalProbs を真の値から大きくずらす
  const r = rng(3);
  const recs = [];
  for (let i = 0; i < 300; i++) {
    const trueH = 1.0 + r() * 1.2, trueA = 0.8 + r() * 1.0;
    const m = mc.gridMetrics(trueH, trueA, 0);
    const bad = { homeWin: Math.min(0.9, m.pHome * 1.35), draw: Math.max(0.12, m.pDraw * 0.7), awayWin: Math.max(0.08, m.pAway * 0.8) };
    const s = bad.homeWin + bad.draw + bad.awayWin; bad.homeWin /= s; bad.draw /= s; bad.awayWin /= s;
    const content = mc.buildMatchContent({ homeLambda: trueH, awayLambda: trueA, finalProbs: bad, rho: 0 });
    recs.push({ content, resolvedAt: "2026-10-0" + ((i % 9) + 1), actualScore: { home: poissonSample(trueH, r), away: poissonSample(trueA, r) } });
  }
  const cmp = mc.compareContentSources(recs);
  assert.ok(cmp.z < -1.64, JSON.stringify(cmp));
  assert.strictEqual(mc.decideDisplay("final", cmp).display, "lambda");
  assert.strictEqual(mc.decideDisplay("final", { n: 300, gain: -0.0005, se: 0.001, z: -0.5 }).display, "final", "微差では戻さない");
});

t("二値の温度較正: 件数不足は T=1、自信過剰(p を極端に)には T>1 が採用され、ノイズだけなら不採用", () => {
  const few = mc.fitBinaryTemperature(Array.from({ length: 60 }, (_, i) => ({ p: 0.5, y: i % 2, at: "2026-10-01" })));
  assert.strictEqual(few.adopted, false); assert.strictEqual(few.T, 1); assert.ok(/件数不足/.test(few.reasonJa));
  const r = rng(5);
  const over = [];
  for (let i = 0; i < 600; i++) {
    const pTrue = 0.3 + r() * 0.4;                 // 本当の確率
    const y = r() < pTrue ? 1 : 0;
    const logit = Math.log(pTrue / (1 - pTrue)) * 2.2; // 2.2倍に鋭くした(=自信過剰な)申告
    over.push({ p: 1 / (1 + Math.exp(-logit)), y, at: "2026-10-" + String(1 + (i % 28)).padStart(2, "0") });
  }
  const fo = mc.fitBinaryTemperature(over);
  assert.ok(fo.adopted && fo.T > 1.3, JSON.stringify(fo));
  const calm = [];
  for (let i = 0; i < 600; i++) { const pTrue = 0.3 + r() * 0.4; calm.push({ p: pTrue, y: r() < pTrue ? 1 : 0, at: "2026-10-" + String(1 + (i % 28)).padStart(2, "0") }); }
  const fc = mc.fitBinaryTemperature(calm);
  assert.ok(!fc.adopted || Math.abs(fc.T - 1) <= 0.1, JSON.stringify(fc));
});

t("fitContentModel: 前回モデル・決定・較正・履歴がまとまり、summarizeModel が開示用に整う", () => {
  const good = synthRecords(800, 21, true);
  const m1 = mc.fitContentModel(good, { prevModel: null, nowIso: "2026-11-13T00:00:00Z" });
  assert.strictEqual(m1.display, "final"); assert.strictEqual(m1.history.length, 1);
  assert.ok(m1.calibration && m1.calibration.over25 && typeof m1.calibration.over25.adopted === "boolean");
  const m2 = mc.fitContentModel(good, { prevModel: m1, nowIso: "2026-11-14T00:00:00Z" });
  assert.strictEqual(m2.display, "final"); assert.strictEqual(m2.history.length, 1, "変化が無い日は履歴を増やさない");
  const sm = mc.summarizeModel(m2);
  assert.ok(sm.available && sm.display === "final" && sm.calibration.over25 && sm.decisionJa);
  assert.strictEqual(mc.summarizeModel(null).available, false);
});

t("calibrationSamples: 表示元に応じて raw/fin の較正前の値を使う(整合版が無い記録は飛ばす)", () => {
  const c = mc.buildMatchContent({ homeLambda: 1.6, awayLambda: 1.0, finalProbs: { homeWin: 0.5, draw: 0.27, awayWin: 0.23 }, rho: 0 });
  const recs = [{ content: c, actualScore: { home: 1, away: 1 }, resolvedAt: "2026-10-01" }, { content: { ...c, fin: { ok: false } }, actualScore: { home: 3, away: 0 } }, { content: c, actualScore: null }];
  assert.strictEqual(mc.calibrationSamples(recs, "lambda", "over25").length, 2);
  assert.strictEqual(mc.calibrationSamples(recs, "final", "over25").length, 1);
  assert.strictEqual(mc.calibrationSamples(recs, "lambda", "btts")[0].y, 1);
});

console.log(`\nv104 match content: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
