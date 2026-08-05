/**
 * 2026年8月・優先順位③「Failure Learningを本格化してください」のテスト。
 *
 * ご要望原文で挙げられた原因のうち、
 *   ・ホーム補正が強すぎた / 怪我を軽視した → 既存のclassifyFailureReasonsが担当
 *   ・xGとの差を見逃した / 監督交代を考慮しなかった /
 *     スタメン変更を見逃した / フォーメーション相性
 * のうち後者は「モデルの特徴量に入っていない事情」であり、従来は永久に
 * 「数値化していない要因」としか言えなかった。
 * classifyContextualFailureReasons が、予測時点に記録した文脈と試合後に判明した
 * 事実を突き合わせて、これらを特定できるかを検証する。
 *
 * でっち上げ防止の検証を最重視している:
 *   実際に食い違いが起きていない場合に、それらしい理由を作らないこと。
 */
const assert = require("assert");
const {
  classifyContextualFailureReasons, CONTEXTUAL_FAILURE_LABELS_JA,
} = require("../server/learning/predictionModel");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

const baseFeatures = {
  formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0,
  headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0,
};
const wrongRecord = (over) => ({
  correct: false, predictedWinner: "home", actualWinner: "away",
  homeTeamEn: "Home FC", awayTeamEn: "Away FC",
  features: { ...baseFeatures }, ...over,
});
const XI = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

(async () => {
  await test("的中した予測には、モデル外の理由を付けない(空配列)", () => {
    const r = classifyContextualFailureReasons({ correct: true, features: baseFeatures }, {});
    assert.deepStrictEqual(r, []);
  });

  // ---- xGとの食い違い ----
  await test("xGとの差を見逃した: 得点力とxGが逆を向いていて、得点力を信じて外した場合に検出する", () => {
    const r = classifyContextualFailureReasons(
      wrongRecord({ features: { ...baseFeatures, goalRateDiff: 0.9, xgDiff: -0.6 } }), null);
    const ids = r.map((x) => x.id);
    assert.ok(ids.includes("xg_goal_gap_missed"), JSON.stringify(ids));
    const reason = r.find((x) => x.id === "xg_goal_gap_missed");
    assert.ok(reason.labelJa.includes("xG"), reason.labelJa);
    assert.ok(reason.detail.includes("0.90") && reason.detail.includes("-0.60"), "実際の数値を根拠として示すはず: " + reason.detail);
    assert.ok(reason.detail.includes("幸運"), "なぜ読み違えたのかまで説明するはず");
  });

  await test("xG: 得点力とxGが同じ方向なら、この理由は出さない(でっち上げない)", () => {
    const r = classifyContextualFailureReasons(
      wrongRecord({ features: { ...baseFeatures, goalRateDiff: 0.9, xgDiff: 0.7 } }), null);
    assert.ok(!r.some((x) => x.id === "xg_goal_gap_missed"), JSON.stringify(r.map((x) => x.id)));
  });

  await test("xG: xGが取得できていない(0)場合は、この理由を出さない", () => {
    const r = classifyContextualFailureReasons(
      wrongRecord({ features: { ...baseFeatures, goalRateDiff: 0.9, xgDiff: 0 } }), null);
    assert.ok(!r.some((x) => x.id === "xg_goal_gap_missed"), "データが無いのに理由を作ってはいけない");
  });

  await test("xG: 得点力とは逆方向を予想していた場合は、この理由に当てはめない", () => {
    const r = classifyContextualFailureReasons(
      wrongRecord({ predictedWinner: "away", features: { ...baseFeatures, goalRateDiff: 0.9, xgDiff: -0.6 } }), null);
    assert.ok(!r.some((x) => x.id === "xg_goal_gap_missed"), "得点力を信じていないのにその理由は不適切");
  });

  // ---- 監督交代 ----
  await test("監督交代を考慮できなかった: 予測時と試合時で監督名が違えば検出する", () => {
    const rec = wrongRecord({ predictionContext: { homeCoachName: "A. Old", awayCoachName: "B. Same" } });
    const r = classifyContextualFailureReasons(rec, { homeCoachName: "C. New", awayCoachName: "B. Same" });
    const reason = r.find((x) => x.id === "coach_change_ignored");
    assert.ok(reason, JSON.stringify(r.map((x) => x.id)));
    assert.ok(reason.detail.includes("A. Old") && reason.detail.includes("C. New"), "交代前後の名前を示すはず: " + reason.detail);
    assert.ok(reason.detail.includes("ホーム"), "どちらのチームかを示すはず");
  });

  await test("監督交代: 監督が同じなら理由を作らない", () => {
    const rec = wrongRecord({ predictionContext: { homeCoachName: "A", awayCoachName: "B" } });
    const r = classifyContextualFailureReasons(rec, { homeCoachName: "A", awayCoachName: "B" });
    assert.ok(!r.some((x) => x.id === "coach_change_ignored"));
  });

  await test("監督交代: 片方の名前が不明なら、変わったと決めつけない", () => {
    const rec = wrongRecord({ predictionContext: { homeCoachName: null, awayCoachName: "B" } });
    const r = classifyContextualFailureReasons(rec, { homeCoachName: "C. New", awayCoachName: "B" });
    assert.ok(!r.some((x) => x.id === "coach_change_ignored"), "不明を『交代した』と扱ってはいけない");
  });

  // ---- フォーメーション変更 ----
  await test("フォーメーション変更を見逃した: 直近の布陣と実際の布陣が違えば検出する", () => {
    const rec = wrongRecord({ predictionContext: { homeFormation: "4-3-3", awayFormation: "4-4-2" } });
    const r = classifyContextualFailureReasons(rec, { homeFormation: "5-3-2", awayFormation: "4-4-2" });
    const reason = r.find((x) => x.id === "formation_change_missed");
    assert.ok(reason, JSON.stringify(r.map((x) => x.id)));
    assert.ok(reason.detail.includes("4-3-3") && reason.detail.includes("5-3-2"), reason.detail);
  });

  await test("フォーメーション: 同じ布陣なら理由を作らない", () => {
    const rec = wrongRecord({ predictionContext: { homeFormation: "4-3-3", awayFormation: "4-4-2" } });
    const r = classifyContextualFailureReasons(rec, { homeFormation: "4-3-3", awayFormation: "4-4-2" });
    assert.ok(!r.some((x) => x.id === "formation_change_missed"));
  });

  // ---- スタメンの大幅入れ替え ----
  await test("スタメン変更を見逃した: 先発の半数以上が入れ替わっていれば検出する", () => {
    const rec = wrongRecord({ predictionContext: { homeLineupNames: XI("P", 11) } });
    // 11人中6人を入れ替える
    const actual = [...XI("P", 5), ...XI("Q", 6)];
    const r = classifyContextualFailureReasons(rec, { homeLineupNames: actual });
    const reason = r.find((x) => x.id === "lineup_disruption_missed");
    assert.ok(reason, JSON.stringify(r.map((x) => x.id)));
    assert.ok(reason.detail.includes("6人"), "何人入れ替わったかを示すはず: " + reason.detail);
    assert.ok(reason.detail.includes("ターンオーバー"), reason.detail);
  });

  await test("スタメン: 入れ替えが少なければ理由を作らない(通常のローテーションを騒がない)", () => {
    const rec = wrongRecord({ predictionContext: { homeLineupNames: XI("P", 11) } });
    const actual = [...XI("P", 9), "Q1", "Q2"]; // 2人だけ変更
    const r = classifyContextualFailureReasons(rec, { homeLineupNames: actual });
    assert.ok(!r.some((x) => x.id === "lineup_disruption_missed"));
  });

  await test("スタメン: 人数が少なすぎる(データ不完全)場合は判定しない", () => {
    const rec = wrongRecord({ predictionContext: { homeLineupNames: ["A", "B"] } });
    const r = classifyContextualFailureReasons(rec, { homeLineupNames: ["X", "Y"] });
    assert.ok(!r.some((x) => x.id === "lineup_disruption_missed"), "2人分のデータで断定してはいけない");
  });

  // ---- 全体の安全性 ----
  await test("文脈が記録されていない古いレコードでも例外を投げず、無理に理由を作らない", () => {
    const r = classifyContextualFailureReasons(wrongRecord({}), null);
    assert.ok(Array.isArray(r));
    assert.strictEqual(r.length, 0, "根拠が無いのに理由を作ってはいけない");
  });

  await test("試合後の文脈が取得できなかった場合でも、xGの判定だけは行える", () => {
    const r = classifyContextualFailureReasons(
      wrongRecord({ features: { ...baseFeatures, goalRateDiff: 1.0, xgDiff: -0.5 } }), null);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, "xg_goal_gap_missed");
  });

  await test("複数の原因が重なっても、最大3件までに絞る(表示が長くなりすぎないように)", () => {
    const rec = wrongRecord({
      features: { ...baseFeatures, goalRateDiff: 1.0, xgDiff: -0.5 },
      predictionContext: { homeCoachName: "Old", homeFormation: "4-3-3", homeLineupNames: XI("P", 11) },
    });
    const r = classifyContextualFailureReasons(rec, {
      homeCoachName: "New", homeFormation: "5-3-2", homeLineupNames: [...XI("P", 3), ...XI("Q", 8)],
    });
    assert.ok(r.length <= 3, "3件以内のはず, got " + r.length);
    assert.ok(r.length >= 3, "この状況なら3件検出されるはず, got " + JSON.stringify(r.map((x) => x.id)));
  });

  await test("すべての理由IDに日本語ラベルが定義されている(IDがそのまま画面に出ない)", () => {
    for (const id of ["xg_goal_gap_missed", "coach_change_ignored", "formation_change_missed", "lineup_disruption_missed"]) {
      assert.ok(CONTEXTUAL_FAILURE_LABELS_JA[id], `${id} のラベルが必要`);
      assert.ok(!/[a-z_]{6,}/.test(CONTEXTUAL_FAILURE_LABELS_JA[id]), "ラベルに英語IDが混ざってはいけない");
    }
  });

  await test("ご要望で挙げられた原因が、すべて何らかの形で分析対象になっている", () => {
    // ホーム補正・怪我 → classifyFailureReasons(既存) / それ以外 → 本モジュール
    const covered = Object.values(CONTEXTUAL_FAILURE_LABELS_JA).join(" ");
    assert.ok(covered.includes("xG"), "xGとの差");
    assert.ok(covered.includes("監督交代"), "監督交代");
    assert.ok(covered.includes("スタメン"), "スタメン変更");
    assert.ok(covered.includes("フォーメーション"), "フォーメーション");
  });

  console.log(failures === 0 ? "\nAll contextual failure-learning (優先順位③) tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
