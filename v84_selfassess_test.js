"use strict";
/** v84: 「賢くなったか」判定の再設計テスト(利用者の「ほぼ毎日NO」への対応)。
 *  本番の実データ形をそのまま与え、少数サンプルの的中率の揺れでNOにならないこと、
 *  本物の後退(データ喪失・傾向としての精度低下)ではきちんとNOになることを検証する。 */
const assert = require("assert");
const { buildSelfAssessment } = require("./learning/intelligenceMetrics");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

// 本番2026-09-08の実データ: 知識+435・記憶+14、当日の答え合わせ10件で的中率 前日比 −24.5pt
const prodToday = {
  accuracyTrend: {
    available: true,
    today: { markets: { oneX2: { measurable: true, n: 10, hitRatePct: 30, avgBrier: 0.62 } } },
    last7Days: { markets: { oneX2: { measurable: true, n: 154, hitRatePct: 59.7, avgBrier: 0.62 } } },
    last30Days: { markets: { oneX2: { measurable: true, n: 520, hitRatePct: 57.0, avgBrier: 0.60 } } },
    vsYesterday: { hitRateDeltaPct: -24.5, brierDelta: 0.1033 },
  },
  metricsComparison: { hasBaseline: true, knowledgeDelta: 435, memoryDelta: 14 },
  intelTrend: { vsYesterday: { reasoningScoreDelta: 0 } },
  weightsUpdated: true,
};

t("本番の当日データ(知識+435・的中率−24.5pt/10件)は YES になる", () => {
  const r = buildSelfAssessment(prodToday);
  assert.strictEqual(r.verdict, "YES", "verdict=" + r.verdict + " / " + r.answerJa);
});

t("−24.5pt は『参考(判定外)』として proofs に残る(隠さない)", () => {
  const r = buildSelfAssessment(prodToday);
  const daily = r.proofs.find((p) => p.axisJa.includes("前日比"));
  assert.ok(daily, "前日比の軸が proofs に無い");
  assert.strictEqual(daily.counted, false, "少数日の前日比が counted=true になっている");
  assert.ok(daily.valueJa.includes("-24.5"), "−24.5 が表示に残っていない");
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
      today: { markets: { oneX2: { measurable: true, n: 12, hitRatePct: 40 } } },
      last7Days: { markets: { oneX2: { measurable: true, n: 120, hitRatePct: 48.0 } } },
      last30Days: { markets: { oneX2: { measurable: true, n: 520, hitRatePct: 56.0 } } },
      vsYesterday: { hitRateDeltaPct: 2, brierDelta: -0.01 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 100, memoryDelta: 3 },
    weightsUpdated: false,
  });
  assert.strictEqual(r.verdict, "NO", "verdict=" + r.verdict + " / " + r.answerJa);
  assert.ok(/傾向/.test(r.answerJa), "傾向の悪化が説明に無い");
});

t("十分な件数の当日(N>=30)で的中率が本当に下がった日は前日比を判定に使う=NO", () => {
  const r = buildSelfAssessment({
    accuracyTrend: {
      available: true,
      today: { markets: { oneX2: { measurable: true, n: 45, hitRatePct: 35 } } },
      last7Days: { markets: { oneX2: { measurable: true, n: 60, hitRatePct: 45 } } },
      last30Days: { markets: { oneX2: { measurable: true, n: 200, hitRatePct: 46 } } },
      vsYesterday: { hitRateDeltaPct: -18, brierDelta: 0.05 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 50, memoryDelta: 1 },
    weightsUpdated: false,
  });
  assert.strictEqual(r.verdict, "NO", "verdict=" + r.verdict + " / " + r.answerJa);
  const daily = r.proofs.find((p) => p.axisJa.includes("前日比"));
  assert.strictEqual(daily.counted, true, "N>=30の日の前日比が判定に使われていない");
});

t("測定材料がまだ無い日は 判定不能(推測でYES/NOを出さない)", () => {
  const r = buildSelfAssessment({ accuracyTrend: { available: false }, metricsComparison: { hasBaseline: false } });
  assert.strictEqual(r.verdict, "判定不能", "verdict=" + r.verdict);
});

t("能力が伸びず後退も無い日(前日と同一)は NO だが『後退はしていない』と明記", () => {
  const r = buildSelfAssessment({
    accuracyTrend: {
      available: true,
      today: { markets: { oneX2: { measurable: true, n: 8, hitRatePct: 50 } } },
      last7Days: { markets: { oneX2: { measurable: true, n: 20, hitRatePct: 55 } } },
      last30Days: { markets: { oneX2: { measurable: true, n: 40, hitRatePct: 55 } } },
      vsYesterday: { hitRateDeltaPct: 0, brierDelta: 0 },
    },
    metricsComparison: { hasBaseline: true, knowledgeDelta: 0, memoryDelta: 0 },
    weightsUpdated: false,
  });
  assert.strictEqual(r.verdict, "NO", "verdict=" + r.verdict);
  assert.ok(r.answerJa.includes("後退はしていません"), "『後退はしていない』の明記が無い");
});

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail ? 1 : 0);
