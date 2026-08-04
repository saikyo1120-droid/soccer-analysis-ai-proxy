/**
 * server/learning/dailyJob.js の純粋関数(ネットワーク不要)のユニットテスト。
 */
const assert = require("assert");
const { computeFormScore, predictOutcome, backtestAccuracy, outcomeFromScore, DEFAULT_WEIGHTS } = require("../server/learning/dailyJob");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}`); failures++; }
}

// ---- computeFormScore ----
test("computeFormScore: 直近5試合と前5試合の得失点差の変化を正しく計算する", () => {
  const teamId = 1;
  // 前5試合(6-10番目に新しい): 得失点差 0 ずつ(引き分け続き)
  // 直近5試合: 得失点差 +2 ずつ(好調)
  const fixtures = [];
  const baseDate = new Date("2026-07-30T00:00:00Z");
  for (let i = 0; i < 5; i++) {
    fixtures.push({ fixture: { id: 100 + i, date: new Date(baseDate.getTime() - i * 86400e3).toISOString() }, teams: { home: { id: teamId }, away: { id: 2 } }, goals: { home: 3, away: 1 } }); // diff +2
  }
  for (let i = 5; i < 10; i++) {
    fixtures.push({ fixture: { id: 100 + i, date: new Date(baseDate.getTime() - i * 86400e3).toISOString() }, teams: { home: { id: teamId }, away: { id: 2 } }, goals: { home: 1, away: 1 } }); // diff 0
  }
  const result = computeFormScore(fixtures, teamId);
  assert.strictEqual(result.currentFormScore, 2, "直近5試合の平均得失点差は+2のはず");
  assert.strictEqual(result.delta, 2, "変化量は+2のはず(2 - 0)");
  assert.strictEqual(result.sampleSize, 10);
});

test("computeFormScore: サンプルが5試合未満ならdeltaはnull(過去分が足りない)", () => {
  const teamId = 1;
  const fixtures = [{ fixture: { id: 1, date: "2026-07-30T00:00:00Z" }, teams: { home: { id: teamId }, away: { id: 2 } }, goals: { home: 2, away: 0 } }];
  const result = computeFormScore(fixtures, teamId);
  assert.strictEqual(result.delta, null);
  assert.strictEqual(result.currentFormScore, 2);
});

test("computeFormScore: アウェイ試合の得失点差も正しく反転して計算する", () => {
  const teamId = 5;
  const fixtures = [{ fixture: { id: 1, date: "2026-07-30T00:00:00Z" }, teams: { home: { id: 99 }, away: { id: teamId } }, goals: { home: 1, away: 3 } }];
  const result = computeFormScore(fixtures, teamId);
  assert.strictEqual(result.currentFormScore, 2, "アウェイなので3-1=+2のはず");
});

// ---- predictOutcome ----
test("predictOutcome: フォームが同じなら僅差でホームが有利(ホームアドバンテージ)", () => {
  const { predictedWinner } = predictOutcome(0, 0, DEFAULT_WEIGHTS);
  assert.strictEqual(predictedWinner, "home", "homeBase(1.35) > awayBase(1.15)なのでホーム有利になるはず");
});

test("predictOutcome: アウェイチームのフォームが大幅に良ければアウェイ予想になる", () => {
  const { predictedWinner } = predictOutcome(-3, 3, DEFAULT_WEIGHTS);
  assert.strictEqual(predictedWinner, "away");
});

test("predictOutcome: 僅差なら引き分け予想になる", () => {
  const { predictedWinner } = predictOutcome(0.05, 0, { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.1 });
  assert.strictEqual(predictedWinner, "draw");
});

// ---- backtestAccuracy ----
test("backtestAccuracy: 実際の記録に対する的中率を正しく計算する(架空の数字を作らない)", () => {
  const weights = { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.5 };
  const records = [
    { homeFormScore: 2, awayFormScore: 0, actualWinner: "home" }, // 予測: home (diff=2*0.5=1 > 0.15) → 正解
    { homeFormScore: 0, awayFormScore: 2, actualWinner: "away" }, // 予測: away → 正解
    { homeFormScore: 2, awayFormScore: 0, actualWinner: "away" }, // 予測: home → 不正解
  ];
  const result = backtestAccuracy(records, weights);
  assert.strictEqual(result.sampleSize, 3);
  assert.strictEqual(result.accuracy, Math.round((2 / 3) * 1000) / 10);
});

test("backtestAccuracy: 使えるレコードが無ければnullを返す(架空の精度を出さない)", () => {
  const result = backtestAccuracy([{ homeFormScore: null, awayFormScore: null, actualWinner: null }], DEFAULT_WEIGHTS);
  assert.strictEqual(result, null);
});

// ---- outcomeFromScore ----
test("outcomeFromScore: 基本ケース", () => {
  assert.strictEqual(outcomeFromScore(2, 1), "home");
  assert.strictEqual(outcomeFromScore(1, 2), "away");
  assert.strictEqual(outcomeFromScore(1, 1), "draw");
  assert.strictEqual(outcomeFromScore(null, 1), null);
});

console.log(failures === 0 ? "\nAll pure-function tests PASSED." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
