/**
 * server/reasoning/*.js (Hypothesis Generator / Evidence Ranking / Reasoning Engine)
 * および server/reasoning/evidencePool.js のユニットテスト。すべて純粋関数なので
 * モック不要。
 */
const assert = require("assert");
const { buildEvidencePool } = require("../server/reasoning/evidencePool");
const { generateHypotheses, HYPOTHESIS_FACTORS } = require("../server/reasoning/hypothesisGenerator");
const { rankHypotheses, scoreEvidence } = require("../server/reasoning/evidenceRanking");
const { assembleReasoning, runSelfCheck, formatReasoningForPrompt } = require("../server/reasoning/reasoningEngine");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

test("buildEvidencePool: 空のknowledgeからは空配列を返す(捏造しない)", () => {
  assert.deepStrictEqual(buildEvidencePool(null, "X"), []);
  assert.deepStrictEqual(buildEvidencePool({}, "X"), []);
});

test("buildEvidencePool: 取得できた項目だけがevidenceになる", () => {
  const knowledge = {
    recentForm: [{ result: "勝ち" }, { result: "負け" }],
    injuries: [{ playerName: "Aさん", reason: "膝の負傷" }],
    transfers: [],
    formation: "4-3-3",
    coachName: "監督A",
    learnedFacts: [{ statement: "直近フォームが上昇" }],
  };
  const pool = buildEvidencePool(knowledge, "TeamX");
  assert.ok(pool.some((e) => e.category === "injuries"));
  assert.ok(pool.some((e) => e.category === "formation"));
  assert.ok(pool.some((e) => e.category === "coach"));
  assert.ok(!pool.some((e) => e.category === "transfers"), "空配列のtransfersはevidenceを作らないはず");
  assert.ok(pool.some((e) => e.statement.includes("直近フォームが上昇")));
});

test("buildEvidencePool: Knowledge Engineのfact/analysis/opinionが正しいtypeで取り込まれる", () => {
  const knowledge = {
    knowledgeEngine: {
      facts: [{ category: "form", statement: "事実X" }],
      analyses: [{ category: "form", statement: "分析Y" }],
      opinions: [{ category: "form", statement: "意見Z" }],
    },
  };
  const pool = buildEvidencePool(knowledge, "TeamX");
  assert.strictEqual(pool.find((e) => e.statement === "事実X").type, "fact");
  assert.strictEqual(pool.find((e) => e.statement === "分析Y").type, "analysis");
  assert.strictEqual(pool.find((e) => e.statement === "意見Z").type, "opinion");
});

test("generateHypotheses: 常にHYPOTHESIS_FACTORSの数(2026年8月拡張後は9つ)の観点を返す", () => {
  const hyps = generateHypotheses([], { teamJa: "テストFC" });
  assert.strictEqual(hyps.length, HYPOTHESIS_FACTORS.length);
  assert.ok(hyps.length >= 5, "ご要望③(最低5つ以上の仮説を立てて比較する)を満たすはず");
});

test("generateHypotheses: 根拠が無い観点は「根拠なし」の仮説を正直に返す(でっち上げない)", () => {
  const hyps = generateHypotheses([], { teamJa: "テストFC" });
  const injuryHyp = hyps.find((h) => h.id === "defense_injury");
  assert.strictEqual(injuryHyp.evidence.length, 0);
  assert.ok(injuryHyp.statement.includes("見当たらなかった"));
});

test("generateHypotheses: 該当する根拠だけがそれぞれの観点に紐づく", () => {
  const pool = [
    { category: "injuries", type: "fact", statement: "CBが離脱" },
    { category: "transfers", type: "fact", statement: "新加入選手" },
  ];
  const hyps = generateHypotheses(pool, { teamJa: "テストFC" });
  const injuryHyp = hyps.find((h) => h.id === "defense_injury");
  const transferHyp = hyps.find((h) => h.id === "squad_transfers");
  const tacticsHyp = hyps.find((h) => h.id === "tactics_formation");
  assert.strictEqual(injuryHyp.evidence.length, 1);
  assert.strictEqual(transferHyp.evidence.length, 1);
  assert.strictEqual(tacticsHyp.evidence.length, 0);
});

test("scoreEvidence: fact/analysis/opinionで重みが異なる(analysis > fact > opinion)", () => {
  const factScore = scoreEvidence([{ type: "fact" }]);
  const analysisScore = scoreEvidence([{ type: "analysis" }]);
  const opinionScore = scoreEvidence([{ type: "opinion" }]);
  assert.ok(analysisScore > factScore);
  assert.ok(factScore > opinionScore);
});

test("rankHypotheses: 根拠が多い(スコアが高い)仮説が先頭に来る", () => {
  const hyps = [
    { id: "a", evidence: [{ type: "fact" }] },
    { id: "b", evidence: [{ type: "fact" }, { type: "analysis" }] },
    { id: "c", evidence: [] },
  ];
  const ranked = rankHypotheses(hyps);
  assert.strictEqual(ranked[0].id, "b");
  assert.strictEqual(ranked[2].id, "c");
  assert.strictEqual(ranked[2].score, 0);
});

test("rankHypotheses: スコアが同点の場合は元の順序を維持する(安定ソート)", () => {
  const hyps = [
    { id: "a", evidence: [] },
    { id: "b", evidence: [] },
    { id: "c", evidence: [] },
  ];
  const ranked = rankHypotheses(hyps);
  assert.deepStrictEqual(ranked.map((h) => h.id), ["a", "b", "c"]);
});

test("runSelfCheck: 根拠が十分な場合はhasEnoughEvidence=true", () => {
  const ranked = rankHypotheses([
    { id: "a", evidence: [{ type: "fact" }] },
    { id: "b", evidence: [] },
    { id: "c", evidence: [] },
  ]);
  const check = runSelfCheck(ranked);
  assert.strictEqual(check.hasEnoughEvidence, true);
  assert.strictEqual(check.hasCounterargument, false, "2位に根拠が無いので反対意見なし");
});

test("runSelfCheck: 全ての仮説に根拠が無い場合は正直にhasEnoughEvidence=falseを返す", () => {
  const ranked = rankHypotheses([
    { id: "a", evidence: [] },
    { id: "b", evidence: [] },
    { id: "c", evidence: [] },
  ]);
  const check = runSelfCheck(ranked);
  assert.strictEqual(check.hasEnoughEvidence, false);
  assert.ok(check.verdict.includes("見つからなかった"));
});

test("assembleReasoning: 一連の流れが結合されて返る(選ばれた仮説が最高スコア)", () => {
  const pool = [
    { category: "injuries", type: "fact", statement: "CBが離脱" },
    { category: "injuries", type: "analysis", statement: "守備の連携が崩れていると分析済み" },
  ];
  const bundle = assembleReasoning(pool, { teamJa: "テストFC" });
  assert.strictEqual(bundle.selected.id, "defense_injury");
  assert.strictEqual(bundle.evidencePoolSize, 2);
  assert.strictEqual(bundle.selfCheck.hasEnoughEvidence, true);
});

test("formatReasoningForPrompt: 前回の結論と同じ場合は「変わっていない」と明示する", () => {
  const pool = [{ category: "injuries", type: "fact", statement: "CBが離脱" }];
  const bundle = assembleReasoning(pool, { teamJa: "テストFC" });
  const text = formatReasoningForPrompt(bundle, { statement: bundle.selected.statement });
  assert.ok(text.includes("考えは変わっていません"));
});

test("formatReasoningForPrompt: 前回の結論と異なる場合は変化に触れるよう促す文言を含む", () => {
  const pool = [{ category: "injuries", type: "fact", statement: "CBが離脱" }];
  const bundle = assembleReasoning(pool, { teamJa: "テストFC" });
  const text = formatReasoningForPrompt(bundle, { statement: "全く別の以前の結論" });
  assert.ok(text.includes("考えが変わった場合"));
  assert.ok(text.includes("全く別の以前の結論"));
});

test("formatReasoningForPrompt: 仮説が無い場合は空文字を返す", () => {
  assert.strictEqual(formatReasoningForPrompt(null, null), "");
});

console.log(failures === 0 ? "\nAll reasoning-engine tests PASSED." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
