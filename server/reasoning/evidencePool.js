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

  // 2026年8月・「議論できるAI」強化フェーズ: Reasoning Engineが最低5つ以上の
  // 仮説を比較検討できるよう、疲労・ホームアウェイ差・勢い・順位を新しい
  // evidenceカテゴリとして追加する(いずれも実データのみ・推測は含まない)。
  if (knowledge.fatigue && knowledge.fatigue.matchesLast7Days >= 3) {
    pool.push({ category: "fatigue", type: "fact", teamEn, statement: `直近7日間で${knowledge.fatigue.matchesLast7Days}試合をこなしており、過密日程の可能性がある。` });
  }

  if (knowledge.homeAwaySplit) {
    const { home, away } = knowledge.homeAwaySplit;
    if (home.sampleSize >= 2 && away.sampleSize >= 2 && home.winRate !== null && away.winRate !== null && Math.abs(home.winRate - away.winRate) >= 0.2) {
      pool.push({
        category: "homeAway", type: "fact", teamEn,
        statement: `直近${home.sampleSize}試合のホーム勝率${Math.round(home.winRate * 100)}%に対し、直近${away.sampleSize}試合のアウェイ勝率は${Math.round(away.winRate * 100)}%と、${home.winRate > away.winRate ? "ホームでの強さ" : "アウェイでの粘り強さ"}が目立つ。`,
      });
    }
  }

  if (knowledge.streak) {
    pool.push({ category: "streak", type: "fact", teamEn, statement: `直近${knowledge.streak.count}試合連続で「${knowledge.streak.result}」が続いている。` });
  }

  if (knowledge.standings && knowledge.standings.position !== null) {
    pool.push({
      category: "standings", type: "fact", teamEn,
      statement: `現在の順位は${knowledge.standings.position}位(勝点${knowledge.standings.points ?? "不明"}、${knowledge.standings.played ?? "不明"}試合消化)。`,
    });
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
    // 第5次監査で発見した最も重大な「でっち上げ」経路の修正。
    //   これまでは Layer2(クラブプロフィール)を無条件に analysis 扱いにしていた。
    //   ところが Layer2 は**実データが1件も無いときにLLMへ
    //   「一般的なサッカーの知識のみに基づいて推定してください」と指示して
    //   生成させた文章**を含む。その推定文が重み1.5(実データの1.0より上)で
    //   採点され、しかも熟考エンジンの本文では「実データ」と呼ばれていた。
    //   結果、実データ0%でもAIが自信を持って「私は○○が最も重要だと考えます」と
    //   断言してしまう状態だった。
    //   AI生成の推定は、実データより明確に低い重み(aiEstimate)で扱う。
    const typeFor = (item, fallback) => (item && item.isAiGenerated ? "aiEstimate" : fallback);
    const push = (item, category, type) => pool.push({
      category: item.category || category, type, teamEn, statement: item.statement,
      isAiGenerated: !!item.isAiGenerated,
    });
    (ke.facts || []).forEach((item) => push(item, "recentForm", typeFor(item, "fact")));
    (ke.analyses || []).forEach((item) => push(item, "recentForm", typeFor(item, "analysis")));
    (ke.opinions || []).forEach((item) => push(item, "recentForm", typeFor(item, "opinion")));
    // Layer2(固定知識プロフィール)・Layer4(振り返り)も根拠プールに含める。
    // ただしLayer2はAI推定を含むため、上記の判定で自動的に aiEstimate になる。
    (ke.profiles || []).forEach((item) => push(item, "clubProfile", typeFor(item, "analysis")));
    (ke.reflections || []).forEach((item) => push(item, "matchReflection", typeFor(item, "analysis")));
  }

  return pool;
}

module.exports = { buildEvidencePool };
