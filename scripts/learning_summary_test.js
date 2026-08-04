/**
 * 2026年8月・監査対応: 「昨日の学習」ウィジェット(利用者に学習内容を見せる、
 * ご要望⑧)のテスト。
 *   - predictionModel.js の describeWeightsHistoryEntry / buildLearningSummary
 *     が、learn:weights:history の実データ形式から正しく日本語の説明を作れるか
 *   - dailyJob.js の getGrowthLog() が、その要約(learningSummary)と、
 *     「まだ学習に十分なデータが無い」ことを示すフラグ(hasEnoughDataForLearning)
 *     を実際に返すか
 */
const assert = require("assert");
const {
  describeWeightsHistoryEntry, buildLearningSummary, EXTENDED_DEFAULT_WEIGHTS,
} = require("../server/learning/predictionModel");
const { getGrowthLog, MIN_RESOLVED_FOR_RECALIBRATION } = require("../server/learning/dailyJob");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

test("describeWeightsHistoryEntry: 採用された変更(ホーム補正弱め・怪我人重視強め)を正しい日本語にする", () => {
  const entry = {
    date: "2026-08-05", adopted: true, method: "gradient_descent_v2",
    oldWeights: { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.35, injurySensitivity: 0.05 },
    newWeights: { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.20, injurySensitivity: 0.30 },
    oldAccuracy: 55.0, newAccuracy: 63.0, sampleSize: 24,
  };
  const desc = describeWeightsHistoryEntry(entry);
  assert.ok(desc.adopted, "adopted:trueのまま返るはず");
  assert.ok(desc.bullets.some((b) => b.includes("ホームチームの基礎的な強さ") && b.includes("弱めました")), `homeBase低下が「弱めました」と説明されるはず, got: ${JSON.stringify(desc.bullets)}`);
  assert.ok(desc.bullets.some((b) => b.includes("怪我人の影響の重要度") && b.includes("強めました")), `injurySensitivity上昇が「強めました」と説明されるはず, got: ${JSON.stringify(desc.bullets)}`);
  assert.ok(desc.reason.includes("55") && desc.reason.includes("63"), `理由に的中率の変化(55%→63%)が含まれるはず, got: ${desc.reason}`);
});

test("describeWeightsHistoryEntry: 不採用(adopted:false)の場合は変化なしとして正直に返す", () => {
  const entry = {
    date: "2026-08-06", adopted: false, method: "grid_search_v1",
    oldWeights: EXTENDED_DEFAULT_WEIGHTS, newWeights: null,
    oldAccuracy: 50.0, newAccuracy: null, sampleSize: 12,
    note: "既存の重みを上回る候補が見つからなかったため更新なし",
  };
  const desc = describeWeightsHistoryEntry(entry);
  assert.strictEqual(desc.adopted, false);
  assert.strictEqual(desc.bullets.length, 0, "不採用の場合は箇条書きの変化内容は無いはず");
  assert.ok(desc.reason.includes("更新なし"), "不採用の理由(note)がそのまま伝わるはず");
});

test("describeWeightsHistoryEntry: 変化が閾値未満なら空扱いにする(捏造した箇条書きを出さない)", () => {
  const entry = {
    date: "2026-08-07", adopted: true, method: "grid_search_v1",
    oldWeights: { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.350 },
    newWeights: { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.351 }, // ごく僅かな変化
    oldAccuracy: 50.0, newAccuracy: 50.0, sampleSize: 15,
  };
  const desc = describeWeightsHistoryEntry(entry);
  assert.ok(desc.bullets.length === 1 && desc.bullets[0].includes("微調整"), `閾値未満の変化は「微調整」扱いになるはず, got: ${JSON.stringify(desc.bullets)}`);
});

test("buildLearningSummary: 採用分だけを新しい順(直近が先頭)に抽出する", () => {
  const history = [
    { date: "2026-08-01", adopted: true, method: "grid_search_v1", oldWeights: { ...EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.1 }, newWeights: { ...EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.3 }, oldAccuracy: 40, newAccuracy: 50, sampleSize: 10 },
    { date: "2026-08-02", adopted: false, method: "grid_search_v1", oldWeights: EXTENDED_DEFAULT_WEIGHTS, newWeights: null, oldAccuracy: 50, newAccuracy: null, sampleSize: 11 },
    { date: "2026-08-03", adopted: true, method: "gradient_descent_v2", oldWeights: { ...EXTENDED_DEFAULT_WEIGHTS, fatigueSensitivity: 0 }, newWeights: { ...EXTENDED_DEFAULT_WEIGHTS, fatigueSensitivity: 0.2 }, oldAccuracy: 50, newAccuracy: 58, sampleSize: 12 },
  ];
  const summary = buildLearningSummary(history, 5);
  assert.strictEqual(summary.length, 2, "adopted:trueの2件だけが含まれるはず");
  assert.strictEqual(summary[0].date, "2026-08-03", "直近の採用分が先頭に来るはず");
  assert.strictEqual(summary[1].date, "2026-08-01");
});

(async () => {
  await testAsync("getGrowthLog: 学習データがまだ閾値未満の場合、hasEnoughDataForLearning:falseと必要件数を正直に返す", async () => {
    const store = new Map();
    const upstashCmd = async (cmd) => {
      const [op, ...args] = cmd;
      if (op === "LRANGE") return [];
      if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
      return null;
    };
    const log = await getGrowthLog({ upstashEnabled: true, upstashGetJSON: async () => null, upstashCmd });
    assert.strictEqual(log.ranYet, false);
    assert.deepStrictEqual(log.learningSummary, []);
    assert.strictEqual(log.hasEnoughDataForLearning, false);
    assert.strictEqual(log.minResolvedForRecalibration, MIN_RESOLVED_FOR_RECALIBRATION);
  });

  await testAsync("getGrowthLog: weights:historyがあればlearningSummaryとして整形して返す", async () => {
    const historyEntry = {
      date: "2026-08-10", adopted: true, method: "grid_search_v1",
      oldWeights: { ...EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.18 },
      newWeights: { ...EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.40 },
      oldAccuracy: 45, newAccuracy: 55, sampleSize: 30,
    };
    const upstashCmd = async (cmd) => {
      const [op, args1] = [cmd[0], cmd[1]];
      if (op === "LRANGE" && args1 === "learn:weights:history") return [JSON.stringify(historyEntry)];
      if (op === "GET" && args1 === "learn:ownpred:resolved") return "30";
      return null;
    };
    const log = await getGrowthLog({
      upstashEnabled: true,
      upstashGetJSON: async (k) => (k === "learn:growthlog:latest" ? { date: "2026-08-10", factsAddedToday: 3, facts: [], errors: [] } : null),
      upstashCmd,
    });
    assert.strictEqual(log.ranYet, true);
    assert.strictEqual(log.learningSummary.length, 1);
    assert.ok(log.learningSummary[0].bullets.some((b) => b.includes("フォーム")), `フォームの重要度変化が含まれるはず, got: ${JSON.stringify(log.learningSummary[0].bullets)}`);
    assert.strictEqual(log.hasEnoughDataForLearning, true, "30件resolved(閾値10件以上)なのでtrueのはず");
    assert.strictEqual(log.totalOwnPredictionsResolvedSoFar, 30);
  });

  await testAsync("getGrowthLog: 「AIの成長レポート」用にKnowledge/Prediction/Memory各エンジンの累計件数(engineTotals)を軽量カウンターから返す", async () => {
    const counters = {
      "knowledge:totalItemsSavedCounter": "42",
      "memory:totalConclusionsSavedCounter": "7",
      "learn:ownpred:total": "15",
    };
    const upstashCmd = async (cmd) => {
      const [op, key] = cmd;
      if (op === "LRANGE") return [];
      if (op === "GET") return Object.prototype.hasOwnProperty.call(counters, key) ? counters[key] : null;
      return null;
    };
    const log = await getGrowthLog({ upstashEnabled: true, upstashGetJSON: async () => null, upstashCmd });
    assert.deepStrictEqual(log.engineTotals, { knowledgeItemsTotal: 42, memoryConclusionsTotal: 7, predictionsTotal: 15 }, `engineTotalsが軽量カウンターの値をそのまま返すはず, got: ${JSON.stringify(log.engineTotals)}`);
  });

  await testAsync("getGrowthLog: カウンターが未設定(まだ一度も保存されていない)場合は正直に0を返す(でっち上げない)", async () => {
    const upstashCmd = async (cmd) => (cmd[0] === "LRANGE" ? [] : null);
    const log = await getGrowthLog({ upstashEnabled: true, upstashGetJSON: async () => null, upstashCmd });
    assert.deepStrictEqual(log.engineTotals, { knowledgeItemsTotal: 0, memoryConclusionsTotal: 0, predictionsTotal: 0 });
  });

  console.log(failures === 0 ? "\nlearning summary widget tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
