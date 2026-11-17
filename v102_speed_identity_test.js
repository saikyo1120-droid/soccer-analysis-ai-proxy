"use strict";
/**
 * v102(2026年11月17日)・「同じ答えを、少ない計算で出す」の検証
 * ----------------------------------------------------------------------------
 *   勝ち・引き分け・負けの確率(computeMatchProbabilitiesRaw)は、重みの学習の中で数百万回呼ばれる。
 *   v102 で、81マスごとに2回ずつ計算していたポアソンの値を、先に9個ずつ計算してから掛け合わせる形にした。
 *   「速くしただけで、答えは1ビットも変わっていない」ことを、以前の計算(scoreGrid を使う形)と突き合わせて確かめる。
 *   答えが少しでも変わると、学習で選ばれる重み・画面に出る確率が変わりうる(劣化禁止)。
 */
const assert = require("assert");
const path = require("path");
const pm = require(path.join(__dirname, "learning", "predictionModel.js"));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e)); } };

/** v101 までの計算そのもの(scoreGrid で81マスを作り、勝ち・分け・負けに足し分ける) */
function referenceRaw(homeLambda, awayLambda, maxGoals, rho) {
  const cap = maxGoals || 8;
  const grid = pm.scoreGrid(homeLambda, awayLambda, cap, rho);
  let pHome = 0, pDraw = 0, pAway = 0;
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      const p = grid[h][a];
      if (h > a) pHome += p;
      else if (h < a) pAway += p;
      else pDraw += p;
    }
  }
  const total = pHome + pDraw + pAway || 1;
  return { homeWin: pHome / total, draw: pDraw / total, awayWin: pAway / total };
}
// 再現できる乱数
let seed = 20261117;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const same = (x, y) => Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y));
const check = (lh, la, cap, rho) => {
  const a = pm.computeMatchProbabilitiesRaw(lh, la, cap, rho), b = referenceRaw(lh, la, cap, rho);
  if (!(same(a.homeWin, b.homeWin) && same(a.draw, b.draw) && same(a.awayWin, b.awayWin))) {
    throw new Error(`違う: λ=${lh},${la} cap=${cap} rho=${rho} → 新 ${JSON.stringify(a)} / 旧 ${JSON.stringify(b)}`);
  }
};

console.log("■ 1. 以前の計算と、1ビットも違わない");
t("ふつうの試合の範囲(期待得点 0.2〜4.0・ρ=0)で 60,000 通り", () => {
  for (let i = 0; i < 60000; i++) check(0.2 + rnd() * 3.8, 0.2 + rnd() * 3.8, undefined, 0);
});
t("低スコア補正つき(ρ = −0.2〜+0.2)で 40,000 通り。上限は 6・8・10 点", () => {
  for (let i = 0; i < 40000; i++) check(0.2 + rnd() * 3.8, 0.2 + rnd() * 3.8, [6, 8, 10, undefined][i % 4], (rnd() - 0.5) * 0.4);
});
t("極端な値(とても小さい・とても大きい期待得点、大きすぎる ρ、上限 1〜16 と 20 点)でも同じ", () => {
  const lams = [0, 1e-9, 0.01, 0.2, 1, 2.5, 4, 9, 25, 80, -1, NaN, Infinity];
  const rhos = [undefined, null, 0, -0.13, 0.5, -3, 3, NaN];
  for (const lh of lams) for (const la of lams) for (const rho of rhos) for (const cap of [undefined, 1, 2, 5, 8, 12, 16, 20]) check(lh, la, cap, rho);
});
t("続けて呼んでも、前の呼び出しの値が混ざらない(作業用の配列を使い回しているため)", () => {
  const first = pm.computeMatchProbabilitiesRaw(1.7, 1.1, 8, -0.1);
  pm.computeMatchProbabilitiesRaw(3.9, 0.2, 12, 0.3); pm.computeMatchProbabilitiesRaw(0.3, 3.3, 4, 0);
  const again = pm.computeMatchProbabilitiesRaw(1.7, 1.1, 8, -0.1);
  assert.deepStrictEqual(again, first);
  // 上限の小さい呼び出しのあとに大きい上限で呼んでも、古い値を読まない
  pm.computeMatchProbabilitiesRaw(2, 2, 16, 0); check(1.2, 0.9, 3, 0); check(1.2, 0.9, 16, -0.05);
});

console.log("■ 2. この関数を使う計算(学習の損失・表示用の確率)も変わらない");
t("表示用の確率(小数1桁の%)と、合計が100%になること", () => {
  const p = pm.computeMatchProbabilities(1.62, 1.08, undefined, -0.08), r = referenceRaw(1.62, 1.08, undefined, -0.08);
  assert.strictEqual(p.homeWinPct, Math.round(r.homeWin * 1000) / 10);
  assert.strictEqual(p.drawPct, Math.round(r.draw * 1000) / 10);
  assert.strictEqual(p.awayWinPct, Math.round(r.awayWin * 1000) / 10);
  const raw = pm.computeMatchProbabilitiesRaw(1.62, 1.08, undefined, -0.08);
  assert.ok(Math.abs(raw.homeWin + raw.draw + raw.awayWin - 1) < 1e-12);
});
t("学習の損失(負の対数尤度)は、以前の計算で求めた値と完全に一致する", () => {
  const records = [];
  for (let i = 0; i < 400; i++) {
    records.push({
      actualWinner: ["home", "draw", "away"][Math.floor(rnd() * 3)],
      features: { formDiff: (rnd() - 0.5) * 3, goalRateDiff: (rnd() - 0.5) * 2, standingsDiff: (rnd() - 0.5) * 2, venueDiff: rnd() - 0.5, attackSum: (rnd() - 0.5) * 2, ratingLambdaDiff: (rnd() - 0.5) * 2 },
    });
  }
  const w = { ...pm.EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.21, goalRateSensitivity: 0.07, standingsSensitivity: 0.15, venueSensitivity: -0.04, attackSumSensitivity: 0.05, ratingSensitivity: 0.3, rho: -0.09 };
  let total = 0;
  for (const r of records) {
    const { homeLambda, awayLambda } = pm.predictOutcomeV2(r.features, w);
    const probs = referenceRaw(homeLambda, awayLambda, undefined, w.rho);
    const pFrac = r.actualWinner === "home" ? probs.homeWin : r.actualWinner === "away" ? probs.awayWin : probs.draw;
    total += -Math.log(Math.max(0.005, pFrac));
  }
  assert.ok(Object.is(pm.computeNegativeLogLikelihood(records, w), total / records.length));
});

console.log("■ 3. 速くなっていること(目安。環境の速さに左右されない比で見る)");
t("以前の計算より 2 倍以上速い(同じ 30,000 回で比べる)", () => {
  const N = 30000; const args = [];
  for (let i = 0; i < N; i++) args.push([0.2 + rnd() * 3.8, 0.2 + rnd() * 3.8, -0.1]);
  const time = (fn) => { const t0 = process.hrtime.bigint(); let s = 0; for (const a of args) s += fn(a[0], a[1], undefined, a[2]).draw; return { ms: Number(process.hrtime.bigint() - t0) / 1e6, s }; };
  time(referenceRaw); time(pm.computeMatchProbabilitiesRaw); // 準備運動
  const oldRun = time(referenceRaw), newRun = time(pm.computeMatchProbabilitiesRaw);
  assert.ok(Object.is(oldRun.s, newRun.s), "合計が一致しない");
  console.log(`      以前 ${oldRun.ms.toFixed(0)}ms → 今回 ${newRun.ms.toFixed(0)}ms(${(oldRun.ms / newRun.ms).toFixed(1)}倍)`);
  assert.ok(newRun.ms * 2 < oldRun.ms, `速くなっていない: 以前 ${oldRun.ms.toFixed(1)}ms / 今回 ${newRun.ms.toFixed(1)}ms`);
});

console.log(`\n=== 結果: ${pass}件成功 / ${fail}件失敗 ===`);
process.exit(fail ? 1 : 0);
