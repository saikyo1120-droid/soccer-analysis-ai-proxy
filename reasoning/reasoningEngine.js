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
 * @returns {{hypotheses, selected, selfCheck, evidencePoolSize}}
 */
function assembleReasoning(evidencePool, teamInfo) {
  const hypotheses = generateHypotheses(evidencePool, teamInfo);
  const ranked = rankHypotheses(hypotheses);
  const selfCheck = runSelfCheck(ranked);
  return {
    hypotheses: ranked,
    selected: ranked[0] || null,
    selfCheck,
    evidencePoolSize: (evidencePool || []).length,
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
