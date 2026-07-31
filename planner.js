/**
 * Planner ― 質問を解析し「この質問に必要な情報は何か」を決めてからRAG検索に
 * 渡す層です。
 * ----------------------------------------------------------------
 * 設計方針(ご指示):
 *   質問 → Intent → Planner → RAG → LLM
 * Plannerが先に「何を取得すべきか」を決めることで、毎回すべての知識を無条件に
 * 取得するのではなく、必要なものだけをRAGに取りに行かせます。これにより
 * ①API呼び出し回数(コスト・クォータ)を抑える、②LLMに渡す情報量を絞って
 * 精度と速度を上げる、という2つの効果があります。
 *
 * Planner自体はキーワード・パターンマッチによるルールベースです(LLMを使わない)。
 * これも設計方針の一部で、「考察」を要する部分だけにLLMコストを使うためです。
 */

// クラブに関する質問で使える知識の種類と、それを示唆するキーワード。
const CLUB_NEED_TRIGGERS = [
  { need: "injuries", pattern: /怪我|負傷|離脱|出場停止|欠場|コンディション/ },
  { need: "transfers", pattern: /移籍|加入|退団|補強|放出/ },
  { need: "coach", pattern: /監督|采配|指揮官|解任|更迭/ },
  { need: "formation", pattern: /フォーメーション|布陣|システム|戦術|陣形/ },
  { need: "recentForm", pattern: /得点|失点|守備|攻撃|連勝|連敗|勝率|調子|成績|結果/ },
];

// クラブに関する質問なら、少なくともこれらは基本セットとして常に含める
// (「弱い/強い/どう思う」のような一般的な意見・考察の質問に対応するため)。
const CLUB_BASE_NEEDS = ["recentForm", "coach", "injuries"];

/**
 * @param {string} question - 利用者の質問文
 * @param {{type: ("club"|"player"|null), labelJa?: string, labelEn?: string}} subject
 * @returns {{needs: string[], reasoning: string}}
 */
function planInformationNeeds(question, subject) {
  const q = String(question || "");
  const type = subject && subject.type;

  if (type === "player") {
    return {
      needs: ["playerSeasonStats"],
      reasoning: "選手についての質問のため、今シーズンの実成績データ(出場数・得点・アシスト・平均レーティング)を取得します。",
    };
  }

  if (type === "club") {
    const matched = CLUB_NEED_TRIGGERS.filter((t) => t.pattern.test(q)).map((t) => t.need);
    const needs = Array.from(new Set([...CLUB_BASE_NEEDS, ...matched]));
    const reasonParts = [];
    reasonParts.push("クラブに関する質問のため、直近の試合結果・監督情報・負傷者情報を基本セットとして取得します。");
    if (matched.length) {
      reasonParts.push(`質問文から特に関連が強いと判断した項目: ${matched.join("・")}`);
    }
    return { needs, reasoning: reasonParts.join(" ") };
  }

  // クラブでも選手でもない質問(例: 「なぜ4-3-3が主流なの？」のような一般的な
  // 戦術論)。特定の実データに紐づかないため、RAGは呼ばずLLMの一般知識のみで
  // 答える(その旨は回答の信頼度・根拠欄で正直に示す)。
  return {
    needs: [],
    reasoning: "特定のクラブ・選手に紐づく質問ではないため、実データの取得は行わず、一般的なサッカーの知識に基づいて考察します。",
  };
}

module.exports = { planInformationNeeds, CLUB_NEED_TRIGGERS, CLUB_BASE_NEEDS };
