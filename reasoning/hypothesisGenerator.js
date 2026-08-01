/**
 * server/reasoning/hypothesisGenerator.js
 * ------------------------------------------------
 * Hypothesis Generator ― 回答を書く前に、AIが内部的に「複数の説明の可能性
 * (仮説)」を立てる層。利用者には仮説A/B/Cという形では見せず、最終的な文章
 * (③根拠④考察⑤結論)を書くための材料として使う。
 *
 * 正直な設計判断(重要・利用者に開示済み):
 *   このHypothesis GeneratorはLLMを呼び出しません。あらかじめ用意した
 *   「説明の観点(factor)」のテンプレートに、実際に取得できた根拠(evidence pool)
 *   を機械的に当てはめるルールベースの実装です。理由は2つ:
 *     ①質問1件ごとに複数のLLM呼び出しを追加すると、このプロジェクトが最優先
 *       としている「コスト最適化」に反する(現状: 1質問=LLM1回のまま維持)。
 *     ②観点そのものは固定でも、各観点にどれだけ実際の根拠が集まるかは毎回の
 *       実データ次第なので、「根拠に基づいて選ばれた仮説」という実質は保たれる。
 *   将来、要件が「仮説の内容自体をAIに自由に発想させたい」に変わった場合は、
 *   ここをLLM呼び出しに置き換える拡張ポイントとして分離してある。
 *
 * 常に3つの観点(factor)から仮説を生成する(利用者の要望「最低3つの仮説」に
 * 対応)。ただし、根拠が1件も見つからなかった観点は、正直に「根拠なし」の仮説
 * として返す(存在しない根拠をでっち上げない)。
 */

const HYPOTHESIS_FACTORS = [
  {
    id: "defense_injury",
    label: "守備陣の状態(負傷・出場停止)が原因という仮説",
    relevantCategories: ["injuries"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の守備の状態は、負傷・出場停止による選手の入れ替わりが影響している可能性がある。`
        : `${teamJa}について、負傷・出場停止に関する情報は見当たらなかった。`,
  },
  {
    id: "form_tactics",
    label: "直近のフォーム・戦術(フォーメーション)の変化が原因という仮説",
    // 注: 「監督の在籍」自体(coach)は変化の根拠にならないため含めない。フォーメーション
    // (formation)は実際に取得できた場合のみ根拠になる(質問がフォーメーションに
    // 言及した場合など)。各カテゴリは1回のRAG取得につきevidenceを最大1件しか
    // 生成しないため、他のカテゴリ(injuries/transfers)と点数のスケールが揃う。
    relevantCategories: ["recentForm", "formation"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の直近の結果は、フォームの変化やフォーメーション・采配の傾向が影響している可能性がある。`
        : `${teamJa}について、直近フォームやフォーメーションに関する情報は見当たらなかった。`,
  },
  {
    id: "squad_transfers",
    label: "移籍による戦力変化が原因という仮説",
    relevantCategories: ["transfers"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の状態は、直近の移籍(加入・退団)による戦力変化が影響している可能性がある。`
        : `${teamJa}について、直近の移籍に関する情報は見当たらなかった。`,
  },
];

/**
 * @param {Array} evidencePool - buildEvidencePool()の出力
 * @param {{teamJa?: string, teamEn?: string}} teamInfo
 * @returns {Array<{id, label, statement, evidence: Array}>}
 */
function generateHypotheses(evidencePool, teamInfo) {
  const pool = evidencePool || [];
  const teamJa = (teamInfo && teamInfo.teamJa) || (teamInfo && teamInfo.teamEn) || "対象クラブ";
  return HYPOTHESIS_FACTORS.map((factor) => {
    const matched = pool.filter((e) => factor.relevantCategories.includes(e.category));
    return {
      id: factor.id,
      label: factor.label,
      statement: factor.buildStatement(teamJa, matched),
      evidence: matched,
    };
  });
}

module.exports = { generateHypotheses, HYPOTHESIS_FACTORS };
