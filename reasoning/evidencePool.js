/**
 * server/reasoning/evidencePool.js
 * ------------------------------------------------
 * RAG(server/rag/knowledgeSource.js)が集めた「今取得した実データ」と、
 * Knowledge Engine(server/knowledge/knowledgeStore.js)が蓄積している
 * 「過去に確認済みの事実・分析・意見」を、Hypothesis Generator / Evidence
 * Ranking が扱いやすい共通の形(evidence item)に正規化する層です。
 *
 * evidence item の形: { category, type, statement, teamEn, weight }
 *   category: "recentForm" | "injuries" | "transfers" | "formation" | "coach"
 *   type: "fact" | "analysis" | "opinion" (Knowledge Engineの3分類をそのまま踏襲)
 *   statement: 日本語の短い説明文
 *   weight: このモジュールでは付与しない(Evidence Rankingが type ごとに重み付けする)
 *
 * 正直な注記: ここでは「取得できた実データを要約するだけ」で、新しい事実を
 * 作り出したり、数字を推測で埋めたりはしません。取得できなかった項目は
 * evidence item を作らない(=何も無いことを正直に表す)。
 */

function buildEvidencePool(knowledge, teamEn) {
  const pool = [];
  if (!knowledge) return pool;

  if (knowledge.recentForm && knowledge.recentForm.length) {
    const w = knowledge.recentForm.filter((m) => m.result === "勝ち").length;
    const d = knowledge.recentForm.filter((m) => m.result === "分け").length;
    const l = knowledge.recentForm.filter((m) => m.result === "負け").length;
    // 「直近成績」は1カテゴリにつき1件のevidenceにまとめる(W/D/L要約と平均失点を
    // 別々のevidenceにすると、他のカテゴリ(怪我・移籍など、常に1件にまとまる)に
    // 対してrecentFormの点数が不当に膨らんでしまうため。Evidence Rankingの
    // 「件数が多いほど根拠が強い」という前提が、カテゴリ間で公平になるようにする)。
    let recentFormStatement = `直近${knowledge.recentForm.length}試合の成績は${w}勝${d}分${l}敗。`;
    if (knowledge.goalsAgainstTrend && knowledge.goalsAgainstTrend.length) {
      const avgGa = knowledge.goalsAgainstTrend.reduce((a, b) => a + b, 0) / knowledge.goalsAgainstTrend.length;
      recentFormStatement += `直近${knowledge.goalsAgainstTrend.length}試合の平均失点は${avgGa.toFixed(2)}。`;
    }
    pool.push({ category: "recentForm", type: "fact", teamEn, statement: recentFormStatement });
  }

  if (knowledge.injuries && knowledge.injuries.length) {
    pool.push({
      category: "injuries", type: "fact", teamEn,
      statement: `負傷・出場停止: ${knowledge.injuries.map((i) => `${i.playerName}(${i.reason || i.type || "詳細不明"})`).join("、")}。`,
    });
  }

  if (knowledge.transfers && knowledge.transfers.length) {
    pool.push({
      category: "transfers", type: "fact", teamEn,
      statement: `直近の移籍: ${knowledge.transfers.map((t) => `${t.playerName}(${t.direction})`).join("、")}。`,
    });
  }

  if (knowledge.formation) {
    pool.push({ category: "formation", type: "fact", teamEn, statement: `直近試合のフォーメーション: ${knowledge.formation}。` });
  }

  if (knowledge.coachName) {
    pool.push({ category: "coach", type: "fact", teamEn, statement: `現在の監督: ${knowledge.coachName}。` });
  }

  // 毎日学習エンジン(dailyJob.js)がKnowledge Engine経由で蓄積した「事実」
  // (直近フォームの変化など)。既にKnowledge Engineの重複排除・失効管理を
  // 経ているため、そのまま evidence として扱える。
  if (knowledge.learnedFacts && knowledge.learnedFacts.length) {
    knowledge.learnedFacts.forEach((f) => {
      pool.push({ category: "recentForm", type: "fact", teamEn, statement: f.statement });
    });
  }

  // Knowledge Engine(server/knowledge/knowledgeStore.js)に蓄積されている
  // 「現在アクティブな知識」(fact/analysis/opinion)。dailyJob.jsが保存した
  // ものや、過去の議論モードでAIが導いた分析(analysis)が含まれる。
  const ke = knowledge.knowledgeEngine;
  if (ke) {
    (ke.facts || []).forEach((item) => pool.push({ category: item.category || "recentForm", type: "fact", teamEn, statement: item.statement }));
    (ke.analyses || []).forEach((item) => pool.push({ category: item.category || "recentForm", type: "analysis", teamEn, statement: item.statement }));
    (ke.opinions || []).forEach((item) => pool.push({ category: item.category || "recentForm", type: "opinion", teamEn, statement: item.statement }));
  }

  return pool;
}

module.exports = { buildEvidencePool };
