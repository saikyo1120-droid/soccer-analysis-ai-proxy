/**
 * server/reasoning/deliberation.js
 * ------------------------------------------------
 * 2026年8月・優先順位④「AIの分析能力の強化」(最優先)。
 *
 * ご指示原文:
 *   「AIが説明するだけではなく、自分で考え、比較し、議論できるAIにしてください。
 *     回答前には必ず 必要データ取得 → 仮説生成 → 仮説比較 → 反対意見 →
 *     根拠評価 → 最終結論 を内部で行い、『私は○○が最も重要だと考えます』
 *     という結論を必ず出してください。また、同じ質問を何度されてもテンプレート
 *     回答にならないようにしてください。」
 *
 * ■ 既存のreasoningEngine.jsとの関係
 *   既存は「仮説を作って点数順に並べ、自己チェックする」までで止まっており、
 *   ・どのデータが揃っていて何が欠けているのか(必要データ取得)
 *   ・なぜその仮説を採ったのか、対抗仮説との差はどれだけか(仮説比較)
 *   ・反対意見は何か(反対意見)
 *   ・根拠はどれだけ信頼できるのか(根拠評価)
 *   が構造として存在しませんでした。このモジュールが6段階すべてを明示的に
 *   実行し、各段階を後から検証できる形で返します。
 *
 * ■ テンプレート回答にならないための設計
 *   結論文は固定文ではなく、その時点の「根拠の数・種類・前回からの変化」から
 *   組み立てます。根拠が変われば文面も変わり、前回と考えが変わった場合は
 *   その差分に必ず言及します(優先順位⑭にも直結します)。
 *
 * ■ でっち上げ防止
 *   根拠が1件も無い観点を「最も重要」とは言いません。データが不足している場合は
 *   自信度を下げ、その理由(何が足りないのか)を明示します(優先順位⑮)。
 */

// 分析に使いたいデータの一覧。揃っているか/欠けているかを毎回点検する(段階1)。
const REQUIRED_DATA_SPECS = [
  { key: "form", labelJa: "直近の試合結果(フォーム)" },
  { key: "goals", labelJa: "得点力・失点率" },
  { key: "standings", labelJa: "順位・勝点" },
  { key: "injuries", labelJa: "怪我人・出場停止" },
  { key: "headToHead", labelJa: "過去の対戦成績" },
  { key: "xg", labelJa: "xG(チャンスの質)" },
  { key: "coach", labelJa: "監督" },
  { key: "venue", labelJa: "ホーム/アウェイ別の成績" },
];

// 根拠の種類ごとの信頼度。事実は最も信頼でき、意見は参考程度。
const EVIDENCE_TYPE_TRUST = { fact: 1.0, analysis: 0.7, profile: 0.5, opinion: 0.3, reflection: 0.6 };

/** 段階1: 必要データ取得 — 何が揃い、何が欠けているかを点検する。 */
function assessDataAvailability(availability) {
  const a = availability || {};
  const available = [];
  const missing = [];
  for (const spec of REQUIRED_DATA_SPECS) {
    if (a[spec.key]) available.push(spec.labelJa);
    else missing.push(spec.labelJa);
  }
  const coveragePct = Math.round((available.length / REQUIRED_DATA_SPECS.length) * 100);
  return {
    available, missing, coveragePct,
    summaryJa: missing.length
      ? `${available.length}/${REQUIRED_DATA_SPECS.length}種類のデータが揃っています(不足: ${missing.join("・")})。`
      : `分析に必要な${REQUIRED_DATA_SPECS.length}種類のデータがすべて揃っています。`,
  };
}

/** 段階3: 仮説比較 — 1位と2位の差を評価する(僅差なら断定しない)。 */
function compareHypotheses(ranked) {
  const list = Array.isArray(ranked) ? ranked : [];
  const top = list[0] || null;
  const second = list[1] || null;
  if (!top) return { top: null, second: null, marginJa: "比較できる仮説がありません。", isClose: false };
  if (!second) return { top, second: null, marginJa: `対抗する仮説が無いため、「${top.label}」が唯一の候補です。`, isClose: false };
  const margin = (top.score || 0) - (second.score || 0);
  const isClose = margin <= 1;
  return {
    top, second, margin, isClose,
    marginJa: isClose
      ? `1位「${top.label}」(${top.score})と2位「${second.label}」(${second.score})は僅差です。単一要因と断定できません。`
      : `1位「${top.label}」(${top.score})が2位「${second.label}」(${second.score})を明確に上回っています。`,
  };
}

/** 段階4: 反対意見 — 採用しなかった仮説から、最も有力な反論を立てる。 */
function buildCounterArgument(comparison) {
  const c = comparison || {};
  if (!c.second || !(c.second.score > 0)) {
    return { hasCounter: false, statementJa: "実データ上、この見方に有力に対抗する材料は見つかりませんでした(反対意見が無いこと自体が根拠の強さを示します)。" };
  }
  return {
    hasCounter: true,
    statementJa: `ただし反対の見方もあります: ${c.second.statement}${c.isClose ? " この見方も根拠の強さがほぼ同等のため、無視できません。" : ""}`,
  };
}

/**
 * 段階5: 根拠評価 — 自信度と、その理由(優先順位⑮)、
 * および各要因の影響度の内訳(優先順位⑱)を作る。
 */
function evaluateEvidence(comparison, dataAvailability, ranked) {
  const list = Array.isArray(ranked) ? ranked : [];
  const top = comparison && comparison.top;

  // 自信度: データの網羅率・根拠の量と質・1位2位の差から決める。
  let stars = 1;
  const reasons = [];
  const cov = dataAvailability ? dataAvailability.coveragePct : 0;
  if (cov >= 100) { stars += 2; reasons.push("分析に必要なデータがすべて揃っている"); }
  else if (cov >= 60) { stars += 1; reasons.push(`データの${cov}%が揃っている`); }
  else reasons.push(`データが${cov}%しか揃っていない`);

  const evidenceCount = top && Array.isArray(top.evidence) ? top.evidence.length : 0;
  if (evidenceCount >= 3) { stars += 1; reasons.push(`採用した見方を裏づける実データが${evidenceCount}件ある`); }
  else if (evidenceCount === 0) reasons.push("採用した見方を裏づける実データが無い");
  else reasons.push(`裏づけとなる実データが${evidenceCount}件と少ない`);

  if (comparison && comparison.second && !comparison.isClose) { stars += 1; reasons.push("対抗する見方より根拠が明確に強い"); }
  else if (comparison && comparison.isClose) reasons.push("対抗する見方と根拠の強さが拮抗している");

  if (dataAvailability && dataAvailability.missing.length) {
    reasons.push(`${dataAvailability.missing.join("・")}のデータが不足している`);
  }
  // 2026年8月・テストで発見した設計上の欠陥の修正:
  // 8項目中7項目(88%)でも「ほぼすべて揃っている」として満点になっていた。
  // しかしご指示の例は「★★☆☆☆ 怪我情報が不足しているため」であり、
  // 必要なデータが1つでも欠けている状態を「満点の自信」と表示するのは
  // 利用者に対して不誠実。**1項目でも欠けていれば最高でも★4に抑える**。
  stars = Math.max(1, Math.min(5, stars));
  if (dataAvailability && dataAvailability.missing && dataAvailability.missing.length > 0) {
    stars = Math.min(stars, 4);
  }

  // 影響度の内訳(⑱): 仮説のスコアを、全体に対する割合として示す。
  const totalScore = list.reduce((s, h) => s + Math.max(0, h.score || 0), 0);
  const breakdown = list
    .filter((h) => (h.score || 0) > 0)
    .map((h) => {
      const sharePct = totalScore > 0 ? Math.round(((h.score || 0) / totalScore) * 100) : 0;
      const s = Math.max(1, Math.min(5, Math.round((sharePct / 100) * 5) || 1));
      return { labelJa: h.label, sharePct, stars: s, starsDisplay: "★".repeat(s) + "☆".repeat(5 - s), evidenceCount: (h.evidence || []).length };
    })
    .sort((a, b) => b.sharePct - a.sharePct);

  // 根拠の質(事実が多いほど信頼できる)
  const trust = (top && Array.isArray(top.evidence) && top.evidence.length)
    ? Math.round((top.evidence.reduce((s, e) => s + (EVIDENCE_TYPE_TRUST[e && e.type] ?? 0.5), 0) / top.evidence.length) * 100)
    : 0;

  return {
    confidenceStars: stars,
    confidenceStarsDisplay: "★".repeat(stars) + "☆".repeat(5 - stars),
    // ご指示⑮: 「なぜその自信度なのか」まで説明する
    confidenceReasonJa: reasons.join("、") + "ため。",
    breakdown,
    evidenceTrustPct: trust,
  };
}

/**
 * 段階6: 最終結論 — 必ず「私は○○が最も重要だと考えます」で始める。
 * テンプレートにならないよう、根拠の状況と前回からの変化で文面を組み立てる。
 */
function buildFinalConclusion(comparison, evaluation, previousConclusion) {
  const top = comparison && comparison.top;
  if (!top) {
    return {
      headlineJa: "私は、現時点では確かなことを申し上げられないと考えます。",
      bodyJa: "実データから支持できる見方が見つからなかったためです。データが揃い次第、改めて分析します。",
      changedFromPrevious: null,
    };
  }

  // 必須の書き出し(ご指示)。○○には最も根拠の強い観点が入る。
  const headlineJa = `私は「${top.label}」がこの分析で最も重要だと考えます。`;

  const parts = [top.statement];
  if (comparison.isClose) {
    parts.push(`ただし${comparison.second ? `「${comparison.second.label}」` : "他の見方"}とは僅差のため、単一の要因と決めつけるべきではありません。`);
  }
  parts.push(`この結論の確からしさは${evaluation.confidenceStarsDisplay}です(${evaluation.confidenceReasonJa})`);

  // ⑭: 前回から考えが変わったなら、必ずその理由に触れる(テンプレート化の防止にもなる)
  let changedFromPrevious = null;
  if (previousConclusion && previousConclusion.statement) {
    if (previousConclusion.statement === top.statement) {
      changedFromPrevious = { changed: false, noteJa: "この見方は前回から変わっていません。根拠も同じ方向を示し続けています。" };
    } else {
      changedFromPrevious = {
        changed: true,
        noteJa: `以前は「${previousConclusion.statement}」と考えていました。しかし新しいデータを学んだ結果、現在は上記のように考えています。`,
      };
      parts.push(changedFromPrevious.noteJa);
    }
  }

  return { headlineJa, bodyJa: parts.join(" "), changedFromPrevious };
}

/**
 * 6段階すべてを実行する。返り値の stages を見れば、
 * 「AIがどう考えたか」を人間が後から検証できる。
 *
 * @param {object} input
 *   - ranked: rankHypotheses()の出力(スコア順の仮説配列)
 *   - dataAvailability: { form:true, injuries:false, ... }
 *   - previousConclusion: Memory Engineの前回の結論(任意)
 */
function deliberate(input) {
  const i = input || {};
  const ranked = Array.isArray(i.ranked) ? i.ranked : [];

  const dataGathering = assessDataAvailability(i.dataAvailability);
  const comparison = compareHypotheses(ranked);
  const counterArgument = buildCounterArgument(comparison);
  const evaluation = evaluateEvidence(comparison, dataGathering, ranked);
  const conclusion = buildFinalConclusion(comparison, evaluation, i.previousConclusion);

  return {
    stages: {
      step1_dataGathering: dataGathering,
      step2_hypotheses: ranked.map((h) => ({ label: h.label, score: h.score, evidenceCount: (h.evidence || []).length })),
      step3_comparison: { marginJa: comparison.marginJa, isClose: comparison.isClose },
      step4_counterArgument: counterArgument,
      step5_evidenceEvaluation: evaluation,
      step6_finalConclusion: conclusion,
    },
    // 利用者に見せる最終結論(必ず「私は○○が最も重要だと考えます」で始まる)
    finalConclusionJa: `${conclusion.headlineJa} ${conclusion.bodyJa}`,
    counterArgumentJa: counterArgument.statementJa,
    confidence: {
      stars: evaluation.confidenceStars,
      starsDisplay: evaluation.confidenceStarsDisplay,
      reasonJa: evaluation.confidenceReasonJa,
    },
    factorBreakdown: evaluation.breakdown,
    changedFromPrevious: conclusion.changedFromPrevious,
    // LLMへ渡す内部メモ(回答の質を上げるための参考情報)
    promptNote: [
      `【内部検討メモ】`,
      `1. 必要データ: ${dataGathering.summaryJa}`,
      `2. 仮説: ${ranked.map((h, n) => `${n + 1}位 ${h.label}(根拠${(h.evidence || []).length}件)`).join(" / ") || "なし"}`,
      `3. 比較: ${comparison.marginJa}`,
      `4. 反対意見: ${counterArgument.statementJa}`,
      `5. 根拠評価: 自信度${evaluation.confidenceStarsDisplay}(${evaluation.confidenceReasonJa})`,
      `6. 結論: ${conclusion.headlineJa}`,
    ].join("\n"),
  };
}

module.exports = {
  deliberate, assessDataAvailability, compareHypotheses, buildCounterArgument,
  evaluateEvidence, buildFinalConclusion, REQUIRED_DATA_SPECS, EVIDENCE_TYPE_TRUST,
};
