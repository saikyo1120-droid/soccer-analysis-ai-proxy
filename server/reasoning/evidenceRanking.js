/**
 * server/reasoning/evidenceRanking.js
 * ------------------------------------------------
 * Evidence Ranking ― Hypothesis Generatorが立てた複数の仮説を、集まった
 * 根拠(evidence)の「量」と「質」でスコア化し、最も根拠が強い仮説を選ぶ層。
 *
 * 重み付けの考え方(ルールベース・説明可能):
 *   fact(客観的事実)     = 1.0
 *   analysis(検証済み分析) = 1.5  … Hypothesis Engine(dailyJob.js)が過去に
 *                                    実際の試合結果で検証済みの分析のため、
 *                                    単なる事実の並びより重く扱う
 *   opinion(AIの主観的意見) = 0.5  … 参考程度に留める
 *
 *   aiEstimate(AIが実データ無しで推定した内容) = 0.2
 *     … 2026年8月の第5次監査で追加。クラブプロフィール(Layer2)は、実データが
 *       1件も取れなかった場合にLLMへ「一般的なサッカーの知識のみに基づいて
 *       推定してください」と指示して生成させた文章を含む。それが従来
 *       analysis(1.5)として**実データ(1.0)より重く**採点されており、
 *       実データ0%の状態でもAIが自信を持って断言してしまう原因になっていた。
 *       推定は実データではないので、参考程度の重みに下げる。
 *
 * 正直な注記: これは統計的な有意性検定ではなく、単純な加重和による優先順位付け
 * です。根拠が0件の仮説はスコア0のまま最下位になります(でっち上げて底上げしない)。
 */
const TYPE_WEIGHT = { fact: 1.0, analysis: 1.5, opinion: 0.5, aiEstimate: 0.2 };
// 「実データに裏づけられた根拠」の種類(AIが自分で作り出したものではないもの)。
// 熟考エンジンが「断言してよいか」を判断するために使う。
const FACTUAL_TYPES = new Set(["fact", "analysis"]);

function scoreEvidence(evidenceList) {
  return (evidenceList || []).reduce((sum, e) => sum + (TYPE_WEIGHT[e.type] ?? 0.5), 0);
}

/** その仮説が実データに裏づけられている件数(AI推定・AIの意見は数えない) */
function countFactualEvidence(evidenceList) {
  return (evidenceList || []).filter((e) => e && FACTUAL_TYPES.has(e.type) && !e.isAiGenerated).length;
}

/**
 * @param {Array<{id, label, statement, evidence}>} hypotheses
 * @returns {Array<{..., score:number, factualCount:number}>} スコア降順(同点は元の順序を維持)
 */
function rankHypotheses(hypotheses) {
  return (hypotheses || [])
    .map((h, idx) => ({
      ...h,
      score: Math.round(scoreEvidence(h.evidence) * 100) / 100,
      factualCount: countFactualEvidence(h.evidence),
      _idx: idx,
    }))
    .sort((a, b) => (b.score - a.score) || (a._idx - b._idx))
    .map(({ _idx, ...rest }) => rest);
}

module.exports = { rankHypotheses, scoreEvidence, countFactualEvidence, TYPE_WEIGHT, FACTUAL_TYPES };
