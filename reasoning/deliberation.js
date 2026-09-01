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

// ---- v78(2026年9月1日・利用者の承認 案2): 選手の質問用のデータ種別 ----
//   6段階の熟考はこれまでクラブ専用だった。選手の質問では「必要なデータ」の
//   種類そのものが違うため、クラブ用と混ぜず別の一覧を持つ
//   (クラブの質問の表示・充足率計算には1文字も影響させない=劣化禁止)。
const PLAYER_DATA_SPECS = [
  { key: "playerScoring", labelJa: "得点関与(ゴール・アシスト)の実績" },
  { key: "playerOpportunity", labelJa: "出場機会(出場試合数)" },
  { key: "playerRating", labelJa: "試合評価(平均レーティング)" },
  { key: "playerCreation", labelJa: "チャンスメイク指標(キーパス・パス成功率など)" },
  { key: "playerDefense", labelJa: "守備・対人指標(タックル・デュエルなど)" },
  { key: "playerClubContext", labelJa: "所属クラブの状況" },
];

// 根拠の種類ごとの信頼度。事実は最も信頼でき、意見は参考程度。
// aiEstimate は第5次監査で追加。AIが実データ無しに一般論から推定した内容なので、
// 信頼度は最も低く扱う(0にはしない。まったく無価値ではないが、実データとは
// 決して同列に置かない)。
const EVIDENCE_TYPE_TRUST = { fact: 1.0, analysis: 0.7, profile: 0.5, opinion: 0.3, reflection: 0.6, aiEstimate: 0.15 };

/**
 * 段階1: 必要データ取得 — 何が揃い、何が欠けているかを点検する。
 *
 * 第5次監査での設計変更:
 *   これまでは質問の内容にかかわらず、常に上記8種類すべてを「必要」として
 *   点検していた。ところが本システムはクラブ単体の質問でxGや過去対戦成績を
 *   そもそも取得しない設計のため、**どんなに完璧にデータが揃っても
 *   必ず「不足している」と判定され、自信度が永久に★4止まりになる**という
 *   矛盾を抱えていた(しかも実際に画面へ出ていた星は別計算で★5だったため、
 *   本文と星が食い違っていた)。
 *   質問に応じて「本当に必要なデータ」だけを点検対象にできるようにする。
 *   requiredKeys を渡さなかった場合の挙動は従来どおり(8種類すべて)。
 *
 * @param {object} availability - {form:true, goals:false, ...}
 * @param {string[]} [requiredKeys] - 今回の質問で本当に必要な項目のkey一覧
 */
function assessDataAvailability(availability, requiredKeys, dataSpecs) {
  const a = availability || {};
  // v78(案2): dataSpecs で対象領域(クラブ用/選手用)を切り替えられるようにする。
  // 未指定なら従来どおりクラブ用(既存の呼び出しは全て挙動不変)。
  const DOMAIN_SPECS = (Array.isArray(dataSpecs) && dataSpecs.length) ? dataSpecs : REQUIRED_DATA_SPECS;
  const specs = Array.isArray(requiredKeys) && requiredKeys.length
    ? DOMAIN_SPECS.filter((s) => requiredKeys.includes(s.key))
    : DOMAIN_SPECS;
  const specList = specs.length ? specs : DOMAIN_SPECS;
  const available = [];
  const missing = [];
  for (const spec of specList) {
    if (a[spec.key]) available.push(spec.labelJa);
    else missing.push(spec.labelJa);
  }
  // 今回は必要としなかったが、あれば分析の幅が広がる項目(正直に別枠で示す)
  const notRequired = DOMAIN_SPECS
    .filter((s) => !specList.includes(s) && !a[s.key])
    .map((s) => s.labelJa);
  const coveragePct = Math.round((available.length / specList.length) * 100);
  return {
    available, missing, notRequired, coveragePct,
    summaryJa: missing.length
      ? `${available.length}/${specList.length}種類のデータが揃っています(不足: ${missing.join("・")})。`
      : `この質問の分析に必要な${specList.length}種類のデータがすべて揃っています。`
        + (notRequired.length ? `(今回の質問には必須ではありませんが、${notRequired.join("・")}は取得していません。)` : ""),
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
  // 総点検で発見した欠陥の修正: 採用した見方自体に根拠が無い場合にまで
  // 「反対意見が無いこと自体が根拠の強さを示す」と述べており、
  // **データが1件も無い状態を強みであるかのように見せてしまっていた**。
  if (!c.top || !(c.top.score > 0)) {
    return { hasCounter: false, statementJa: "そもそも実データが不足しているため、賛成・反対のどちらの材料も十分にありません。" };
  }
  if (!c.second || !(c.second.score > 0)) {
    // 第5次監査の修正: 「反対意見が無いこと自体が根拠の強さを示します」と
    // 述べていたが、実際には**他の観点のデータをまだ取得できていないだけ**
    // であることがほとんどで、強さの証明にはならない。正直に言い直す。
    return {
      hasCounter: false,
      statementJa: "他の観点については、現時点で比較できるだけのデータが集まっていません。反対意見が見つからないことは、この見方が正しい証拠にはなりません。",
    };
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

  // 第5次監査の修正:
  //   これまで evidence の**総数**を数えて「実データが◯件ある」と述べていたが、
  //   その中にはAIが一般論から推定しただけの文章(aiEstimate)も含まれていた。
  //   「実データ」と呼ぶ以上、AIが作り出したものは数に入れない。
  const factualCount = (top && Number.isFinite(top.factualCount))
    ? top.factualCount
    : (top && Array.isArray(top.evidence)
      ? top.evidence.filter((e) => e && (e.type === "fact" || e.type === "analysis") && !e.isAiGenerated).length
      : 0);
  const totalEvidenceCount = top && Array.isArray(top.evidence) ? top.evidence.length : 0;
  const aiOnlyCount = totalEvidenceCount - factualCount;
  if (factualCount >= 3) { stars += 1; reasons.push(`採用した見方を裏づける実データが${factualCount}件ある`); }
  else if (factualCount === 0) {
    reasons.push(aiOnlyCount > 0
      ? "採用した見方を裏づけるのはAIによる推定のみで、実データが無い"
      : "採用した見方を裏づける実データが無い");
  } else reasons.push(`裏づけとなる実データが${factualCount}件と少ない`);

  // 第5次監査の修正:
  //   「対抗する見方より根拠が明確に強い」で星を1つ足していたが、
  //   これは**他のどの見方にもデータが1件も無い**場合にも成立してしまい、
  //   「データが無いこと」が自信の根拠になるという逆立ちした挙動になっていた。
  //   自分の側に実データがあり、かつ2位にも根拠がある場合にだけ加点する。
  const secondHasEvidence = !!(comparison && comparison.second && (comparison.second.score || 0) > 0);
  if (secondHasEvidence && !comparison.isClose && factualCount > 0) {
    stars += 1; reasons.push("対抗する見方より根拠が明確に強い");
  } else if (comparison && comparison.isClose) {
    reasons.push("対抗する見方と根拠の強さが拮抗している");
  } else if (!secondHasEvidence) {
    reasons.push("他の見方にはそもそも根拠となるデータが無く、比較ができていない");
  }

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
  // 2026年8月・総点検で発見した欠陥の修正:
  // 仮説オブジェクト自体は存在するがスコアが0(＝根拠が1件も無い)場合にも
  // 「私は○○が最も重要だと考えます」と断定してしまっていた。
  // これはこのモジュール自身が冒頭で宣言している「根拠が1件も無い観点を
  // 『最も重要』とは言わない」という原則に反するため、スコア0は保留扱いにする。
  //
  // 第5次監査での追加修正:
  //   score > 0 だけでは不十分だった。クラブプロフィール(Layer2)は
  //   **実データが1件も取れなかったときにLLMへ「一般的なサッカーの知識のみに
  //   基づいて推定してください」と指示して書かせた文章**を含むが、それが
  //   analysis(重み1.5)として採点されていたため score > 0 を満たしてしまい、
  //   実データ0%の状態でも「私は○○が最も重要だと考えます」と断言できていた。
  //   実データ(fact / 検証済みanalysis)が1件も無ければ断言しない。
  const hasEvidence = !!top && (top.score || 0) > 0;
  const factualCount = (top && Number.isFinite(top.factualCount))
    ? top.factualCount
    : (top && Array.isArray(top.evidence)
      ? top.evidence.filter((e) => e && (e.type === "fact" || e.type === "analysis") && !e.isAiGenerated).length
      : 0);
  if (!hasEvidence || factualCount === 0) {
    return {
      headlineJa: "私は、現時点では確かなことを申し上げられないと考えます。",
      bodyJa: hasEvidence
        ? "現在手元にあるのはAIによる一般論の推定だけで、この見方を裏づける実データがまだ取得できていないためです。実データが揃い次第、改めて分析します。"
        : "実データから支持できる見方が見つからなかったためです。データが揃い次第、改めて分析します。",
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

  // requiredKeys: 今回の質問で本当に必要なデータの種類(未指定なら従来どおり8種類すべて)
  // dataSpecs(v78・案2): 選手の質問では PLAYER_DATA_SPECS を渡す(未指定=クラブ用)
  const dataGathering = assessDataAvailability(i.dataAvailability, i.requiredKeys, i.dataSpecs);
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
  evaluateEvidence, buildFinalConclusion, REQUIRED_DATA_SPECS, PLAYER_DATA_SPECS, EVIDENCE_TYPE_TRUST,
};
