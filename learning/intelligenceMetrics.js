/**
 * server/learning/intelligenceMetrics.js
 * ------------------------------------------------
 * 2026年8月・AI知能計測ラウンド(ご指示①〜⑨)。
 * 「AIの脳(Reasoning / Knowledge / Memory / RAG)」そのものを毎日計測し、
 * AI自身が「今日のAIは昨日より賢くなったか?」に数値で答え、
 * 弱点を見つけて明日の改善を決めるためのモジュール。
 *
 * ■ でっち上げ防止(このモジュールの大原則)
 *   ・すべての点数は「機械的に検算できる採点基準(ルーブリック)」で計算する。
 *     LLMに自己採点させることはしない(自分に甘い採点=でっち上げになるため)。
 *   ・「考察の質スコア」が測るのは議論の**形式的な質**(実データにどれだけ
 *     接地しているか・反対意見まで検討したか・自信は正直か)であって、
 *     「内容が正しいか」ではない。内容の正しさは予測の答え合わせ
 *     (accuracyTracker)だけが測れる。この区別をREADMEと画面の両方に明示する。
 *   ・測定できない日は「判定不能」と正直に返す。無理にYES/NOを出さない。
 *
 * ■ 応答速度への影響(最終方針⑥「質問した瞬間に重い処理を行う設計は禁止」)
 *   質問時に行うのはメモリ上の文字列照合(数ミリ秒)と配列への追加だけ。
 *   Redisへの保存は日次学習ジョブが1日1回まとめて行う(knowledgeStoreの
 *   使用回数管理と同じ設計)。そのため再起動でその日の未保存分は消えうる
 *   (近似値であることを正直に明記する)。
 */

const INTEL_KEY_PREFIX = "learn:intel:";
const INTEL_REPORT_KEY_PREFIX = "learn:intel:report:";
const BUFFER_MAX = 500; // メモリ有界: 1日にこれ以上の考察が来たら古い順に落とす(件数はdroppedで正直に数える)

// ---------------------------------------------------------------
// 1. RAG使用率(ご指示⑤): 「取得した知識のうち、実際に回答に使われた割合」
// ---------------------------------------------------------------

/** 照合用の正規化: 空白・句読点・記号を除き、表記ゆれの影響を減らす */
function normalizeForMatch(text) {
  return String(text || "").replace(/[\s、。・,\.()()【】\[\]「」『』::;;%%\-ー…!!??]/g, "");
}

function gramsOf(text, n) {
  const out = new Set();
  for (let i = 0; i + n <= text.length; i++) out.add(text.slice(i, i + n));
  return out;
}

/**
 * 回答本文と知識文(facts)を照合し、どの知識が実際に使われたかを判定する。
 * 判定基準(機械的・検算可能):
 *   ・知識文の6文字グラム(正規化後)のうち30%以上が回答に出現 → 使われた
 *   ・または、知識文に2つ以上ある数値(2文字以上)の60%以上が回答に出現 → 使われた
 * LLMは要約・言い換えをするため、これは厳密な因果ではなく「文字列照合による
 * 近似」である。その旨をnoteJaで常に開示する。
 */
function matchUsedKnowledge(answerText, statements) {
  const pool = Array.isArray(statements) ? statements.filter((s) => typeof s === "string" && s.length > 0) : [];
  const answerNorm = normalizeForMatch(answerText);
  const answerGrams = gramsOf(answerNorm, 6);
  const answerRaw = String(answerText || "");
  const used = [];
  const details = [];
  pool.forEach((stmt, idx) => {
    const s = normalizeForMatch(stmt);
    let isUsed = false;
    let gramHitRatio = null;
    if (s.length > 0 && s.length < 6) {
      isUsed = answerNorm.includes(s);
    } else if (s.length >= 6) {
      const grams = gramsOf(s, 6);
      let hit = 0;
      for (const g of grams) if (answerGrams.has(g)) hit++;
      gramHitRatio = grams.size ? hit / grams.size : 0;
      isUsed = gramHitRatio >= 0.3;
      if (!isUsed) {
        // 数値照合(「xG収支+0.8」→回答に「+0.8」が出ている等)
        const nums = (stmt.match(/\d+(?:\.\d+)?/g) || []).filter((t) => t.length >= 2);
        if (nums.length >= 2) {
          const numHits = nums.filter((t) => answerRaw.includes(t)).length;
          if (numHits / nums.length >= 0.6) isUsed = true;
        }
      }
    }
    if (isUsed) used.push(idx);
    details.push({ index: idx, used: isUsed, gramHitRatio: gramHitRatio === null ? null : Math.round(gramHitRatio * 1000) / 1000 });
  });
  const poolCount = pool.length;
  const usedCount = used.length;
  return {
    poolCount,
    usedCount,
    unusedCount: poolCount - usedCount,
    utilizationPct: poolCount ? Math.round((usedCount / poolCount) * 1000) / 10 : null,
    usedIndexes: used,
    details,
    noteJa: "文字列照合(6文字グラム30%以上または数値一致)による近似です。LLMが大きく言い換えた知識は「未使用」側に数えられることがあります。",
  };
}

// ---------------------------------------------------------------
// 2. 考察の質スコア(ご指示③・Reasoning Quality): 機械的ルーブリック 0〜100点
// ---------------------------------------------------------------

/** 「実データの事実」かどうかの機械判定(正直な断り書きやAI推定は数えない) */
function isRealDataFact(fact) {
  const f = String(fact || "");
  if (!f) return false;
  if (f.startsWith("【AIによる推定】") || f.includes("【AIの結論】")) return false;
  const HONESTY_MARKERS = ["取得できません", "見つかりませんでした", "基づかない", "省略しました", "取得できなかった"];
  return !HONESTY_MARKERS.some((m) => f.includes(m));
}

/**
 * 考察1件の「形式的な質」を採点する(0〜100点)。内訳:
 *   A データ量(20点):    実データの事実 8件で満点(min(件数,8)/8×20)
 *   B 構造完全性(20点):  6つの議論欄(一般論/AIの意見/反対意見/最終結論/
 *                          今後の見通し/最重要点)のうち10文字以上ある欄の割合
 *   C 反対意見の実質(15点): 反対意見が40文字以上=15点、10文字以上=7点。
 *                          AIの意見と同一文なら0点(自作自演の防止)
 *   D 根拠接地率(25点):  実データの事実のうち回答に実際に使われた割合×25
 *   E 自信の正直さ(20点): 自信の理由が書かれている(10点)+実データ3件未満
 *                          なのに星4以上という過信をしていない(10点)
 * すべて手計算で検算できる。LLMによる自己採点は含まれない。
 */
function scoreReasoningQuality(input) {
  const facts = Array.isArray(input && input.facts) ? input.facts : [];
  const fields = (input && input.answerFields) || {};
  const FIELD_KEYS = ["generalView", "aiOpinion", "counterArgument", "finalConclusion", "futureOutlook", "mostImportantOpinion"];
  const realFacts = facts.filter(isRealDataFact);

  // A データ量
  const dataFoundation = round1(Math.min(realFacts.length, 8) / 8 * 20);

  // B 構造完全性
  const filledFields = FIELD_KEYS.filter((k) => String(fields[k] || "").trim().length >= 10).length;
  const structure = round1(filledFields / FIELD_KEYS.length * 20);

  // C 反対意見の実質
  const counter = String(fields.counterArgument || "").trim();
  const opinion = String(fields.aiOpinion || "").trim();
  let counterQuality = 0;
  if (counter && counter !== opinion) {
    counterQuality = counter.length >= 40 ? 15 : counter.length >= 10 ? 7 : 0;
  }

  // D 根拠接地率(実データの事実だけを分母にする)
  const answerText = FIELD_KEYS.map((k) => String(fields[k] || "")).join("\n");
  const rag = matchUsedKnowledge(answerText, realFacts);
  const groundedness = rag.poolCount ? round1((rag.usedCount / rag.poolCount) * 25) : 0;

  // E 自信の正直さ
  const stars = Number(input && input.confidenceStars);
  const reasonOk = String((input && input.confidenceReasonJa) || "").trim().length >= 10;
  const overconfident = realFacts.length < 3 && Number.isFinite(stars) && stars >= 4;
  const confidenceHonesty = (reasonOk ? 10 : 0) + (overconfident ? 0 : 10);

  const total = round1(dataFoundation + structure + counterQuality + groundedness + confidenceHonesty);
  return {
    total,
    components: { dataFoundation, structure, counterQuality, groundedness, confidenceHonesty },
    realFactCount: realFacts.length,
    rag,
    noteJa: "このスコアは議論の形式的な質(実データへの接地・反対意見の検討・自信の正直さ)の機械採点です。内容の正しさは予測の答え合わせ(accuracy)でのみ測れます。",
  };
}

// ---------------------------------------------------------------
// 3. 質問時のメモリ記録 → 日次フラッシュ(最終方針⑥に適合)
// ---------------------------------------------------------------

let discussSampleBuffer = [];
let droppedSamples = 0; // BUFFER_MAX超過で捨てた件数(正直に数える)

/** 考察1件のサンプルをメモリに追加する(Redisへは書かない) */
function recordDiscussSample(sample) {
  if (!sample || typeof sample !== "object") return false;
  if (discussSampleBuffer.length >= BUFFER_MAX) {
    discussSampleBuffer.shift();
    droppedSamples++;
  }
  discussSampleBuffer.push(sample);
  return true;
}

function pendingSampleCount() { return discussSampleBuffer.length; }

function emptyIntelDaily() {
  return {
    samples: 0, droppedSamples: 0, clubSamples: 0, parsedOkCount: 0,
    scoreSum: 0,
    compSums: { dataFoundation: 0, structure: 0, counterQuality: 0, groundedness: 0, confidenceHonesty: 0 },
    ragPoolSum: 0, ragUsedSum: 0,
    memoryEligibleSamples: 0, memoryAttachedCount: 0,
    starsSum: 0, starsCount: 0,
  };
}

function mergeIntelDaily(a, b) {
  if (!a) return b; if (!b) return a;
  const out = emptyIntelDaily();
  for (const k of ["samples", "droppedSamples", "clubSamples", "parsedOkCount", "scoreSum", "ragPoolSum", "ragUsedSum", "memoryEligibleSamples", "memoryAttachedCount", "starsSum", "starsCount"]) {
    out[k] = round1((a[k] || 0) + (b[k] || 0));
  }
  for (const c of Object.keys(out.compSums)) {
    out.compSums[c] = round1(((a.compSums && a.compSums[c]) || 0) + ((b.compSums && b.compSums[c]) || 0));
  }
  return out;
}

/**
 * メモリ上のサンプルを日次集計へ変換し、learn:intel:<date> に加算保存する。
 * 日次学習ジョブから1日1回呼ばれる。保存後にバッファを空にする。
 */
async function flushIntelDaily(deps, dateKey) {
  const { upstashEnabled, upstashGetJSON, upstashSetJSON } = deps || {};
  const pending = discussSampleBuffer.length;
  if (!upstashEnabled || !dateKey) return { flushed: 0, reasonJa: "Upstash未設定または日付なし" };
  if (!pending && !droppedSamples) return { flushed: 0 };
  const agg = emptyIntelDaily();
  for (const s of discussSampleBuffer) {
    agg.samples++;
    if (s.subjectType === "club") agg.clubSamples++;
    if (s.parsedOk) agg.parsedOkCount++;
    if (Number.isFinite(s.score)) agg.scoreSum = round1(agg.scoreSum + s.score);
    if (s.components) {
      for (const c of Object.keys(agg.compSums)) {
        if (Number.isFinite(s.components[c])) agg.compSums[c] = round1(agg.compSums[c] + s.components[c]);
      }
    }
    if (Number.isFinite(s.ragPool)) agg.ragPoolSum += s.ragPool;
    if (Number.isFinite(s.ragUsed)) agg.ragUsedSum += s.ragUsed;
    if (s.memoryEligible) {
      agg.memoryEligibleSamples++;
      if (s.memoryAttached) agg.memoryAttachedCount++;
    }
    if (Number.isFinite(s.stars)) { agg.starsSum += s.stars; agg.starsCount++; }
  }
  agg.droppedSamples = droppedSamples;
  try {
    const existing = await upstashGetJSON(`${INTEL_KEY_PREFIX}${dateKey}`).catch(() => null);
    const merged = mergeIntelDaily(existing, agg);
    await upstashSetJSON(`${INTEL_KEY_PREFIX}${dateKey}`, merged);
    discussSampleBuffer = [];
    droppedSamples = 0;
    return { flushed: pending };
  } catch (e) {
    // 保存に失敗したらバッファは消さない(次回の実行で再度保存を試みる)
    return { flushed: 0, error: e.message };
  }
}

/** 日次集計を人間が読む形に変換する */
function summarizeIntelDaily(agg) {
  if (!agg || !agg.samples) {
    return { measurable: false, samples: 0, reasonJa: "この日は考察(議論する機能)が使われなかったため、考察の質は測定できません(利用が無かっただけで異常ではありません)。" };
  }
  return {
    measurable: true,
    samples: agg.samples,
    droppedSamples: agg.droppedSamples || 0,
    avgReasoningScore: round1(agg.scoreSum / agg.samples),
    avgComponents: Object.fromEntries(Object.entries(agg.compSums).map(([k, v]) => [k, round1(v / agg.samples)])),
    ragUtilizationPct: agg.ragPoolSum ? round1((agg.ragUsedSum / agg.ragPoolSum) * 100) : null,
    ragPoolTotal: agg.ragPoolSum, ragUsedTotal: agg.ragUsedSum,
    memoryAttachRatePct: agg.memoryEligibleSamples ? round1((agg.memoryAttachedCount / agg.memoryEligibleSamples) * 100) : null,
    memoryEligibleSamples: agg.memoryEligibleSamples,
    avgStars: agg.starsCount ? round1(agg.starsSum / agg.starsCount) : null,
    parsedOkRatePct: round1((agg.parsedOkCount / agg.samples) * 100),
    noteJa: "質問時はメモリ集計のみ(応答速度への影響ゼロ)・日次保存の近似値です。再起動するとその日の未保存分は数に入りません。",
  };
}

/** ご指示③: 考察の質の推移(今日・昨日・直近7日)を読み出す */
async function getIntelTrend(deps, todayDateKey) {
  const { upstashEnabled, upstashGetJSON } = deps || {};
  if (!upstashEnabled) return { available: false, reasonJa: "Upstash未設定のため読み出せません。" };
  const base = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  const daily = [];
  for (let i = 0; i < 8; i++) {
    const dk = new Date(base - i * 86400000).toISOString().slice(0, 10);
    const agg = await upstashGetJSON(`${INTEL_KEY_PREFIX}${dk}`).catch(() => null);
    if (agg) daily.push({ date: dk, agg });
  }
  const today = daily.find((d) => d.date === todayDateKey) || null;
  const yesterdayKey = new Date(base - 86400000).toISOString().slice(0, 10);
  const yesterday = daily.find((d) => d.date === yesterdayKey) || null;
  const last7 = daily.filter((d) => d.date !== todayDateKey).slice(0, 7).reduce((acc, d) => mergeIntelDaily(acc, d.agg), null);
  const t = today ? summarizeIntelDaily(today.agg) : null;
  const y = yesterday ? summarizeIntelDaily(yesterday.agg) : null;
  return {
    available: true,
    recordedDays: daily.length,
    today: t, yesterday: y,
    last7Days: last7 ? summarizeIntelDaily(last7) : null,
    vsYesterday: (t && t.measurable && y && y.measurable)
      ? {
        reasoningScoreDelta: round1(t.avgReasoningScore - y.avgReasoningScore),
        ragUtilizationDeltaPct: (t.ragUtilizationPct !== null && y.ragUtilizationPct !== null) ? round1(t.ragUtilizationPct - y.ragUtilizationPct) : null,
        noteJa: "プラスが改善です(考察の形式的な質の前日比)。",
      }
      : { noteJa: "今日か昨日のどちらかに考察の利用記録が無いため、前日比は測定できません。" },
  };
}

// ---------------------------------------------------------------
// 4. 仮説的中率(ご指示・5つの不足①)
// ---------------------------------------------------------------

function computeHypothesisStats(confirmed, discarded) {
  const c = Number(confirmed) || 0;
  const d = Number(discarded) || 0;
  const total = c + d;
  return {
    confirmed: c, discarded: d, total,
    hitRatePct: total ? round1((c / total) * 100) : null,
    measurable: total > 0,
    noteJa: total
      ? `日次検証で状態仮説${total}件を答え合わせし、${c}件が当たっていました(的中率${round1((c / total) * 100)}%)。`
      : "この日は答え合わせできた状態仮説がありませんでした。",
  };
}

// ---------------------------------------------------------------
// 5. エンジン別の成長率(ご指示⑧)
// ---------------------------------------------------------------

function growthRow(labelJa, metricJa, todayVal, yesterdayVal, unitJa) {
  const t = Number.isFinite(todayVal) ? todayVal : null;
  const y = Number.isFinite(yesterdayVal) ? yesterdayVal : null;
  const deltaV = (t !== null && y !== null) ? round1(t - y) : null;
  return {
    engine: labelJa, metricJa,
    today: t, yesterday: y,
    delta: deltaV,
    growthPct: (deltaV !== null && y > 0) ? round1((deltaV / y) * 100) : null,
    unitJa: unitJa || "",
    measurable: deltaV !== null,
  };
}

/**
 * ご指示⑧: Knowledge / Memory / Learning / Prediction / Reasoning 各エンジンの
 * 毎日の成長率を数値化する。すべて保存済みの実測値の差分で、推測はしない。
 */
function buildEngineGrowth(input) {
  const { todayMetrics, yesterdayMetrics, accuracyTrend, intelTrend } = input || {};
  const tm = todayMetrics || {};
  const ym = yesterdayMetrics || {};
  const accT = accuracyTrend && accuracyTrend.today && accuracyTrend.today.markets && accuracyTrend.today.markets.oneX2;
  const accY = accuracyTrend && accuracyTrend.yesterday && accuracyTrend.yesterday.markets && accuracyTrend.yesterday.markets.oneX2;
  const intT = intelTrend && intelTrend.today;
  const intY = intelTrend && intelTrend.yesterday;
  const rows = [
    growthRow("Knowledge Engine", "累計知識件数", tm.knowledgeTotal, ym.knowledgeTotal, "件"),
    growthRow("Memory Engine", "累計結論(記憶)件数", tm.memoryTotal, ym.memoryTotal, "件"),
    growthRow("Learning Engine", "答え合わせ済み予測の累計", tm.predictionsResolvedTotal, ym.predictionsResolvedTotal, "件"),
    growthRow("Prediction Engine", "1X2的中率",
      (accT && accT.measurable) ? accT.hitRatePct : null,
      (accY && accY.measurable) ? accY.hitRatePct : null, "%"),
    growthRow("Reasoning Engine", "考察の質スコア(形式的な質の機械採点)",
      (intT && intT.measurable) ? intT.avgReasoningScore : null,
      (intY && intY.measurable) ? intY.avgReasoningScore : null, "点"),
  ];
  return {
    rows,
    measurableCount: rows.filter((r) => r.measurable).length,
    noteJa: "「今日/昨日の両方に記録がある指標」だけ成長率を出します。片方しか無い指標は測定不能として空欄にします(推測で埋めません)。",
  };
}

// ---------------------------------------------------------------
// 6. Knowledgeの寄与ランキング(ご指示①)
// ---------------------------------------------------------------

// 特徴量 → その特徴量に材料を供給している知識の種類(設計上の対応。コードの
// 実配線に基づく固定の対応表であり、この対応自体は毎日変わらない)
const FEATURE_KNOWLEDGE_SOURCES = {
  formDiff: ["直近フォームの知識(recentFormTrend)", "クラブ調査ファイルのフォーム欄"],
  goalRateDiff: ["得点・失点の知識(recentFormTrend/goalRate)"],
  injuryDiff: ["怪我人の知識(injuries)"],
  standingsDiff: ["順位表の知識(standings)", "クラブ調査ファイルの順位欄"],
  headToHeadDiff: ["過去対戦の実データ(head-to-head API)"],
  fatigueDiff: ["直近日程の実データ(fixtures API)"],
  venueDiff: ["ホーム/アウェイ別成績(fixtures集計)", "クラブ調査ファイルのフォーム欄"],
  suspensionDiff: ["出場停止の実データ(injuries/suspension API)"],
  xgDiff: ["xGの実測(クラブ調査ファイルのxG欄)"],
  topScorerDiff: ["エースの得点の実データ(players API)"],
};

/**
 * ご指示①「Knowledgeごとの予測への寄与率を毎日ランキング化」への、
 * 捏造なしで実測できる形での回答:
 *   ・予測は知識の文章ではなく特徴量を消費する設計のため、「この知識1件で
 *     精度+4%」という因果は現設計では直接測定できない(でっち上げになる)。
 *   ・その代わり、(a)特徴量ごとの寄与(毎日のablation実測)を、その特徴量に
 *     材料を供給している知識の種類へ対応付けたランキングと、(b)個々の知識が
 *     実際に読まれた回数(使用実績)のランキングを毎日出す。
 * 方法論そのものを結果に添えて、何を測って何を測っていないかを明示する。
 */
function buildKnowledgeContributionRanking(input) {
  const { featureEffectiveness, topUsedKnowledge } = input || {};
  const fe = featureEffectiveness;
  let contributionRanking = [];
  let contributionMeasurable = false;
  let contributionReasonJa = null;
  if (fe && fe.measurable && Array.isArray(fe.features)) {
    contributionMeasurable = true;
    contributionRanking = fe.features
      .filter((f) => f.contribution !== null && f.contribution !== undefined)
      .sort((a, b) => b.contribution - a.contribution)
      .map((f, i) => ({
        rank: i + 1,
        featureLabelJa: f.labelJa,
        contribution: f.contribution,
        verdictJa: f.verdictJa,
        knowledgeSourcesJa: FEATURE_KNOWLEDGE_SOURCES[f.key] || ["(対応する知識の種類が未定義)"],
      }));
  } else {
    contributionReasonJa = (fe && fe.reasonJa) || "特徴量の有効性がまだ測定できていません(検証済みの予測が5件未満)。";
  }
  return {
    contributionMeasurable,
    contributionReasonJa,
    contributionRanking,
    usageRanking: (Array.isArray(topUsedKnowledge) ? topUsedKnowledge : []).map((k, i) => ({
      rank: i + 1, statement: k.statement, usageCount: k.usageCount, teamJa: k.teamJa || null, category: k.category || null,
    })),
    methodologyJa: "【この測定の方法論(でっち上げ防止のための明示)】予測は知識の文章ではなく特徴量(フォーム差・怪我人差など)を消費する設計のため、『この知識1件で精度が+◯%』という因果は現設計では直接測定できません。代わりに(a)特徴量ごとの寄与を毎日ablation(その特徴量を外すと損失がどれだけ悪化するか)で実測し、その特徴量に材料を供給している知識の種類へ対応付けたランキングと、(b)個々の知識が実際に考察の根拠候補として読まれた回数のランキング、の2つの実測を組み合わせて示します。",
  };
}

// ---------------------------------------------------------------
// 7. 精度低下の自己分析(ご指示⑦)
// ---------------------------------------------------------------

/**
 * 「最近精度が落ちている原因」をAI自身が保存済みの実測データから機械的に
 * 分析する。シグナルが無ければ「特定できない」と正直に言う。
 */
function buildAccuracyDiagnosis(input) {
  const { accuracyTrend, featureEffectiveness, agenda } = input || {};
  const t7 = accuracyTrend && accuracyTrend.last7Days && accuracyTrend.last7Days.markets && accuracyTrend.last7Days.markets.oneX2;
  const t30 = accuracyTrend && accuracyTrend.last30Days && accuracyTrend.last30Days.markets && accuracyTrend.last30Days.markets.oneX2;
  if (!t7 || !t7.measurable) {
    return {
      status: "insufficient_data",
      decliningDetected: null,
      summaryJa: "直近7日に答え合わせできた予測が無いため、精度低下の有無そのものを判定できません(オフシーズン等では正常です。推測で原因を作りません)。",
      causes: [],
    };
  }
  const declining = !!(t30 && t30.measurable && (
    t7.hitRatePct < t30.hitRatePct - 2 || t7.avgBrier > t30.avgBrier + 0.01
  ));
  const causes = [];
  if (declining) {
    // 原因候補1: 有害と実測された特徴量
    if (featureEffectiveness && featureEffectiveness.measurable) {
      for (const f of featureEffectiveness.features || []) {
        if (f.contribution !== null && f.contribution < -0.002) {
          causes.push({ kind: "harmful_feature", detailJa: `特徴量「${f.labelJa}」が予測を悪化させていると実測されています(寄与${f.contribution})。次回の重み学習で自動的に0化候補になります。` });
        }
      }
    }
    // 原因候補2: 較正のズレ(自信過剰/過小)
    const ece = t7.ece;
    if (ece && ece.measurable && ece.bins) {
      for (const b of ece.bins) {
        if (b.gapPt >= 15) {
          causes.push({ kind: "calibration_gap", detailJa: `自信${b.bin}の帯で、申告した自信(平均${b.avgConfPct}%)と実際の的中率(${b.actualHitPct}%)が${b.gapPt}ポイントずれています(${b.avgConfPct > b.actualHitPct ? "自信過剰" : "自信過小"})。` });
        }
      }
    }
    // 原因候補3: 学習計画が特定した弱点クラブ
    if (agenda && Array.isArray(agenda.priorities)) {
      for (const p of agenda.priorities.slice(0, 3)) {
        if (p && p.reasonJa) causes.push({ kind: "weak_area", detailJa: `学習計画が特定した弱点: ${p.reasonJa}` });
      }
    }
  }
  return {
    status: declining ? "declining" : "not_declining",
    decliningDetected: declining,
    summaryJa: declining
      ? (causes.length
        ? `直近7日の精度が直近30日平均より低下しています(的中率${t7.hitRatePct}% vs ${t30.hitRatePct}%)。実測データから特定できた原因候補は${causes.length}件です。`
        : `直近7日の精度が直近30日平均より低下しています(的中率${t7.hitRatePct}% vs ${t30.hitRatePct}%)が、保存済みの実測データからは原因を特定できませんでした(サンプル不足の可能性。推測で原因を作りません)。`)
      : `直近7日の精度に、直近30日平均からの低下は検出されていません(的中率${t7.hitRatePct}%${t30 && t30.measurable ? ` vs 30日平均${t30.hitRatePct}%` : ""})。`,
    causes,
  };
}

// ---------------------------------------------------------------
// 8. 毎日の自己評価(ご指示⑨)
//    「今日のAIは昨日より賢くなったか?」→ YES/NO/判定不能 + 数値の証明
// ---------------------------------------------------------------

function buildSelfAssessment(input) {
  const { accuracyTrend, metricsComparison, intelTrend, agenda, hypothesisStats, weightsUpdated } = input || {};
  const axes = []; // {axisJa, deltaJa, direction: 1(改善)/-1(悪化)/0(不変)}

  // 軸1・2: 精度(的中率・Brier)— 両日とも測定できた場合のみ
  const vy = accuracyTrend && accuracyTrend.vsYesterday;
  if (vy && Number.isFinite(vy.hitRateDeltaPct)) {
    axes.push({ axisJa: "1X2的中率(前日比)", valueJa: `${vy.hitRateDeltaPct > 0 ? "+" : ""}${vy.hitRateDeltaPct}ポイント`, direction: Math.sign(vy.hitRateDeltaPct) });
    if (Number.isFinite(vy.brierDelta)) {
      axes.push({ axisJa: "Brier Score(前日比・減少が改善)", valueJa: `${vy.brierDelta > 0 ? "+" : ""}${vy.brierDelta}`, direction: -Math.sign(vy.brierDelta) });
    }
  }

  // 軸3・4: 知識・記憶の累計(実カウンタの差分)
  const mc = metricsComparison;
  if (mc && mc.hasBaseline) {
    if (Number.isFinite(mc.knowledgeDelta)) axes.push({ axisJa: "累計知識件数", valueJa: `${mc.knowledgeDelta > 0 ? "+" : ""}${mc.knowledgeDelta}件`, direction: Math.sign(mc.knowledgeDelta) });
    if (Number.isFinite(mc.memoryDelta)) axes.push({ axisJa: "累計記憶(結論)件数", valueJa: `${mc.memoryDelta > 0 ? "+" : ""}${mc.memoryDelta}件`, direction: Math.sign(mc.memoryDelta) });
  }

  // 軸5: 重みの更新(実データに基づく学習が実行されたか)
  if (weightsUpdated) {
    axes.push({ axisJa: "予測モデルの重み", valueJa: "実データに基づいて更新されました(ホールドアウト検証を通過した改善のみ採用)", direction: 1 });
  }

  // 軸6: 考察の質スコア(前日比)
  const iv = intelTrend && intelTrend.vsYesterday;
  if (iv && Number.isFinite(iv.reasoningScoreDelta)) {
    axes.push({ axisJa: "考察の質スコア(形式的な質・前日比)", valueJa: `${iv.reasoningScoreDelta > 0 ? "+" : ""}${iv.reasoningScoreDelta}点`, direction: Math.sign(iv.reasoningScoreDelta) });
  }

  // 軸7: 仮説的中率(その日の実測。前日比ではなく当日値のため、証明の補助として添える)
  const proofsExtra = [];
  if (hypothesisStats && hypothesisStats.measurable) proofsExtra.push(hypothesisStats.noteJa);

  const improved = axes.filter((a) => a.direction > 0);
  const regressed = axes.filter((a) => a.direction < 0);

  let verdict, answerJa, tomorrowPlanJa = null;
  if (!axes.length) {
    verdict = "判定不能";
    answerJa = "本日は比較できる測定値がまだ揃っていないため、「昨日より賢くなったか」を数値では判定できません(推測でYES/NOは出しません)。明日以降、記録が2日分揃った指標から自動的に判定を始めます。";
  } else if (improved.length && !regressed.length) {
    verdict = "YES";
    answerJa = `YES — ${improved.map((a) => `${a.axisJa}: ${a.valueJa}`).join("、")}。悪化した測定値はありません。`;
  } else if (improved.length && regressed.length) {
    verdict = "NO";
    answerJa = `NO(部分的な改善はあるが悪化も測定されたため、正直にNOとします)— 改善: ${improved.map((a) => `${a.axisJa} ${a.valueJa}`).join("、")} / 悪化: ${regressed.map((a) => `${a.axisJa} ${a.valueJa}`).join("、")}。`;
  } else {
    verdict = "NO";
    answerJa = regressed.length
      ? `NO — 悪化: ${regressed.map((a) => `${a.axisJa} ${a.valueJa}`).join("、")}。改善が測定された指標はありません。`
      : "NO — 本日は測定できたどの指標にも変化がありませんでした(取得データが前日と同一だった場合に起こります)。";
  }

  if (verdict === "NO") {
    const planParts = [];
    for (const a of regressed) planParts.push(`「${a.axisJa}」の悪化(${a.valueJa})の原因を明日の学習で分析する`);
    if (agenda && Array.isArray(agenda.priorities) && agenda.priorities.length) {
      planParts.push(`学習計画の優先テーマ(${agenda.priorities.slice(0, 2).map((p) => p.labelJa || p.reasonJa || "").filter(Boolean).join("、")})のデータ収集を強化する`);
    }
    if (!planParts.length) planParts.push("明日の学習で新しい試合データ・知識の取得を継続し、測定可能な指標を増やす");
    tomorrowPlanJa = planParts.join("。") + "。";
  }

  return {
    questionJa: "今日のAIは昨日より賢くなったか?",
    verdict, // "YES" | "NO" | "判定不能"
    answerJa,
    proofs: axes.map((a) => ({ axisJa: a.axisJa, valueJa: a.valueJa, direction: a.direction > 0 ? "改善" : a.direction < 0 ? "悪化" : "不変" })),
    proofsExtraJa: proofsExtra,
    tomorrowPlanJa,
    noteJa: "この判定は保存済みの実測値の前日差分だけから機械的に決まります(LLMの自己申告ではありません)。改善が1つ以上あり悪化が0のときだけYESです。",
  };
}

function round1(v) { return Math.round(v * 10) / 10; }

module.exports = {
  INTEL_KEY_PREFIX, INTEL_REPORT_KEY_PREFIX, BUFFER_MAX,
  normalizeForMatch, matchUsedKnowledge, isRealDataFact,
  scoreReasoningQuality,
  recordDiscussSample, pendingSampleCount, flushIntelDaily,
  emptyIntelDaily, mergeIntelDaily, summarizeIntelDaily, getIntelTrend,
  computeHypothesisStats, buildEngineGrowth,
  buildKnowledgeContributionRanking, buildAccuracyDiagnosis, buildSelfAssessment,
};
