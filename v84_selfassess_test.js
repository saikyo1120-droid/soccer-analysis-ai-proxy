"use strict";
/** v84/v84.1: 「賢くなったか」判定の再設計テスト(利用者の「ほぼ毎日NO」への対応)。
 *  本番の実データ形をそのまま与え、少数サンプルの揺れでNOにならないこと、
 *  本物の後退(データ喪失・傾向としての精度低下)ではきちんとNOになることを検証する。
 *  v84.1(監査で発見した2つの追加バグの修正も検証):
 *   ①考察の質スコアの少数サンプルの揺れ(−0.1点等)でNOにしない(参考扱い)
 *   ②前日比は「当日と前日の両方が十分な件数」かつ「差が誤差幅3ptを超える」ときだけ判定 */
const assert = require("assert");
const { buildSelfAssessment } = require("./learning/intelligenceMetrics");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };
const mkt = (n, rate, official) => ({ markets: { oneX2: Object.assign({ measurable: true, n, hitRatePct: rate }, official ? { official } : {}) } });

// 本番2026-09-08の実データ形: 知識+435・記憶+14、当日の答え合わせ10件(少数)。
const prodToday = {
  accuracyTrend: {
    available: true,
    today: mkt(10, 30), yesterday: mkt(11, 54.5),
    last7Days: mkt(154, 59.7), last30Days: mkt(520, 57.0),
    vsYesterday: { hitRateDeltaPct: -24.5, brierDelta: 0.1033 },
  },
  metricsComparison: { hasBaseline: true, knowledgeDelta: 435, memoryDelta: 14 },
  intelTrend: { vsYesterday: { reasoningScoreDelta: 0 } },
  weightsUpdated: true,
};

t("本番の当日データ(知識+435・当日10件)は YES になる", () => {
  const r = buildSelfAssessment(prodToday);
  assert.strictEqual(r.verdict, "YES", "verdict=" + r.verdict + " / " + r.answerJa);
});

t("少数日(当日10件)の的中率の落ち込みは『参考(判定外)』として proofs に残る", () => {
  const r = buildSelfAssessment(prodToday);
  const daily = r.proofs.find((p) => p.axisJa.includes("前日比"));
  assert.ok(daily, "前日比の軸が proofs に無い");
  assert.strictEqual(daily.counted, false, "少数日の前日比が counted=true になっている");
  assert.ok(daily.valueJa.includes("-24.5"), "−24.5 が表示に残っていない: " + daily.valueJa);
});

t("[L1] 考察の質スコアの−0.1点の揺れでは NO にならない(参考扱い)", () => {
  const r = buildSelfAssessment({
    ...prodToday,
    intelTrend: { vsYesterday: { reasoningScoreDelta: -0.1 } },
  });
  assert.strictEqual(r.verdict, "YES", "verdict=" + r.verdict + " / " + r.answerJa);
  const rs = r.proofs.find((p) => p.axisJa.includes("考察の質"));
  assert.ok(rs && rs.counted === false, "考察の質スコアが参考(counted=false)になっていない");
});

t("[L1] 考察の質スコアが−3点でも、能力が伸びていれば YES(判定に使わない)", () => {
  const r = buildSelfAssessment({
    ...prodToday,
    intelTrend: { vsYesterday: { reasoningScoreDelta: -3 } },
  });
  assert.strictEqual(r.verdict, "YES", "verdict=" + r.verdict + " / " + r.answerJa);
});

t("[L3] 前日が少数(4件)なら、大きな見かけの差でも NO にしない", () => {
  const r = buildSelfAssessment({
    accuracyTrend: {
      available: true,
      today: mkt(45, 35), yesterday: mkt(4, 100),   // 前日4/4=100%の偶然
      last7Days: mkt(80, 54), last30Days: mkt(300, 55),
      vsYesterday: { hitRateDeltaPct: -65 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 50, memoryDelta: 1 },
    weightsUpdated: false,
  });
  assert.strictEqual(r.verdict, "YES", "verdict=" + r.verdict + " / " + r.answerJa);
});

t("[L3] 当日・前日とも十分な件数だが差が3pt未満(−0.1pt)なら NO にしない", () => {
  const r = buildSelfAssessment({
    accuracyTrend: {
      available: true,
      today: mkt(40, 55.0), yesterday: mkt(38, 55.1),
      last7Days: mkt(80, 55), last30Days: mkt(300, 55),
      vsYesterday: { hitRateDeltaPct: -0.1 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 50, memoryDelta: 1 },
    weightsUpdated: false,
  });
  assert.strictEqual(r.verdict, "YES", "verdict=" + r.verdict + " / " + r.answerJa);
});

t("当日・前日とも十分な件数で的中率が本当に下がった(−17pt)日は NO", () => {
  const r = buildSelfAssessment({
    accuracyTrend: {
      available: true,
      today: mkt(45, 35), yesterday: mkt(40, 52),
      last7Days: mkt(80, 50), last30Days: mkt(300, 50),
      vsYesterday: { hitRateDeltaPct: -17 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 50, memoryDelta: 1 },
    weightsUpdated: false,
  });
  assert.strictEqual(r.verdict, "NO", "verdict=" + r.verdict + " / " + r.answerJa);
  const daily = r.proofs.find((p) => p.axisJa.includes("前日比"));
  assert.strictEqual(daily.counted, true, "十分な件数+3pt超の前日比が判定に使われていない");
});

t("[L2] 公式戦の的中率を優先する(全体値なら−20ptでNOだが、公式戦は横ばいでYES)", () => {
  // 当日: 全体45件30%(親善で汚染)だが公式戦は35件55%。前日: 全体40件50%・公式戦33件54%。
  //   全体値だと前日比−20pt→NOに見えるが、実力(公式戦)では+1ptの横ばい→YESが正しい。
  const withOfficial = {
    accuracyTrend: {
      available: true,
      today: mkt(45, 30, { n: 35, hitRatePct: 55 }),
      yesterday: mkt(40, 50, { n: 33, hitRatePct: 54 }),
      last7Days: mkt(150, 40, { n: 120, hitRatePct: 56 }),
      last30Days: mkt(500, 41, { n: 400, hitRatePct: 55 }),
      vsYesterday: { hitRateDeltaPct: -20 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 100, memoryDelta: 2 },
    weightsUpdated: false,
  };
  assert.strictEqual(buildSelfAssessment(withOfficial).verdict, "YES", "公式戦優先でYESにならない: " + buildSelfAssessment(withOfficial).answerJa);
  // 公式戦の内訳が無い(全体値しかない)同じ数字なら、前日比−20ptで NO になる(=公式戦優先が効いている証明)
  const combinedOnly = JSON.parse(JSON.stringify(withOfficial));
  delete combinedOnly.accuracyTrend.today.markets.oneX2.official;
  delete combinedOnly.accuracyTrend.yesterday.markets.oneX2.official;
  assert.strictEqual(buildSelfAssessment(combinedOnly).verdict, "NO", "全体値のみなら−20ptでNOのはず: " + buildSelfAssessment(combinedOnly).answerJa);
});

t("知識件数が減った日(索引破損など)は本物の後退として NO", () => {
  const r = buildSelfAssessment({
    ...prodToday,
    metricsComparison: { hasBaseline: true, knowledgeDelta: -120, memoryDelta: 0 },
  });
  assert.strictEqual(r.verdict, "NO", "verdict=" + r.verdict);
  assert.ok(r.answerJa.includes("後退"), "後退の説明が無い");
});

t("直近7日が直近30日を大きく下回る=本物の精度低下は NO(十分な件数のとき)", () => {
  const r = buildSelfAssessment({
    accuracyTrend: {
      available: true,
      today: mkt(12, 40), yesterday: mkt(10, 42),
      last7Days: mkt(120, 48.0), last30Days: mkt(520, 56.0),
      vsYesterday: { hitRateDeltaPct: 2 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 100, memoryDelta: 3 },
    weightsUpdated: false,
  });
  assert.strictEqual(r.verdict, "NO", "verdict=" + r.verdict + " / " + r.answerJa);
  assert.ok(/傾向/.test(r.answerJa), "傾向の悪化が説明に無い");
});

t("測定材料がまだ無い日は 判定不能(推測でYES/NOを出さない)", () => {
  const r = buildSelfAssessment({ accuracyTrend: { available: false }, metricsComparison: { hasBaseline: false } });
  assert.strictEqual(r.verdict, "判定不能", "verdict=" + r.verdict);
});

t("能力が伸びず後退も無い日(前日と同一)は NO だが『後退はしていない』と明記", () => {
  const r = buildSelfAssessment({
    accuracyTrend: {
      available: true,
      today: mkt(8, 50), yesterday: mkt(7, 50),
      last7Days: mkt(20, 55), last30Days: mkt(40, 55),
      vsYesterday: { hitRateDeltaPct: 0 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 0, memoryDelta: 0 },
    weightsUpdated: false,
  });
  assert.strictEqual(r.verdict, "NO", "verdict=" + r.verdict);
  assert.ok(r.answerJa.includes("後退はしていません"), "『後退はしていない』の明記が無い");
});

// ---- v88(2026年9月9日・本番初日の実測で発見した文言バグの再発防止) ----
// 旧文言「本日の的中率は下がっていますが…」は方向を決め打ちしており、的中率が
// **上がった**日(本番実測: 前日30%→本日63.6%)にも「下がっています」と表示していた。
t("[v88] 的中率が上がった少数日に『下がっています』と言わない(本番9/9の実データ形)", () => {
  const r = buildSelfAssessment({
    accuracyTrend: {
      available: true,
      today: mkt(11, 63.6), yesterday: mkt(10, 30),   // 本番2026-09-09の実測値
      last7Days: mkt(135, 53.4), last30Days: mkt(469, 52.5),
      vsYesterday: { hitRateDeltaPct: 33.6 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 143, memoryDelta: 18 },
    intelTrend: { vsYesterday: { reasoningScoreDelta: 5.9 } },
    weightsUpdated: true,
  });
  assert.strictEqual(r.verdict, "YES", "verdict=" + r.verdict + " / " + r.answerJa);
  assert.ok(!r.answerJa.includes("下がっています"), "上がった日に『下がっています』と言っている: " + r.answerJa);
  // 参考軸(揺れ)があるときは、方向に依存しない注記が付く
  if (/揺れ|下回|低下/.test(r.proofs.filter((p) => p.counted === false).map((p) => p.valueJa).join(""))) {
    assert.ok(r.answerJa.includes("判定には使っていません"), "方向非依存の注記が無い: " + r.answerJa);
  }
});

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail ? 1 : 0);
