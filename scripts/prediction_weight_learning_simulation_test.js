/**
 * 2026年8月・優先順位② 完了確認テスト。
 *
 * ご指定の検証:
 *   「xGとエースの得点力の実データ供給を行い、②を完全に閉じる。
 *     その後、新しい特徴量が実際に学習されて重みが0から動くかを、
 *     多日間シミュレーションで検証してください」
 *
 * このテストは2部構成:
 *   第1部: xG・エースの得点力が、実データ(モックAPI)から本当に供給されるか
 *   第2部: 新しい特徴量の重みが 0 → 0以外 へ、実際の学習で動くか(多日間)
 *
 * 重要な考え方: 「重みが0から動けば良い」わけではない。
 * このプロジェクトは「的中率が本当に改善する場合だけ採用する」設計なので、
 * 動いた場合はその条件を満たしていることまで確認する。
 */
const assert = require("assert");
const {
  computeXgFromFixtureStats, fetchTeamXgAverage, pickTeamTopScorer,
} = require("../server/learning/features");
const {
  EXTENDED_DEFAULT_WEIGHTS, fitWeightsGradientDescent, backtestAccuracyV2, predictOutcomeV2,
} = require("../server/learning/predictionModel");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

// ============================================================
// 第1部: xG・エースの得点力の実データ供給
// ============================================================

const XG_STATS_RESPONSE = [
  { team: { id: 10, name: "Home FC" }, statistics: [{ type: "Shots on Goal", value: 6 }, { type: "expected_goals", value: "1.85" }] },
  { team: { id: 20, name: "Away FC" }, statistics: [{ type: "Shots on Goal", value: 3 }, { type: "expected_goals", value: "0.62" }] },
];

(async () => {
  await test("computeXgFromFixtureStats: 自チームのxGと、相手のxG(=自チームのxGA)を正しく取り出す", () => {
    const r = computeXgFromFixtureStats(XG_STATS_RESPONSE, 10);
    assert.strictEqual(r.xg, 1.85, "自チームのxG");
    assert.strictEqual(r.xga, 0.62, "相手のxGが自チームのxGA");
    const opp = computeXgFromFixtureStats(XG_STATS_RESPONSE, 20);
    assert.strictEqual(opp.xg, 0.62);
    assert.strictEqual(opp.xga, 1.85);
  });

  await test("computeXgFromFixtureStats: 表記ゆれ(expected goals / Expected_Goals)にも対応する", () => {
    for (const type of ["expected goals", "Expected_Goals", "EXPECTED GOALS"]) {
      const r = computeXgFromFixtureStats([{ team: { id: 10 }, statistics: [{ type, value: "1.2" }] }, { team: { id: 20 }, statistics: [] }], 10);
      assert.strictEqual(r.xg, 1.2, `${type} を認識できるはず`);
    }
  });

  await test("computeXgFromFixtureStats: xGを提供していないリーグではnullを返す(0でごまかさない)", () => {
    const r = computeXgFromFixtureStats([
      { team: { id: 10 }, statistics: [{ type: "Shots on Goal", value: 6 }] },
      { team: { id: 20 }, statistics: [{ type: "Shots on Goal", value: 3 }] },
    ], 10);
    assert.strictEqual(r.xg, null, "0を入れると『チャンスの質が最低』と誤解釈されるためnullのはず");
    assert.strictEqual(r.xga, null);
  });

  await test("computeXgFromFixtureStats: 値がnull/空文字でもnullとして扱い、NaNを作らない", () => {
    for (const value of [null, "", undefined, "abc"]) {
      const r = computeXgFromFixtureStats([{ team: { id: 10 }, statistics: [{ type: "expected_goals", value }] }, { team: { id: 20 }, statistics: [] }], 10);
      assert.strictEqual(r.xg, null, `value=${JSON.stringify(value)} はnullのはず`);
    }
  });

  function makeFixtures(n) {
    const now = Date.now();
    const list = [];
    for (let i = 0; i < n; i++) {
      list.push({ fixture: { id: 700 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: 10 }, away: { id: 20 } }, goals: { home: 2, away: 1 } });
    }
    return list;
  }

  await test("fetchTeamXgAverage: 直近の試合からxG・xGA・その差(xgNet)を平均して返す", async () => {
    const calls = [];
    const api = async (ep, p) => { calls.push({ ep, p }); return { response: XG_STATS_RESPONSE }; };
    const r = await fetchTeamXgAverage(makeFixtures(5), 10, api, { limit: 5 });
    assert.strictEqual(r.xgFor, 1.85);
    assert.strictEqual(r.xgAgainst, 0.62);
    assert.strictEqual(r.xgNet, 1.23, "1.85 - 0.62 = 1.23");
    assert.strictEqual(r.sampleSize, 5);
    assert.strictEqual(calls.length, 5, "1試合1リクエストのはず");
    assert.ok(calls.every((c) => c.ep === "/fixtures/statistics"));
  });

  await test("fetchTeamXgAverage: limitを超えて試合を取りに行かない(API予算の保護)", async () => {
    const calls = [];
    const api = async () => { calls.push(1); return { response: XG_STATS_RESPONSE }; };
    await fetchTeamXgAverage(makeFixtures(30), 10, api, { limit: 3 });
    assert.strictEqual(calls.length, 3, "limit=3を超えて呼んではいけない, got " + calls.length);
  });

  await test("fetchTeamXgAverage: 予算が尽きたら取得を見送り、理由を正直に残す", async () => {
    const calls = [];
    const api = async () => { calls.push(1); return { response: XG_STATS_RESPONSE }; };
    const r = await fetchTeamXgAverage(makeFixtures(5), 10, api, { limit: 5, canSpend: () => false });
    assert.strictEqual(calls.length, 0, "予算が無ければ1回も呼ばないはず");
    assert.strictEqual(r.xgNet, null);
    assert.ok(r.reasonJa.includes("予算"), r.reasonJa);
    assert.ok(r.reasonJa.includes("明日"), "明日再試行することを伝えるはず: " + r.reasonJa);
  });

  await test("fetchTeamXgAverage: xG非提供リーグでは、その旨を理由として残す", async () => {
    const api = async () => ({ response: [{ team: { id: 10 }, statistics: [{ type: "Shots on Goal", value: 5 }] }, { team: { id: 20 }, statistics: [] }] });
    const r = await fetchTeamXgAverage(makeFixtures(3), 10, api, { limit: 3 });
    assert.strictEqual(r.xgNet, null);
    assert.ok(r.reasonJa.includes("提供していない"), r.reasonJa);
  });

  await test("fetchTeamXgAverage: 一部の試合で取得に失敗しても、残りで平均を出す(全滅させない)", async () => {
    let n = 0;
    const api = async () => { n++; if (n === 1) throw new Error("boom"); return { response: XG_STATS_RESPONSE }; };
    const r = await fetchTeamXgAverage(makeFixtures(3), 10, api, { limit: 3 });
    assert.strictEqual(r.sampleSize, 2, "1件失敗しても残り2件で平均するはず");
    assert.strictEqual(r.xgNet, 1.23);
  });

  await test("pickTeamTopScorer: そのチームの得点ランキング上位選手の得点数を取り出す", () => {
    const p = pickTeamTopScorer([
      { player: { name: "Other" }, statistics: [{ team: { id: 99 }, goals: { total: 30, assists: 2 } }] },
      { player: { name: "Ace" }, statistics: [{ team: { id: 10 }, goals: { total: 18, assists: 7 } }] },
    ], 10);
    assert.strictEqual(p.name, "Ace");
    assert.strictEqual(p.goals, 18);
  });

  await test("pickTeamTopScorer: ランキングにそのチームの選手がいなければnull(でっち上げない)", () => {
    assert.strictEqual(pickTeamTopScorer([{ player: { name: "X" }, statistics: [{ team: { id: 99 }, goals: { total: 5 } }] }], 10), null);
  });

  // ============================================================
  // 第2部: 新しい特徴量の重みが 0 から動くか(多日間シミュレーション)
  // ============================================================

  /**
   * 「ホーム/アウェイ別の成績(venueDiff)だけが結果を決めている」実データを作る。
   * 既存の特徴量(formDiff等)はわざとノイズにしてあるので、
   * 学習が正しく働けば venueSensitivity だけが 0 から動くはず。
   */
  function makeVenueDrivenRecords(count) {
    const records = [];
    for (let i = 0; i < count; i++) {
      const homeStrongAtHome = i % 2 === 0;
      const venueDiff = homeStrongAtHome ? 0.7 : -0.7;
      records.push({
        fixtureId: 5000 + i,
        actualWinner: homeStrongAtHome ? "home" : "away",
        features: {
          // 既存の特徴量は結果と無相関のノイズ(これらを学習しても当たらない)
          formDiff: (i % 3) - 1,
          goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0,
          // 新しい特徴量だけが結果を完全に説明する
          venueDiff,
          suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0,
        },
      });
    }
    return records;
  }

  await test("【学習前】新しい特徴量の重みは0で、予測に一切効いていない", () => {
    assert.strictEqual(EXTENDED_DEFAULT_WEIGHTS.venueSensitivity, 0);
    const recs = makeVenueDrivenRecords(40);
    const before = backtestAccuracyV2(recs, EXTENDED_DEFAULT_WEIGHTS);
    // venueDiffを無視しているので、当たるのは偶然の範囲にとどまるはず
    assert.ok(before.accuracy < 70, `学習前の的中率は低いはず, got ${before.accuracy}%`);
    console.log(`        → 学習前: venueSensitivity=0 / 的中率 ${before.accuracy}%`);
  });

  await test("★【学習後】新しい特徴量の重みが 0 から実際に動き、的中率が改善する", () => {
    const recs = makeVenueDrivenRecords(40);
    const before = backtestAccuracyV2(recs, EXTENDED_DEFAULT_WEIGHTS);
    const fitted = fitWeightsGradientDescent(recs, EXTENDED_DEFAULT_WEIGHTS, { iterations: 120, learningRate: 0.25 });
    assert.ok(fitted, "学習結果が返るはず(データ不足ならnull)");
    const after = backtestAccuracyV2(recs, fitted);

    assert.notStrictEqual(fitted.venueSensitivity, 0,
      "venueSensitivity が 0 のままでは、新しい特徴量が学習されていない");
    assert.ok(Math.abs(fitted.venueSensitivity) > 0.01,
      `意味のある大きさまで動くはず, got ${fitted.venueSensitivity}`);
    assert.ok(after.accuracy > before.accuracy,
      `学習後は的中率が改善するはず (${before.accuracy}% → ${after.accuracy}%)`);
    console.log(`        → 学習後: venueSensitivity=${fitted.venueSensitivity.toFixed(4)} / 的中率 ${before.accuracy}% → ${after.accuracy}%`);
  });

  await test("★【学習後】xG・出場停止・エースの得点力も、結果を説明するデータがあれば重みが動く", () => {
    const cases = [
      { key: "xgDiff", weightKey: "xgSensitivity", magnitude: 1.4 },
      { key: "suspensionDiff", weightKey: "suspensionSensitivity", magnitude: 3 },
      { key: "topScorerDiff", weightKey: "topScorerSensitivity", magnitude: 10 },
    ];
    for (const c of cases) {
      const recs = [];
      for (let i = 0; i < 40; i++) {
        const homeFavoured = i % 2 === 0;
        const f = { formDiff: (i % 3) - 1, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0 };
        f[c.key] = homeFavoured ? c.magnitude : -c.magnitude;
        recs.push({ fixtureId: 6000 + i, actualWinner: homeFavoured ? "home" : "away", features: f });
      }
      const fitted = fitWeightsGradientDescent(recs, EXTENDED_DEFAULT_WEIGHTS, { iterations: 120, learningRate: 0.25 });
      assert.notStrictEqual(fitted[c.weightKey], 0, `${c.weightKey} が 0 から動くはず`);
      console.log(`        → ${c.weightKey}: 0 → ${fitted[c.weightKey].toFixed(4)}`);
    }
  });

  await test("【安全策】結果と無関係な特徴量の重みは、大きくは動かない(ノイズを学習しすぎない)", () => {
    const recs = makeVenueDrivenRecords(40);
    const fitted = fitWeightsGradientDescent(recs, EXTENDED_DEFAULT_WEIGHTS, { iterations: 120, learningRate: 0.25 });
    // topScorerDiffは全レコードで0(=情報が無い)。勾配も0なので動かないはず。
    assert.strictEqual(fitted.topScorerSensitivity, 0,
      "情報が無い特徴量の重みを動かしてはいけない, got " + fitted.topScorerSensitivity);
  });

  await test("★【多日間】日を追うごとに、学習した重みが引き継がれて予測が変わる", () => {
    // 1日目: 何も学習していない状態
    let weights = { ...EXTENDED_DEFAULT_WEIGHTS };
    const day1Acc = backtestAccuracyV2(makeVenueDrivenRecords(40), weights).accuracy;

    // 2日目: 40件のデータで学習
    const day2Fit = fitWeightsGradientDescent(makeVenueDrivenRecords(40), weights, { iterations: 100, learningRate: 0.25 });
    weights = day2Fit;
    const day2Acc = backtestAccuracyV2(makeVenueDrivenRecords(40), weights).accuracy;

    // 3日目: さらにデータが増えた状態で、前日の重みから続けて学習
    const day3Fit = fitWeightsGradientDescent(makeVenueDrivenRecords(60), weights, { iterations: 100, learningRate: 0.25 });
    const day3Acc = backtestAccuracyV2(makeVenueDrivenRecords(60), day3Fit).accuracy;

    assert.ok(day2Acc > day1Acc, `2日目は1日目より良くなるはず (${day1Acc}% → ${day2Acc}%)`);
    assert.ok(day3Acc >= day2Acc, `3日目は2日目以上を維持するはず (${day2Acc}% → ${day3Acc}%)`);
    assert.notStrictEqual(day3Fit.venueSensitivity, EXTENDED_DEFAULT_WEIGHTS.venueSensitivity);
    console.log(`        → 的中率の推移: 1日目 ${day1Acc}% → 2日目 ${day2Acc}% → 3日目 ${day3Acc}%`);
    console.log(`        → venueSensitivity の推移: 0 → ${day2Fit.venueSensitivity.toFixed(4)} → ${day3Fit.venueSensitivity.toFixed(4)}`);
  });

  await test("★【安全ゲート】学習しても的中率が改善しないデータでは、採用されない", () => {
    // 結果が完全にランダムなデータ(学習しても当たるようにならない)
    const recs = [];
    for (let i = 0; i < 40; i++) {
      recs.push({
        fixtureId: 8000 + i,
        actualWinner: ["home", "away", "draw"][i % 3],
        features: { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0 },
      });
    }
    const before = backtestAccuracyV2(recs, EXTENDED_DEFAULT_WEIGHTS);
    const fitted = fitWeightsGradientDescent(recs, EXTENDED_DEFAULT_WEIGHTS, { iterations: 100, learningRate: 0.25 });
    const after = backtestAccuracyV2(recs, fitted || EXTENDED_DEFAULT_WEIGHTS);
    // dailyJob.js 側は「after > before の場合のみ採用」というゲートを通す。
    // ここではそのゲートが正しく機能する材料(改善していないこと)を確認する。
    assert.ok(after.accuracy <= before.accuracy + 0.1,
      `情報が無いデータで的中率が上がったように見えてはいけない (${before.accuracy}% → ${after.accuracy}%)`);
    console.log(`        → 情報の無いデータ: ${before.accuracy}% → ${after.accuracy}%(採用ゲートで弾かれる)`);
  });

  console.log(failures === 0 ? "\nAll prediction-weight-learning simulation tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
