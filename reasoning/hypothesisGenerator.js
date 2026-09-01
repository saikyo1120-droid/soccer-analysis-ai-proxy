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
 * 2026年8月・「議論できるAI」強化フェーズ: ご要望(「最低5つ以上の仮説を
 * 立てて比較してほしい」)に対応し、9つの観点(factor)に拡張した。怪我・
 * 移籍のような従来の3観点に加えて、戦術/フォーメーション・直近フォーム・
 * 監督・ホームアウェイ差・疲労(過密日程)・勢い(メンタルの代理指標)・
 * 順位を独立した観点として扱う。根拠が1件も見つからなかった観点は、正直に
 * 「根拠なし」の仮説として返す(存在しない根拠をでっち上げない)。
 *
 * 「相性(対戦相手との相性)」は、この層(単一クラブの議論モード)では
 * 対戦相手が定まっていないため評価できない。2クラブの組み合わせが分かる
 * AIマッチ分析(server.jsのhandleMatchAnalysis)側で、過去対戦成績という
 * 実データとして既に扱っている(README「議論できるAIへの強化」参照)。
 */

// 2026年8月・総点検で発見した重大な欠陥の修正:
// relevantCategories が、dailyJob.js が実際にKnowledge Engineへ保存している
// category 文字列(recentFormTrend / coachChange / transferImpact /
// matchReflection / predictionFailureReason / predictionSuccessReason /
// dailyAiView / playstyleAnalysis / predictionHypothesis /
// predictionContextualFailure)と一致していなかった。
// そのため**毎日蓄積してきた知識が推論に一度も使われず、全仮説のスコアが常に0**
// になっていた(Knowledge Engineが事実上「書き込み専用」だった)。
// 実際に保存されているcategoryを各観点へ割り当てて結線する。
const HYPOTHESIS_FACTORS = [
  {
    id: "defense_injury",
    label: "怪我・出場停止(守備陣・主力の状態)が原因という仮説",
    relevantCategories: ["injuries", "injury", "predictionContextualFailure"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の状態は、負傷・出場停止による選手の入れ替わりが影響している可能性がある。`
        : `${teamJa}について、負傷・出場停止に関する情報は見当たらなかった。`,
  },
  {
    id: "tactics_formation",
    label: "戦術・フォーメーションの変化が原因という仮説",
    relevantCategories: ["formation", "clubProfile", "playstyleAnalysis"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の結果は、フォーメーションや戦術的な方針(ビルドアップ・プレス・保持率等)が影響している可能性がある。`
        : `${teamJa}について、戦術・フォーメーションに関する情報は見当たらなかった。`,
  },
  {
    id: "squad_transfers",
    label: "移籍による戦力変化が原因という仮説",
    relevantCategories: ["transfers", "transferImpact"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の状態は、直近の移籍(加入・退団)による戦力変化が影響している可能性がある。`
        : `${teamJa}について、直近の移籍に関する情報は見当たらなかった。`,
  },
  {
    id: "recent_form",
    label: "直近フォーム(得失点差の推移)が原因という仮説",
    relevantCategories: ["recentForm", "recentFormTrend", "matchReflection"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の直近の試合結果の推移そのものが、現在の評価に直接影響している可能性がある。`
        : `${teamJa}について、直近の試合結果の推移に関する情報は見当たらなかった。`,
  },
  {
    id: "coach",
    label: "監督(采配・就任時期)が原因という仮説",
    relevantCategories: ["coach", "coachChange", "managerHistory"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の状態は、現在の監督の采配方針が影響している可能性がある。`
        : `${teamJa}について、監督に関する情報は見当たらなかった。`,
  },
  {
    id: "home_away",
    label: "ホーム/アウェイの違いが原因という仮説",
    relevantCategories: ["homeAway"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}はホームとアウェイで成績差が大きく、開催地が結果に影響している可能性がある。`
        : `${teamJa}について、ホーム/アウェイの明確な成績差は確認できなかった。`,
  },
  {
    id: "fatigue",
    label: "過密日程・疲労が原因という仮説",
    relevantCategories: ["fatigue"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}は直近の試合間隔が短く、疲労の蓄積が影響している可能性がある。`
        : `${teamJa}について、過密日程を示す情報は見当たらなかった。`,
  },
  {
    id: "momentum",
    label: "勢い・メンタル面(連続結果)が原因という仮説",
    relevantCategories: ["streak", "predictionFailureReason", "predictionSuccessReason"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}は結果が連続しており、勢い(またはその逆の重圧)がメンタル面に影響している可能性がある。`
        : `${teamJa}について、連続した結果(勢いの根拠になるもの)は確認できなかった。`,
  },
  {
    id: "standings",
    label: "リーグ順位・置かれた状況が原因という仮説",
    // 第6次監査での追加: leagueTopScorers / leagueTopAssists は毎日保存されて
    // いるのに、どの仮説の relevantCategories にも入っておらず、根拠として
    // 一度も使われていなかった。得点・アシストのランキングは
    // 「そのクラブがリーグの中でどういう位置にいるか」を示す実データなので、
    // この仮説の根拠に含める。
    relevantCategories: ["standings", "leagueStandings", "leagueTopScorers", "leagueTopAssists", "dailyAiView", "predictionHypothesis"],
    buildStatement: (teamJa, matched) =>
      matched.length
        ? `${teamJa}の現在のリーグ順位が、モチベーションや戦い方の選択に影響している可能性がある。`
        : `${teamJa}について、現在の順位に関する情報は見当たらなかった(質問文に順位への言及が無かった可能性があります)。`,
  },
];

// ---- v78(2026年9月1日・利用者の承認 案2): 選手の質問用の観点 ----
//   6段階の熟考をクラブ専用から選手にも拡張する。クラブ用と同じ設計思想:
//   観点は固定テンプレート、各観点にどれだけ「実際に取得できた根拠」が
//   集まるかは毎回の実データ次第(存在しない根拠はでっち上げない)。
//   カテゴリ名は buildPlayerEvidencePool(evidencePool.js)の出力と厳密に対応
//   させる(過去の監査で繰り返し起きた「カテゴリ名の不一致で根拠が全部
//   捨てられる」事故を防ぐため、v78のテストで対応関係を固定する)。
const PLAYER_HYPOTHESIS_FACTORS = [
  {
    id: "player_scoring",
    label: "得点関与(ゴール・アシスト)が評価の中心という見立て",
    relevantCategories: ["playerScoring", "playerSeasonStats"],
    buildStatement: (nameJa, matched) =>
      matched.length
        ? `${nameJa}の現在の評価は、今シーズンの得点・アシストという直接の数字に支えられている可能性が高い。`
        : `${nameJa}の得点関与を示す実データは見当たらなかった。`,
  },
  {
    id: "player_creation",
    label: "チャンスメイク・ボール技術が持ち味という見立て",
    relevantCategories: ["playerCreation"],
    buildStatement: (nameJa, matched) =>
      matched.length
        ? `${nameJa}はキーパス・パス精度・仕掛けなど、得点の一つ手前の貢献が持ち味である可能性がある。`
        : `${nameJa}のチャンスメイクに関する実データは見当たらなかった。`,
  },
  {
    id: "player_defense",
    label: "守備貢献・対人の強さが持ち味という見立て",
    relevantCategories: ["playerDefense"],
    buildStatement: (nameJa, matched) =>
      matched.length
        ? `${nameJa}はタックル・インターセプト・デュエルなど、守備側の実測が評価を支えている可能性がある。`
        : `${nameJa}の守備・対人に関する実データは見当たらなかった。`,
  },
  {
    id: "player_consistency",
    label: "試合ごとの安定感(平均評価)が評価を支えているという見立て",
    relevantCategories: ["playerRating"],
    buildStatement: (nameJa, matched) =>
      matched.length
        ? `${nameJa}は試合ごとの平均レーティングという「安定して計算できる働き」が評価につながっている可能性がある。`
        : `${nameJa}の試合評価(平均レーティング)は取得できなかった。`,
  },
  {
    id: "player_opportunity",
    label: "出場機会・起用のされ方が現状を左右しているという見立て",
    relevantCategories: ["playerOpportunity", "playerProfile"],
    buildStatement: (nameJa, matched) =>
      matched.length
        ? `${nameJa}の現状は、出場機会(起用のされ方)そのものに左右されている可能性がある。`
        : `${nameJa}の出場機会に関する実データは見当たらなかった。`,
  },
  {
    id: "player_club_situation",
    label: "所属クラブの状況が影響しているという見立て",
    relevantCategories: ["clubContext"],
    buildStatement: (nameJa, matched) =>
      matched.length
        ? `${nameJa}個人の数字だけでなく、所属クラブの現在の状況(調子・順位など)が影響している可能性がある。`
        : `${nameJa}の所属クラブの状況を示すデータは見当たらなかった。`,
  },
];

/**
 * @param {Array} evidencePool - buildEvidencePool()の出力
 * @param {{teamJa?: string, teamEn?: string}} teamInfo
 * @param {Array} factors - 観点の一覧(省略時は従来どおりクラブ用。v78で選手用を追加)
 * @returns {Array<{id, label, statement, evidence: Array}>}
 */
function generateHypotheses(evidencePool, teamInfo, factors) {
  const pool = evidencePool || [];
  const teamJa = (teamInfo && teamInfo.teamJa) || (teamInfo && teamInfo.teamEn) || "対象クラブ";
  const factorList = (Array.isArray(factors) && factors.length) ? factors : HYPOTHESIS_FACTORS;
  return factorList.map((factor) => {
    const matched = pool.filter((e) => factor.relevantCategories.includes(e.category));
    return {
      id: factor.id,
      label: factor.label,
      statement: factor.buildStatement(teamJa, matched),
      evidence: matched,
    };
  });
}

module.exports = { generateHypotheses, HYPOTHESIS_FACTORS, PLAYER_HYPOTHESIS_FACTORS };
