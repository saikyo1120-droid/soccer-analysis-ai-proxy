/**
 * 2026年8月・優先順位②「Prediction Engineを本当に賢くしてください」で追加した
 * 特徴量(ホーム/アウェイ別成績・出場停止・xG・エースの得点力)のテスト。
 *
 * このプロジェクトで最も守るべき安全策の検証を最優先にしている:
 *   「新しい特徴量を追加しても、学習前(重み0)は予測結果が1ミリも変わらない」
 * これが崩れると、追加した瞬間に既存の的中率が壊れる。
 */
const assert = require("assert");
const {
  computeMatchFeatures, predictOutcomeV2, EXTENDED_DEFAULT_WEIGHTS,
  FEATURE_WEIGHT_MAP, FEATURE_LABELS_JA, classifyFailureReasons, classifySuccessReasons,
  computeFactorImportance,
} = require("../server/learning/predictionModel");
const { computeHomeAwaySplit, computeInjuryCountFeature } = require("../server/learning/features");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

const baseCtx = (over) => ({
  formScore: 0, avgGoalsFor: 1, avgGoalsAgainst: 1, injuryCount: 0,
  pointsPerGame: 1.5, matchesLast7Days: 1, ...over,
});

(async () => {
  // ---- 最重要: 既存の挙動を壊していないこと ----
  await test("★安全策: 新しい特徴量を追加しても、既定の重み(全て0)では予測が一切変わらない", () => {
    const oldStyleFeatures = { formDiff: 2, goalRateDiff: 1, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 };
    const newStyleFeatures = { ...oldStyleFeatures, venueDiff: 0.9, suspensionDiff: 3, xgDiff: 1.7, topScorerDiff: 12 };
    const a = predictOutcomeV2(oldStyleFeatures, EXTENDED_DEFAULT_WEIGHTS);
    const b = predictOutcomeV2(newStyleFeatures, EXTENDED_DEFAULT_WEIGHTS);
    assert.strictEqual(a.predictedWinner, b.predictedWinner, "学習前は予測結果が変わってはいけない");
    assert.strictEqual(a.homeLambda, b.homeLambda);
    assert.strictEqual(a.awayLambda, b.awayLambda);
  });

  await test("★安全策: 追加した重みの既定値はすべて0(学習して初めて効き始める)", () => {
    for (const k of ["venueSensitivity", "suspensionSensitivity", "xgSensitivity", "topScorerSensitivity"]) {
      assert.strictEqual(EXTENDED_DEFAULT_WEIGHTS[k], 0, `${k} の既定値は0のはず`);
    }
  });

  await test("重みを与えれば、新しい特徴量が実際に予測へ効く", () => {
    const f = { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0.5, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0 };
    const learned = { ...EXTENDED_DEFAULT_WEIGHTS, venueSensitivity: 1.0 };
    const before = predictOutcomeV2(f, EXTENDED_DEFAULT_WEIGHTS);
    const after = predictOutcomeV2(f, learned);
    assert.notStrictEqual(before.homeLambda, after.homeLambda, "重みを学習すれば効くはず");
  });

  // ---- 特徴量の計算 ----
  await test("venueDiff: ホームチームのホーム勝率 と アウェイチームのアウェイ勝率 の差になる", () => {
    const f = computeMatchFeatures(baseCtx({ homeVenueWinRate: 0.8 }), baseCtx({ awayVenueWinRate: 0.3 }), null);
    assert.ok(Math.abs(f.venueDiff - 0.5) < 1e-9, "0.8-0.3=0.5 のはず, got " + f.venueDiff);
  });

  await test("venueDiff: どちらかのデータが無ければ0(推測で埋めない)", () => {
    assert.strictEqual(computeMatchFeatures(baseCtx({ homeVenueWinRate: 0.8 }), baseCtx({}), null).venueDiff, 0);
    assert.strictEqual(computeMatchFeatures(baseCtx({}), baseCtx({ awayVenueWinRate: 0.3 }), null).venueDiff, 0);
  });

  await test("suspensionDiff: 相手の出場停止が多いほど自分に有利(符号が正しい)", () => {
    const f = computeMatchFeatures(baseCtx({ suspensionCount: 1 }), baseCtx({ suspensionCount: 4 }), null);
    assert.strictEqual(f.suspensionDiff, 3, "相手4 - 自分1 = +3 でホーム有利のはず");
  });

  await test("suspensionDiff: 怪我(injuryDiff)とは別の特徴量として独立している", () => {
    const f = computeMatchFeatures(baseCtx({ injuryCount: 5, suspensionCount: 0 }), baseCtx({ injuryCount: 0, suspensionCount: 2 }), null);
    assert.strictEqual(f.injuryDiff, -5, "怪我は自分の方が多い");
    assert.strictEqual(f.suspensionDiff, 2, "出場停止は相手の方が多い");
  });

  await test("xgDiff: xG-xGAの差を使う。取得できなければ0のまま", () => {
    assert.ok(Math.abs(computeMatchFeatures(baseCtx({ xgNet: 1.2 }), baseCtx({ xgNet: -0.3 }), null).xgDiff - 1.5) < 1e-9);
    assert.strictEqual(computeMatchFeatures(baseCtx({ xgNet: 1.2 }), baseCtx({}), null).xgDiff, 0, "片方でも欠ければ0(でっち上げない)");
  });

  await test("topScorerDiff: 各チームのエースの得点数の差になる", () => {
    const f = computeMatchFeatures(baseCtx({ topScorerGoals: 20 }), baseCtx({ topScorerGoals: 8 }), null);
    assert.strictEqual(f.topScorerDiff, 12);
  });

  // ---- 実データからの供給(追加APIコスト0の経路) ----
  await test("computeHomeAwaySplit: 既に取得済みのfixturesから、追加API無しでホーム/アウェイ勝率を出せる", () => {
    const now = Date.now();
    const fixtures = [
      // ホーム3試合(2勝1敗)
      { fixture: { id: 1, date: new Date(now).toISOString() }, teams: { home: { id: 10 }, away: { id: 2 } }, goals: { home: 2, away: 0 } },
      { fixture: { id: 2, date: new Date(now - 1e5).toISOString() }, teams: { home: { id: 10 }, away: { id: 3 } }, goals: { home: 3, away: 1 } },
      { fixture: { id: 3, date: new Date(now - 2e5).toISOString() }, teams: { home: { id: 10 }, away: { id: 4 } }, goals: { home: 0, away: 1 } },
      // アウェイ2試合(0勝2敗)
      { fixture: { id: 4, date: new Date(now - 3e5).toISOString() }, teams: { home: { id: 5 }, away: { id: 10 } }, goals: { home: 2, away: 1 } },
      { fixture: { id: 5, date: new Date(now - 4e5).toISOString() }, teams: { home: { id: 6 }, away: { id: 10 } }, goals: { home: 1, away: 0 } },
    ];
    const split = computeHomeAwaySplit(fixtures, 10);
    assert.ok(Math.abs(split.home.winRate - 0.67) < 0.01, "ホーム勝率2/3, got " + split.home.winRate);
    assert.strictEqual(split.away.winRate, 0, "アウェイ勝率0/2");
    // このチームは「ホームでは強いがアウェイでは弱い」。formDiffだけでは表せない情報。
    assert.notStrictEqual(split.home.winRate, split.away.winRate);
  });

  await test("computeInjuryCountFeature: 既に取得済みの/injuriesから、追加API無しで出場停止だけを取り出せる", () => {
    const r = computeInjuryCountFeature([
      { player: { name: "A", reason: "Hamstring Injury" } },
      { player: { name: "B", reason: "Suspended" } },
      { player: { name: "C", reason: "Red card suspension" } },
      { player: { name: "B", reason: "Suspended" } }, // 重複は数えない
    ]);
    assert.strictEqual(r.suspendedPlayers.length, 2, "出場停止2名のはず, got " + JSON.stringify(r.suspendedPlayers));
    assert.strictEqual(r.injuredPlayers.length, 1);
    assert.strictEqual(r.injuryCount, 3, "重複を除いた合計人数");
  });

  // ---- 失敗分析・成功分析への統合 ----
  await test("失敗分析: 新しい特徴量にも日本語ラベルが用意されている(idがそのまま画面に出ない)", () => {
    for (const k of ["venueDiff", "suspensionDiff", "xgDiff", "topScorerDiff"]) {
      assert.ok(FEATURE_LABELS_JA[k], `${k} の日本語ラベルが必要`);
      assert.ok(FEATURE_WEIGHT_MAP[k], `${k} が重みと結び付いている必要がある`);
    }
  });

  await test("失敗分析: 出場停止を軽視して外した場合、その理由が日本語で出る", () => {
    const weights = { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.2, awayBase: 1.2, sensitivity: 0.2, suspensionSensitivity: 0 };
    const reasons = classifyFailureReasons({
      correct: false, predictedWinner: "home", actualWinner: "away",
      features: { formDiff: 1, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: -3, xgDiff: 0, topScorerDiff: 0 },
    }, weights);
    const ids = reasons.map((r) => r.id);
    assert.ok(ids.includes("suspensionDiff_underweighted"), "出場停止を軽視した、が理由に出るはず: " + JSON.stringify(ids));
    const r = reasons.find((x) => x.id === "suspensionDiff_underweighted");
    assert.ok(r.labelJa.includes("出場停止"), r.labelJa);
  });

  await test("失敗分析: xGを重視しすぎて外した場合も、その理由が日本語で出る", () => {
    const weights = { ...EXTENDED_DEFAULT_WEIGHTS, xgSensitivity: 0.3 };
    const reasons = classifyFailureReasons({
      correct: false, predictedWinner: "home", actualWinner: "away",
      features: { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 2, topScorerDiff: 0 },
    }, weights);
    assert.ok(reasons.some((r) => r.id === "xgDiff_overweighted"), JSON.stringify(reasons.map((r) => r.id)));
  });

  await test("成功分析: 新しい特徴量で当たった場合も「正しく評価できた」と出る", () => {
    const weights = { ...EXTENDED_DEFAULT_WEIGHTS, venueSensitivity: 0.3 };
    const reasons = classifySuccessReasons({
      correct: true, predictedWinner: "home", actualWinner: "home",
      features: { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0.6, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0 },
    }, weights);
    assert.ok(reasons.some((r) => r.id === "venueDiff_worked"), JSON.stringify(reasons.map((r) => r.id)));
  });

  await test("重要度表示(なぜそう思うか): 学習していない新特徴量は★0として正直に区別される", () => {
    const imp = computeFactorImportance(
      { formDiff: 2, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0.9, suspensionDiff: 3, xgDiff: 1.5, topScorerDiff: 10 },
      { ...EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.2 }
    );
    const venue = imp.find((i) => i.key === "venueDiff");
    assert.strictEqual(venue.stars, 0, "重み0の特徴量は★0(まだ考慮していないと正直に示す)");
    const form = imp.find((i) => i.key === "formDiff");
    assert.ok(form.stars > 0, "学習済みの特徴量は★が付くはず");
  });

  console.log(failures === 0 ? "\nAll prediction-features-v3 (優先順位②) tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
