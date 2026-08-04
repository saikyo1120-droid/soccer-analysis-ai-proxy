/**
 * 2026年8月・優先順位④「AIの分析能力の強化」(最優先)のテスト。
 *
 * ご指示の検証項目:
 *   ・回答前に必ず 必要データ取得→仮説生成→仮説比較→反対意見→根拠評価→最終結論
 *     の6段階を内部で行うこと
 *   ・「私は○○が最も重要だと考えます」という結論を必ず出すこと
 *   ・同じ質問でもテンプレート回答にならないこと
 *   ・(⑮)なぜその自信度なのかを説明すること
 *   ・(⑱)どのデータがどれくらい影響したかを重要度順に示すこと
 *   ・(⑭)考えが変わった理由を説明すること
 */
const assert = require("assert");
const {
  deliberate, assessDataAvailability, compareHypotheses, buildCounterArgument,
  evaluateEvidence, buildFinalConclusion, REQUIRED_DATA_SPECS,
} = require("../server/reasoning/deliberation");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

const H = (label, score, evidenceCount, statement) => ({
  label, score, statement: statement || `${label}に関する見立てです。`,
  evidence: Array.from({ length: evidenceCount }, () => ({ type: "fact" })),
});
const ALL_DATA = REQUIRED_DATA_SPECS.reduce((a, s) => { a[s.key] = true; return a; }, {});

// ---- 6段階が必ず実行されること ----
test("★6段階すべてが構造として返る(後から検証できる)", () => {
  const r = deliberate({ ranked: [H("怪我人", 5, 3)], dataAvailability: ALL_DATA });
  for (const step of ["step1_dataGathering", "step2_hypotheses", "step3_comparison", "step4_counterArgument", "step5_evidenceEvaluation", "step6_finalConclusion"]) {
    assert.ok(r.stages[step], `${step} が必要`);
  }
});

test("★結論は必ず「私は○○が最も重要だと考えます」で始まる", () => {
  const r = deliberate({ ranked: [H("怪我人の多さ", 5, 3)], dataAvailability: ALL_DATA });
  assert.ok(/^私は「.+」がこの分析で最も重要だと考えます。/.test(r.finalConclusionJa), r.finalConclusionJa);
  assert.ok(r.finalConclusionJa.includes("怪我人の多さ"));
});

test("根拠が1件も無い場合は「最も重要」と断定せず、正直に保留する(でっち上げない)", () => {
  const r = deliberate({ ranked: [], dataAvailability: {} });
  assert.ok(r.finalConclusionJa.includes("確かなことを申し上げられない"), r.finalConclusionJa);
  assert.ok(!/最も重要だと考えます/.test(r.finalConclusionJa), "根拠が無いのに断定してはいけない");
});

// ---- 段階1: 必要データ取得 ----
test("段階1: 揃っているデータと欠けているデータを区別する", () => {
  const a = assessDataAvailability({ form: true, goals: true });
  assert.strictEqual(a.available.length, 2);
  assert.strictEqual(a.missing.length, REQUIRED_DATA_SPECS.length - 2);
  assert.ok(a.summaryJa.includes("不足"), a.summaryJa);
});

test("段階1: すべて揃っていれば「すべて揃っています」と言い切る", () => {
  const a = assessDataAvailability(ALL_DATA);
  assert.strictEqual(a.coveragePct, 100);
  assert.ok(a.summaryJa.includes("すべて揃っています"), a.summaryJa);
});

// ---- 段階3: 仮説比較 ----
test("段階3: 1位と2位が僅差なら「単一要因と断定できない」と判定する", () => {
  const c = compareHypotheses([H("A", 3, 2), H("B", 3, 2)]);
  assert.strictEqual(c.isClose, true);
  assert.ok(c.marginJa.includes("僅差"), c.marginJa);
});

test("段階3: 明確な差があれば、そう判定する", () => {
  const c = compareHypotheses([H("A", 8, 4), H("B", 1, 1)]);
  assert.strictEqual(c.isClose, false);
  assert.ok(c.marginJa.includes("明確に上回"), c.marginJa);
});

// ---- 段階4: 反対意見 ----
test("★段階4: 対抗仮説があれば必ず反対意見を立てる", () => {
  const c = compareHypotheses([H("A", 8, 4), H("B", 3, 2, "Bという別の見方もできます。")]);
  const ca = buildCounterArgument(c);
  assert.strictEqual(ca.hasCounter, true);
  assert.ok(ca.statementJa.includes("反対の見方"), ca.statementJa);
  assert.ok(ca.statementJa.includes("Bという別の見方"), ca.statementJa);
});

test("段階4: 対抗仮説が無い場合、無理に反論をでっち上げない", () => {
  const ca = buildCounterArgument(compareHypotheses([H("A", 8, 4)]));
  assert.strictEqual(ca.hasCounter, false);
  // 第5次監査での修正に追随。以前は「反対意見が無いこと自体が根拠の強さを示す」と
  // 述べていたが、実際には他の観点のデータをまだ取得できていないだけであり、
  // 強さの証明にはならない。正直な言い回しになっていることを検証する。
  assert.ok(ca.statementJa.includes("データが集まっていません"), ca.statementJa);
  assert.ok(!ca.statementJa.includes("根拠の強さを示します"), "データが無いことを強みとして提示してはいけない: " + ca.statementJa);
});

// ---- 段階5: 根拠評価(⑮自信度の理由・⑱影響度の内訳) ----
test("★⑮ データが揃い根拠も多ければ自信度が高く、その理由が説明される", () => {
  const r = deliberate({ ranked: [H("A", 8, 4), H("B", 1, 1)], dataAvailability: ALL_DATA });
  assert.strictEqual(r.confidence.stars, 5);
  assert.ok(r.confidence.reasonJa.includes("すべて揃っている"), r.confidence.reasonJa);
  assert.ok(r.confidence.reasonJa.includes("実データが4件ある"), r.confidence.reasonJa);
});

test("★⑮ 怪我情報が不足していれば自信度が下がり、不足しているデータ名が示される", () => {
  const partial = { ...ALL_DATA };
  delete partial.injuries;
  const r = deliberate({ ranked: [H("A", 8, 4), H("B", 1, 1)], dataAvailability: partial });
  assert.ok(r.confidence.stars < 5, "データが欠けていれば満点にしてはいけない");
  assert.ok(r.confidence.reasonJa.includes("怪我人・出場停止"), "何が不足しているか名指しするはず: " + r.confidence.reasonJa);
  assert.ok(r.confidence.reasonJa.includes("不足"), r.confidence.reasonJa);
});

test("⑮ データがほとんど無ければ自信度は最低になる", () => {
  const r = deliberate({ ranked: [H("A", 1, 0)], dataAvailability: {} });
  assert.strictEqual(r.confidence.stars, 1);
  assert.ok(r.confidence.reasonJa.includes("裏づける実データが無い"), r.confidence.reasonJa);
});

test("★⑱ 各要因の影響度が、割合と★で重要度順に示される", () => {
  const r = deliberate({ ranked: [H("フォーム", 6, 3), H("怪我", 3, 2), H("監督", 1, 1)], dataAvailability: ALL_DATA });
  assert.strictEqual(r.factorBreakdown.length, 3);
  assert.strictEqual(r.factorBreakdown[0].labelJa, "フォーム", "影響度の高い順に並ぶはず");
  assert.ok(r.factorBreakdown[0].sharePct > r.factorBreakdown[1].sharePct);
  const total = r.factorBreakdown.reduce((s, b) => s + b.sharePct, 0);
  assert.ok(Math.abs(total - 100) <= 2, "割合の合計がほぼ100%になるはず, got " + total);
  assert.ok(/^[★☆]{5}$/.test(r.factorBreakdown[0].starsDisplay), r.factorBreakdown[0].starsDisplay);
});

test("⑱ 根拠が無い(スコア0以下の)要因は影響度の一覧に載せない", () => {
  const r = deliberate({ ranked: [H("A", 5, 3), H("B", 0, 0)], dataAvailability: ALL_DATA });
  assert.ok(!r.factorBreakdown.some((b) => b.labelJa === "B"), "根拠0の要因を影響したかのように見せてはいけない");
});

// ---- 段階6 / ⑭ 考えの変化 ----
test("★⑭ 前回と結論が変われば、変わった理由に必ず言及する", () => {
  const r = deliberate({
    ranked: [H("怪我人", 8, 4, "主力2名を欠いています。")], dataAvailability: ALL_DATA,
    previousConclusion: { statement: "直近フォームが良好です。" },
  });
  assert.strictEqual(r.changedFromPrevious.changed, true);
  assert.ok(r.finalConclusionJa.includes("以前は"), r.finalConclusionJa);
  assert.ok(r.finalConclusionJa.includes("直近フォームが良好です。"), "前回の考えを具体的に引用するはず");
  assert.ok(r.finalConclusionJa.includes("新しいデータを学んだ結果"), r.finalConclusionJa);
});

test("⑭ 前回と結論が同じなら、変わっていないことを記録する(嘘の変化を作らない)", () => {
  const stmt = "主力2名を欠いています。";
  const r = deliberate({
    ranked: [H("怪我人", 8, 4, stmt)], dataAvailability: ALL_DATA,
    previousConclusion: { statement: stmt },
  });
  assert.strictEqual(r.changedFromPrevious.changed, false);
  assert.ok(!r.finalConclusionJa.includes("以前は"), "変わっていないのに『考えが変わった』と書いてはいけない");
});

// ---- テンプレート化の防止 ----
test("★同じ観点でも、根拠の状況が違えば結論文が変わる(テンプレート回答にならない)", () => {
  const a = deliberate({ ranked: [H("怪我人", 8, 4)], dataAvailability: ALL_DATA }).finalConclusionJa;
  const partial = { form: true, goals: true };
  const b = deliberate({ ranked: [H("怪我人", 8, 1)], dataAvailability: partial }).finalConclusionJa;
  assert.notStrictEqual(a, b, "根拠やデータ状況が違えば文面も変わるはず");
});

test("★1位2位が僅差の時は、断定を避ける一文が加わる", () => {
  const r = deliberate({ ranked: [H("A", 3, 2), H("B", 3, 2)], dataAvailability: ALL_DATA });
  assert.ok(r.finalConclusionJa.includes("僅差"), r.finalConclusionJa);
  assert.ok(r.finalConclusionJa.includes("決めつけるべきではありません"), r.finalConclusionJa);
});

// ---- LLMへ渡す内部メモ ----
test("LLMへ渡す内部メモに、6段階すべてが番号付きで含まれる", () => {
  const r = deliberate({ ranked: [H("A", 8, 4), H("B", 2, 1)], dataAvailability: ALL_DATA });
  for (const n of ["1. 必要データ", "2. 仮説", "3. 比較", "4. 反対意見", "5. 根拠評価", "6. 結論"]) {
    assert.ok(r.promptNote.includes(n), `内部メモに ${n} が必要: ` + r.promptNote);
  }
});

test("不正な入力(null・空)でも例外を投げない", () => {
  assert.doesNotThrow(() => deliberate(null));
  assert.doesNotThrow(() => deliberate({}));
  assert.doesNotThrow(() => deliberate({ ranked: null, dataAvailability: null }));
});

console.log(failures === 0 ? "\nAll deliberation (優先順位④) tests PASSED." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
