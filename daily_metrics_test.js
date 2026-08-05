/**
 * 2026年8月・完全自動Learning Cycle ⑧「毎日賢くなっていることを証明してください」
 * (server/learning/dailyMetrics.js)と、⑧「成功した理由も分析」
 * (predictionModel.js の classifySuccessReasons)のテスト。
 *
 * 最重要の検証点は「賢くなった」と言い切る条件が実データの差分だけに基づくこと。
 * 検証データが足りない・変化が無いときに『成長した』と偽らないことを重点的に見る。
 */
const assert = require("assert");
const {
  buildDailySnapshot, saveDailyMetrics, getMetricsTrend, compareSnapshots, METRICS_KEY_PREFIX,
} = require("../server/learning/dailyMetrics");
const { classifySuccessReasons, summarizeSuccessReasons } = require("../server/learning/predictionModel");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

function createMockRedis() {
  const store = new Map();
  return {
    store,
    upstashGetJSON: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
    upstashSetJSON: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
  };
}

const SAMPLE_LOG = {
  date: "2026-08-05", ranAt: "2026-08-05T03:54:00Z",
  teamsAnalyzed: 11, leaguesAnalyzedToday: 10, playersCheckedToday: 107,
  knowledgeItemsSavedToday: 15, knowledgeItemsDuplicateToday: 220,
  matchesResolvedToday: 4, newPredictionsLogged: 6,
  ownAccuracyBefore: 50, ownAccuracyAfter: 55,
  totalOwnPredictionsResolvedSoFar: 24, weightsUpdated: true, weightsUpdatedV2: false,
  hypothesesConfirmed: 2, hypothesesDiscarded: 1, reflectionsSaved: 4,
  failureReasonsToday: [{ id: "a" }, { id: "b" }],
  successReasonsToday: [{ id: "c" }],
  topFailureReasonsRecent: [{ labelJa: "ホーム補正が強すぎた", count: 3 }],
  topSuccessReasonsRecent: [{ labelJa: "直近フォームの差を正しく評価できた", count: 5 }],
  engineTotals: { knowledgeItemsTotal: 320, memoryConclusionsTotal: 150, predictionsTotal: 40 },
  apiBudget: { totalSpent: 512 },
  errors: ["x"], runsToday: 1,
};

(async () => {
  // ---- スナップショットの組み立て ----
  await test("buildDailySnapshot: ご要望の6指標をすべて記録する", () => {
    const s = buildDailySnapshot(SAMPLE_LOG, { learningDurationMs: 45000 });
    assert.strictEqual(s.predictionAccuracy, 55, "Prediction Accuracy");
    assert.strictEqual(s.knowledgeTotal, 320, "Knowledge Count");
    assert.strictEqual(s.memoryTotal, 150, "Memory Count");
    assert.strictEqual(s.failureReasonsToday, 2, "Failure Learning");
    assert.strictEqual(s.weightsUpdated, true, "Weight Update");
    assert.strictEqual(s.learningDurationMs, 45000, "Learning Time");
  });

  await test("buildDailySnapshot: 取得量(クラブ/リーグ/選手)と成功理由も記録する", () => {
    const s = buildDailySnapshot(SAMPLE_LOG, {});
    assert.strictEqual(s.clubsAnalyzed, 11);
    assert.strictEqual(s.leaguesAnalyzed, 10);
    assert.strictEqual(s.playersAnalyzed, 107);
    assert.strictEqual(s.successReasonsToday, 1);
    assert.strictEqual(s.apiRequestsUsed, 512);
    assert.strictEqual(s.topSuccessReasons[0].labelJa, "直近フォームの差を正しく評価できた");
  });

  await test("buildDailySnapshot: 項目が欠けたgrowthLogでも例外を投げず0/nullで返す", () => {
    const s = buildDailySnapshot({}, {});
    assert.strictEqual(s.knowledgeTotal, 0);
    assert.strictEqual(s.predictionAccuracy, null, "的中率は不明ならnull(0とごまかさない)");
    assert.strictEqual(s.learningDurationMs, null);
  });

  // ---- 「昨日より賢くなったか」の判定 ----
  await test("compareSnapshots: 前日の記録が無ければ「比較できない」と正直に返す", () => {
    const c = compareSnapshots(buildDailySnapshot(SAMPLE_LOG, {}), null);
    assert.strictEqual(c.hasBaseline, false);
    assert.strictEqual(c.improved, null, "根拠が無いのに『賢くなった』と言ってはいけない");
    assert.ok(c.verdictJa.includes("前日の記録がまだありません"), c.verdictJa);
  });

  await test("compareSnapshots: 知識・記憶・的中率が増えていれば「賢くなった」と根拠つきで言い切る", () => {
    const today = buildDailySnapshot(SAMPLE_LOG, {});
    const yesterday = { ...today, knowledgeTotal: 300, memoryTotal: 145, predictionAccuracy: 50, weightsUpdated: false };
    const c = compareSnapshots(today, yesterday);
    assert.strictEqual(c.improved, true);
    assert.strictEqual(c.knowledgeDelta, 20);
    assert.strictEqual(c.memoryDelta, 5);
    assert.strictEqual(c.accuracyDelta, 5);
    assert.ok(c.verdictJa.includes("昨日より賢くなりました"), c.verdictJa);
    assert.ok(c.verdictJa.includes("20件"), "増えた件数を根拠として示すはず: " + c.verdictJa);
  });

  await test("compareSnapshots: 何も変わらなかった日は「賢くなった」と偽らず、異常でもないと説明する", () => {
    const today = buildDailySnapshot({ ...SAMPLE_LOG, weightsUpdated: false, failureReasonsToday: [], successReasonsToday: [] }, {});
    const yesterday = { ...today };
    const c = compareSnapshots(today, yesterday);
    assert.strictEqual(c.improved, null, "変化が無い日を『成長した』としてはいけない");
    assert.ok(c.verdictJa.includes("変化がありませんでした"), c.verdictJa);
    assert.ok(c.verdictJa.includes("異常ではありません"), "利用者を不安にさせない説明も添えるはず");
  });

  await test("compareSnapshots: 的中率が下がった日は、悪化を隠さず正直に報告する", () => {
    const today = buildDailySnapshot({ ...SAMPLE_LOG, ownAccuracyAfter: 45, weightsUpdated: false, failureReasonsToday: [], successReasonsToday: [] }, {});
    const yesterday = { ...today, predictionAccuracy: 55, knowledgeTotal: today.knowledgeTotal, memoryTotal: today.memoryTotal };
    const c = compareSnapshots(today, yesterday);
    assert.strictEqual(c.improved, false);
    assert.ok(c.verdictJa.includes("下がりました"), c.verdictJa);
  });

  await test("compareSnapshots: 知識は増えたが的中率が下がった場合、良い点だけを並べて悪化を隠さない", () => {
    const today = buildDailySnapshot({ ...SAMPLE_LOG, ownAccuracyAfter: 45 }, {});
    const yesterday = { ...today, knowledgeTotal: 300, predictionAccuracy: 55 };
    const c = compareSnapshots(today, yesterday);
    assert.strictEqual(c.improved, true);
    assert.ok(c.verdictJa.includes("ただし"), "悪化も併記するはず: " + c.verdictJa);
    assert.ok(c.verdictJa.includes("下がりました"), c.verdictJa);
  });

  // ---- 保存と読み出し ----
  await test("saveDailyMetrics / getMetricsTrend: 保存した指標を日付つきで読み出せる", async () => {
    const mock = createMockRedis();
    const deps = { upstashEnabled: true, ...mock };
    await saveDailyMetrics(deps, buildDailySnapshot({ ...SAMPLE_LOG, date: "2026-08-05" }, { learningDurationMs: 1000 }));
    assert.ok(mock.store.has(`${METRICS_KEY_PREFIX}2026-08-05`), "指標が保存されるはず");
    const t = await getMetricsTrend(deps, 3, "2026-08-05");
    assert.strictEqual(t.available, true);
    assert.strictEqual(t.days[0].recorded, true);
    assert.strictEqual(t.days[1].recorded, false, "記録の無い日は推測で埋めないはず");
    assert.strictEqual(t.recordedDays, 1);
  });

  await test("getMetricsTrend: 2日分あれば前日との差分が自動で計算される", async () => {
    const mock = createMockRedis();
    const deps = { upstashEnabled: true, ...mock };
    await saveDailyMetrics(deps, buildDailySnapshot({ ...SAMPLE_LOG, date: "2026-08-04", engineTotals: { knowledgeItemsTotal: 300, memoryConclusionsTotal: 145 }, ownAccuracyAfter: 50 }, {}));
    await saveDailyMetrics(deps, buildDailySnapshot({ ...SAMPLE_LOG, date: "2026-08-05" }, {}));
    const t = await getMetricsTrend(deps, 3, "2026-08-05");
    assert.strictEqual(t.days[0].knowledgeDelta, 20, "前日比+20のはず");
    assert.strictEqual(t.days[0].accuracyDelta, 5);
    assert.strictEqual(t.comparison.improved, true);
    assert.ok(t.comparison.verdictJa.includes("昨日より賢くなりました"), t.comparison.verdictJa);
  });

  await test("getMetricsTrend: 期間全体での伸び(rangeGrowth)も返す", async () => {
    const mock = createMockRedis();
    const deps = { upstashEnabled: true, ...mock };
    await saveDailyMetrics(deps, buildDailySnapshot({ ...SAMPLE_LOG, date: "2026-08-03", engineTotals: { knowledgeItemsTotal: 100, memoryConclusionsTotal: 50 } }, {}));
    await saveDailyMetrics(deps, buildDailySnapshot({ ...SAMPLE_LOG, date: "2026-08-04", engineTotals: { knowledgeItemsTotal: 200, memoryConclusionsTotal: 100 } }, {}));
    await saveDailyMetrics(deps, buildDailySnapshot({ ...SAMPLE_LOG, date: "2026-08-05", engineTotals: { knowledgeItemsTotal: 320, memoryConclusionsTotal: 150 } }, {}));
    const t = await getMetricsTrend(deps, 5, "2026-08-05");
    assert.strictEqual(t.rangeGrowth.knowledge, 220, "8/3の100から8/5の320で+220のはず");
    assert.strictEqual(t.rangeGrowth.memory, 100);
    assert.strictEqual(t.rangeGrowth.fromDate, "2026-08-03");
    assert.strictEqual(t.rangeGrowth.toDate, "2026-08-05");
  });

  await test("getMetricsTrend: Upstash未設定なら、読めないことを正直に返す", async () => {
    const t = await getMetricsTrend({ upstashEnabled: false }, 7, "2026-08-05");
    assert.strictEqual(t.available, false);
    assert.ok(t.reasonJa.includes("Upstash"), t.reasonJa);
  });

  // ---- 成功理由の分析(⑧「成功した理由も分析」) ----
  const WEIGHTS = { homeBase: 1.5, awayBase: 1.1, sensitivity: 0.2, goalRateSensitivity: 0.1, injurySensitivity: 0, standingsSensitivity: 0, headToHeadSensitivity: 0, fatigueSensitivity: 0 };

  await test("classifySuccessReasons: 外れた予測には成功理由を付けない(空配列)", () => {
    const r = classifySuccessReasons({ correct: false, predictedWinner: "home", actualWinner: "away", features: {} }, WEIGHTS);
    assert.deepStrictEqual(r, []);
  });

  await test("classifySuccessReasons: 当たった予測は「なぜ当たったか」を要因つきで返す", () => {
    const r = classifySuccessReasons({
      correct: true, predictedWinner: "home", actualWinner: "home",
      features: { formDiff: 1.2, goalRateDiff: 0.8, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
    }, WEIGHTS);
    assert.ok(r.length > 0, "理由が返るはず");
    const ids = r.map((x) => x.id);
    assert.ok(ids.includes("formDiff_worked") || ids.includes("home_bonus_worked"), JSON.stringify(ids));
    assert.ok(r.every((x) => x.labelJa && x.detail), "すべてに説明文があるはず");
  });

  await test("classifySuccessReasons: 重みが0の特徴量は「正しく評価できた」に数えない(まだ学習していないため)", () => {
    const r = classifySuccessReasons({
      correct: true, predictedWinner: "away", actualWinner: "away",
      features: { formDiff: 0, goalRateDiff: 0, injuryDiff: -5, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
    }, WEIGHTS);
    assert.ok(!r.some((x) => x.id === "injuryDiff_worked"), "重み0の要素を手柄にしてはいけない: " + JSON.stringify(r));
    assert.strictEqual(r[0].id, "overall_judgement", "決め手が無ければ正直にそう返すはず");
  });

  await test("classifySuccessReasons: 決め手が特定できない場合は、無理に理由を作らず正直に返す", () => {
    const r = classifySuccessReasons({
      correct: true, predictedWinner: "draw", actualWinner: "draw",
      features: { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
    }, WEIGHTS);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, "overall_judgement");
    assert.ok(r[0].labelJa.includes("特定できません"), r[0].labelJa);
  });

  await test("classifySuccessReasons: 理由は最大3件までに絞る(表示が長くなりすぎないように)", () => {
    const allWeights = { homeBase: 1.5, awayBase: 1.1, sensitivity: 0.2, goalRateSensitivity: 0.2, injurySensitivity: 0.2, standingsSensitivity: 0.2, headToHeadSensitivity: 0.2, fatigueSensitivity: 0.2 };
    const r = classifySuccessReasons({
      correct: true, predictedWinner: "home", actualWinner: "home",
      features: { formDiff: 1, goalRateDiff: 1, injuryDiff: 1, standingsDiff: 1, headToHeadDiff: 1, fatigueDiff: 1 },
    }, allWeights);
    assert.ok(r.length <= 3, "3件以内のはず, got " + r.length);
  });

  await test("summarizeSuccessReasons: 頻度順に集計し、外れた記録は無視する", () => {
    const recs = [
      { correct: true, successReasons: [{ id: "formDiff_worked", labelJa: "直近フォームの差を正しく評価できた" }] },
      { correct: true, successReasons: [{ id: "formDiff_worked", labelJa: "直近フォームの差を正しく評価できた" }] },
      { correct: true, successReasons: [{ id: "home_bonus_worked", labelJa: "ホームアドバンテージを正しく評価できた" }] },
      { correct: false, successReasons: [{ id: "formDiff_worked", labelJa: "x" }] },
    ];
    const s = summarizeSuccessReasons(recs, 5);
    assert.strictEqual(s[0].id, "formDiff_worked");
    assert.strictEqual(s[0].count, 2, "外れた記録は数に入れないはず");
    assert.strictEqual(s[1].count, 1);
  });

  console.log(failures === 0 ? "\nAll daily-metrics / success-reason tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
