/**
 * server/reasoning/reasoningEngine.js
 * ------------------------------------------------
 * Reasoning Engine ― Hypothesis Generator と Evidence Ranking を束ね、
 * 「回答を書く前にAIが考える」工程をひとまとめにする層。
 *
 * 新しいパイプライン: 質問 → Planner → Knowledge Engine(RAG経由) →
 *   Hypothesis Generator → Evidence Ranking → ★Reasoning Engine(ここ)★ → LLM
 *
 * LLMは最終的な文章を書く担当であり、「何を根拠に何を考えるか」はここまでの
 * ルールベースの層で先に決めておく、という設計方針をそのまま実装したもの。
 *
 * 自己チェック(利用者には見せない内部処理。ご要望の「回答を書く前にチェック」):
 *   - hasEnoughEvidence: 採用した仮説に、根拠が1件以上あるか
 *   - consideredAlternatives: 他の仮説(観点)も検討したか(常にtrue。3観点は必ず検討する)
 *   - hasCounterargument: 2位の仮説にも根拠があるか(=単一の見方に偏っていないか)
 *   - verdict: 上記を踏まえた一言診断(正直な文言。過大に自信を示さない)
 */
const { generateHypotheses } = require("./hypothesisGenerator");
const { rankHypotheses } = require("./evidenceRanking");

function runSelfCheck(rankedHypotheses) {
  const selected = rankedHypotheses[0] || null;
  const runnerUp = rankedHypotheses[1] || null;
  const hasEnoughEvidence = !!selected && selected.score > 0;
  const consideredAlternatives = rankedHypotheses.length > 1;
  const hasCounterargument = !!runnerUp && runnerUp.score > 0;

  let verdict;
  if (!hasEnoughEvidence) {
    verdict = "採用できる仮説について実データの根拠が見つからなかった。一般的な見方として述べるべき。";
  } else if (hasCounterargument) {
    verdict = "根拠が最も強い仮説を採用するが、他の仮説にも一定の根拠があるため、単一要因と断定しない。";
  } else {
    verdict = "根拠が最も強い仮説を採用する。他の仮説は根拠に乏しいため参考程度に留める。";
  }

  return { hasEnoughEvidence, consideredAlternatives, hasCounterargument, verdict };
}

/**
 * @param {Array} evidencePool - buildEvidencePool()の出力
 * @param {{teamJa?: string, teamEn?: string}} teamInfo
 * @param {{factors?: Array}} opts - v78(案2): 選手用など観点一覧の差し替え(省略時=クラブ用で従来どおり)
 * @returns {{hypotheses, selected, selfCheck, evidencePoolSize}}
 */
function assembleReasoning(evidencePool, teamInfo, opts) {
  const hypotheses = generateHypotheses(evidencePool, teamInfo, opts && opts.factors);
  const ranked = rankHypotheses(hypotheses);
  const selfCheck = runSelfCheck(ranked);

  // ---- 第5次監査で指摘された「監視の穴」への対応 ----
  //   これまでの監査で、同じ種類の欠陥が繰り返し見つかっている:
  //   「知識は正しく保存されているのに、仮説側が探しているカテゴリ名と
  //     一致しないため、すべての仮説がスコア0のまま静かに捨てられていた」。
  //   この状態は例外も出ず画面上も普通に見えるため、誰も気づけなかった。
  //   根拠が1件以上あるのに全仮説が0点、という状況は必ず配線ミスなので、
  //   その場で警告を出し、次からは即座に気づけるようにする。
  const pool = evidencePool || [];
  let orphanCategories = [];
  if (pool.length > 0 && ranked.length > 0 && ranked.every((h) => (h.score || 0) === 0)) {
    const matched = new Set();
    for (const h of ranked) for (const e of h.evidence || []) if (e && e.category) matched.add(e.category);
    orphanCategories = Array.from(new Set(
      pool.map((e) => e && e.category).filter((c) => c && !matched.has(c))
    ));
    console.warn(
      `[reasoning] 根拠が${pool.length}件あるのに、すべての仮説のスコアが0でした。` +
      "知識のカテゴリ名と hypothesisGenerator.js の relevantCategories が一致していない可能性があります。" +
      `未対応のカテゴリ: ${orphanCategories.join(", ") || "(不明)"}`
    );
  }

  return {
    hypotheses: ranked,
    selected: ranked[0] || null,
    selfCheck,
    evidencePoolSize: pool.length,
    // 配線ミスの検知結果(/api/discuss の meta にも載せて外から確認できるようにする)
    orphanCategories,
  };
}

/**
 * Reasoning Engineの結果を、LLMのuserPromptに渡すための内部専用テキストに
 * 整形する。利用者向けの表示テキストではない(LLMへの参考情報)。
 */
function formatReasoningForPrompt(bundle, previousConclusion) {
  if (!bundle || !bundle.selected) return "";
  const lines = [];
  lines.push("（以下は内部的に検討した観点です。この観点ラベル自体を回答にそのまま書き写す必要はありません。回答の質を上げるための参考情報として使ってください。）");
  bundle.hypotheses.forEach((h, i) => {
    lines.push(`観点${i + 1}「${h.label}」(根拠${h.evidence.length}件, スコア${h.score}): ${h.statement}`);
  });
  lines.push(`→ 最も根拠が強い観点は「${bundle.selected.label}」です。`);
  lines.push(`自己チェック: ${bundle.selfCheck.verdict}`);
  if (previousConclusion && previousConclusion.statement) {
    if (previousConclusion.statement === bundle.selected.statement) {
      lines.push(`AIが前回下した結論と、今回最も根拠が強い観点は同じ内容です(考えは変わっていません)。`);
    } else {
      lines.push(`AIが前回下した結論: 「${previousConclusion.statement}」。今回は根拠の状況が変わり、上記の観点の方が根拠が強くなっています。考えが変わった場合はその旨に触れてください。`);
    }
  }
  return lines.join("\n");
}

module.exports = { assembleReasoning, runSelfCheck, formatReasoningForPrompt };
