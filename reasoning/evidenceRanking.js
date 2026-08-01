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
 * 正直な注記: これは統計的な有意性検定ではなく、単純な加重和による優先順位付け
 * です。根拠が0件の仮説はスコア0のまま最下位になります(でっち上げて底上げしない)。
 */
const TYPE_WEIGHT = { fact: 1.0, analysis: 1.5, opinion: 0.5 };

function scoreEvidence(evidenceList) {
  return (evidenceList || []).reduce((sum, e) => sum + (TYPE_WEIGHT[e.type] ?? 0.5), 0);
}

/**
 * @param {Array<{id, label, statement, evidence}>} hypotheses
 * @returns {Array<{..., score:number}>} スコア降順(同点は元の順序を維持)
 */
function rankHypotheses(hypotheses) {
  return (hypotheses || [])
    .map((h, idx) => ({ ...h, score: Math.round(scoreEvidence(h.evidence) * 100) / 100, _idx: idx }))
    .sort((a, b) => (b.score - a.score) || (a._idx - b._idx))
    .map(({ _idx, ...rest }) => rest);
}

module.exports = { rankHypotheses, scoreEvidence, TYPE_WEIGHT };
