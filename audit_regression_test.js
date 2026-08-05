/**
 * 2026年8月・総点検(全実装の品質チェック)で発見した重大な欠陥の再発防止テスト。
 *
 * ここで検証している欠陥は、いずれも「テストは全部通るのに、本番では機能が
 * 死んでいる」種類のものだった。同じことを繰り返さないため、修正内容を
 * そのままテストとして固定する。
 */
const assert = require("assert");
const { HYPOTHESIS_FACTORS, generateHypotheses } = require("../server/reasoning/hypothesisGenerator");
const { deliberate, buildCounterArgument, compareHypotheses } = require("../server/reasoning/deliberation");
const { computeStandingsFeature, computeXgFromFixtureStats } = require("../server/learning/features");
const { buildDailySnapshot, compareSnapshots } = require("../server/learning/dailyMetrics");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}`); failures++; }
}

// ---- 欠陥1: 蓄積した知識が推論に一度も使われていなかった ----
// HYPOTHESIS_FACTORS の relevantCategories が、dailyJob.js が実際に保存している
// category 文字列と一致しておらず、全仮説のスコアが常に0だった。
const ACTUALLY_SAVED_CATEGORIES = [
  "recentFormTrend", "coachChange", "transferImpact", "matchReflection",
  "predictionFailureReason", "predictionSuccessReason", "dailyAiView",
  "playstyleAnalysis", "predictionHypothesis", "predictionContextualFailure",
];

test("★欠陥1: dailyJobが実際に保存する全categoryが、いずれかの仮説観点に結び付いている", () => {
  const covered = new Set(HYPOTHESIS_FACTORS.flatMap((f) => f.relevantCategories));
  const orphans = ACTUALLY_SAVED_CATEGORIES.filter((c) => !covered.has(c));
  assert.deepStrictEqual(orphans, [],
    "Knowledge Engineへ保存しているのに推論で一度も使われないcategoryがある: " + orphans.join(", "));
});

test("★欠陥1: 実際に保存される形の知識から、根拠付きの仮説が生成される", () => {
  const pool = [
    { category: "recentFormTrend", type: "fact", statement: "直近5試合の得失点差が上昇。" },
    { category: "coachChange", type: "fact", statement: "監督が交代した。" },
    { category: "transferImpact", type: "fact", statement: "主力を補強した。" },
  ];
  const hypotheses = generateHypotheses(pool, { teamJa: "テストFC", teamEn: "Test FC" });
  const scored = hypotheses.filter((h) => (h.evidence || []).length > 0);
  assert.ok(scored.length >= 3, "3件の知識が3つの観点に結び付くはず, got " + scored.length);
});

// ---- 欠陥2: 「昨日より賢くなったか」の判定が永久に「変化なし」だった ----
// engineTotals が runDailyLearning の growthLog に含まれず、毎日0が保存されていた。
test("★欠陥2: engineTotalsを渡せば、累計が0ではなく実値として記録される", () => {
  const snap = buildDailySnapshot(
    { date: "2026-08-20", engineTotals: { knowledgeItemsTotal: 320, memoryConclusionsTotal: 150, predictionsTotal: 40 } },
    { learningDurationMs: 1000 }
  );
  assert.strictEqual(snap.knowledgeTotal, 320);
  assert.strictEqual(snap.memoryTotal, 150);
  assert.strictEqual(snap.predictionsTotal, 40);
});

test("★欠陥2: 累計が0のままだと「変化なし」としか言えなくなることを固定する", () => {
  const zero = buildDailySnapshot({ date: "d1" }, {});
  const alsoZero = buildDailySnapshot({ date: "d2" }, {});
  const c = compareSnapshots(alsoZero, zero);
  assert.strictEqual(c.improved, null, "累計0同士では成長を判定できない(これが本番で起きていた状態)");
  const grown = buildDailySnapshot({ date: "d2", engineTotals: { knowledgeItemsTotal: 320, memoryConclusionsTotal: 150 } }, {});
  const base = buildDailySnapshot({ date: "d1", engineTotals: { knowledgeItemsTotal: 300, memoryConclusionsTotal: 145 } }, {});
  const c2 = compareSnapshots(grown, base);
  assert.strictEqual(c2.improved, true, "実値が入れば成長を正しく判定できるはず");
  assert.strictEqual(c2.knowledgeDelta, 20);
});

// ---- 欠陥3: 根拠0でも「最も重要だと考えます」と断定していた ----
test("★欠陥3: 全仮説のスコアが0なら、断定せず正直に保留する", () => {
  const r = deliberate({
    ranked: [{ label: "怪我・出場停止", score: 0, statement: "情報は見当たらなかった。", evidence: [] }],
    dataAvailability: {},
  });
  assert.ok(!/最も重要だと考えます/.test(r.finalConclusionJa),
    "根拠0で断定してはいけない: " + r.finalConclusionJa);
  assert.ok(r.finalConclusionJa.includes("確かなことを申し上げられない"), r.finalConclusionJa);
});

test("★欠陥3: 根拠が無い状態を「反対意見が無い＝強い」と偽らない", () => {
  const c = compareHypotheses([{ label: "A", score: 0, statement: "x", evidence: [] }]);
  const ca = buildCounterArgument(c);
  assert.ok(!ca.statementJa.includes("根拠の強さ"),
    "データが無いことを強みのように見せてはいけない: " + ca.statementJa);
  assert.ok(ca.statementJa.includes("不足"), ca.statementJa);
});

test("根拠があれば従来どおり断定できる(過剰な保守化をしていない)", () => {
  const r = deliberate({
    ranked: [{ label: "怪我人", score: 6, statement: "主力2名を欠いています。", evidence: [{ type: "fact" }, { type: "fact" }, { type: "fact" }] }],
    dataAvailability: { form: true, goals: true, standings: true, injuries: true },
  });
  assert.ok(/私は「怪我人」がこの分析で最も重要だと考えます/.test(r.finalConclusionJa), r.finalConclusionJa);
});

// ---- 欠陥4: NaNが特徴量として流れていた ----
test("★欠陥4: 順位表にgoalsが無くてもNaNにならず、正直にnullを返す", () => {
  const r = computeStandingsFeature([{ league: { standings: [[{ rank: 1, team: { id: 5 }, points: 10, all: { played: 5 } }]] } }], 5);
  assert.strictEqual(r.goalsForAvg, null, "NaNではなくnullのはず, got " + r.goalsForAvg);
  assert.ok(!Number.isNaN(r.goalsForAvg));
  assert.ok(!Number.isNaN(r.goalsAgainstAvg));
});

test("goalsが正しくあれば従来どおり平均を計算する", () => {
  const r = computeStandingsFeature([{ league: { standings: [[{ rank: 1, team: { id: 5 }, points: 10, all: { played: 5, goals: { for: 10, against: 5 } } }]] } }], 5);
  assert.strictEqual(r.goalsForAvg, 2);
  assert.strictEqual(r.goalsAgainstAvg, 1);
});

// ---- 欠陥5: 無関係なチームのxGを自チームのxGAとして拾っていた ----
test("★欠陥5: 対象チームが統計に含まれなければ、両方nullを返す", () => {
  const r = computeXgFromFixtureStats([{ team: { id: 99 }, statistics: [{ type: "expected_goals", value: "2.1" }] }], 10);
  assert.strictEqual(r.xg, null);
  assert.strictEqual(r.xga, null, "無関係なチームのxGを自チームのxGAにしてはいけない, got " + r.xga);
});

test("対象チームが含まれていれば従来どおり自他のxGを取り出す", () => {
  const r = computeXgFromFixtureStats([
    { team: { id: 10 }, statistics: [{ type: "expected_goals", value: "1.8" }] },
    { team: { id: 20 }, statistics: [{ type: "expected_goals", value: "0.6" }] },
  ], 10);
  assert.strictEqual(r.xg, 1.8);
  assert.strictEqual(r.xga, 0.6);
});

console.log(failures === 0 ? "\nAll audit-regression tests PASSED." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
