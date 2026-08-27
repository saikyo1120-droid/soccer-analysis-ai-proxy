/**
 * server/learning/dailyMetrics.js
 * ------------------------------------------------
 * 2026年8月・完全自動Learning Cycle ⑧「毎日賢くなっていることを証明してください」。
 *
 * ご要望原文: 「実装だけではなく、毎日 Prediction Accuracy / Knowledge Count /
 * Memory Count / Failure Learning / Weight Update / Learning Time を記録して
 * ください。私は『AIは本当に昨日より賢くなったのか』を数値で確認したいです」。
 *
 * ■ このモジュールの役割
 *   growthLog は「その日に何をしたか」の記録ですが、日をまたいだ比較には
 *   向いていません(項目が多く、増えた/減ったが一目で分かりません)。
 *   そこで、毎日の実行の最後に「賢さの指標」だけを抜き出した軽量な
 *   スナップショットを別途保存し、前日との差分を機械的に計算します。
 *
 * ■ 「賢くなった」の定義(でっち上げないための厳密な基準)
 *   次の3つを別々に評価し、それぞれ実データの差分でのみ判定します。
 *     1. 知識が増えたか      … knowledgeTotal の増加
 *     2. 記憶が増えたか      … memoryTotal の増加
 *     3. 予測が良くなったか  … ownAccuracy の改善、または重みの更新
 *   「精度」は検証データが十分に無い間は判定不能なので、良くなったとも
 *   悪くなったとも言わず、正直に「判定できない」と返します
 *   (少ないデータでの精度変動を『成長』と偽らないため)。
 */

const METRICS_KEY_PREFIX = "learn:metrics:";
const METRICS_HISTORY_MAX_DAYS = 60;

/**
 * その日のgrowthLogから、日をまたいで比較できる数値だけを抜き出す。
 * 純粋関数(テストしやすさのため)。
 */
function buildDailySnapshot(growthLog, extras) {
  const log = growthLog || {};
  const totals = log.engineTotals || {};
  const e = extras || {};
  return {
    date: log.date || null,
    ranAt: log.ranAt || null,
    // --- Prediction Engine ---
    predictionAccuracy: log.ownAccuracyAfter ?? log.ownAccuracyBefore ?? null,
    // runDailyLearning は totalOwnPredictionsResolved、getGrowthLog は
    // totalOwnPredictionsResolvedSoFar という別名で同じ値を返すため、両方を見る
    // (このズレはシミュレーションテストで発見した実バグ。片方しか見ていないと
    //  日次実行の直後に保存される指標で累計検証数が常に0になっていた)。
    predictionsResolvedTotal: log.totalOwnPredictionsResolvedSoFar ?? log.totalOwnPredictionsResolved ?? 0,
    predictionsResolvedToday: log.matchesResolvedToday ?? 0,
    newPredictionsLogged: log.newPredictionsLogged ?? 0,
    weightsUpdated: !!(log.weightsUpdated || log.weightsUpdatedV2),
    // --- Knowledge / Memory ---
    knowledgeTotal: totals.knowledgeItemsTotal ?? 0,
    memoryTotal: totals.memoryConclusionsTotal ?? 0,
    predictionsTotal: totals.predictionsTotal ?? 0,
    knowledgeAddedToday: log.knowledgeItemsSavedToday ?? 0,
    knowledgeDuplicateToday: log.knowledgeItemsDuplicateToday ?? 0,
    // --- Failure / Success Learning ---
    failureReasonsToday: Array.isArray(log.failureReasonsToday) ? log.failureReasonsToday.length : 0,
    successReasonsToday: Array.isArray(log.successReasonsToday) ? log.successReasonsToday.length : 0,
    topFailureReasons: (log.topFailureReasonsRecent || []).slice(0, 3).map((r) => ({ labelJa: r.labelJa, count: r.count })),
    topSuccessReasons: (log.topSuccessReasonsRecent || []).slice(0, 3).map((r) => ({ labelJa: r.labelJa, count: r.count })),
    // --- 取得量(何をどれだけ学びに行ったか) ---
    clubsAnalyzed: log.teamsAnalyzed ?? 0,
    leaguesAnalyzed: log.leaguesAnalyzedToday ?? 0,
    playersAnalyzed: log.playersCheckedToday ?? 0,
    // --- Hypothesis / Reflection ---
    hypothesesChecked: (log.hypothesesConfirmed ?? 0) + (log.hypothesesDiscarded ?? 0),
    reflectionsSaved: log.reflectionsSaved ?? 0,
    // --- Learning Time(処理にかかった時間) ---
    learningDurationMs: e.learningDurationMs ?? null,
    apiRequestsUsed: (log.apiBudget && log.apiBudget.totalSpent) ?? null,
    errorCount: Array.isArray(log.errors) ? log.errors.length : 0,
    runsToday: log.runsToday ?? 1,
  };
}

async function saveDailyMetrics(deps, snapshot) {
  const { upstashEnabled, upstashSetJSON } = deps || {};
  if (!upstashEnabled || typeof upstashSetJSON !== "function" || !snapshot || !snapshot.date) return false;
  try {
    await upstashSetJSON(`${METRICS_KEY_PREFIX}${snapshot.date}`, snapshot);
    return true;
  } catch (e) {
    return false;
  }
}

const num = (v) => (Number.isFinite(v) ? v : null);
function delta(todayVal, yesterdayVal) {
  const a = num(todayVal);
  const b = num(yesterdayVal);
  if (a === null || b === null) return null;
  return Math.round((a - b) * 100) / 100;
}

/**
 * 前日と比べて「本当に賢くなったか」を、実データの差分だけで判定する。
 * 判定できない項目は無理に結論を出さず null / 「判定できない」を返す。
 */
function compareSnapshots(today, yesterday) {
  if (!today) return null;
  if (!yesterday) {
    return {
      hasBaseline: false,
      knowledgeDelta: null, memoryDelta: null, accuracyDelta: null,
      verdictJa: "比較できる前日の記録がまだありません(明日以降、前日との差分をここに表示します)。",
      improved: null,
    };
  }
  const knowledgeDelta = delta(today.knowledgeTotal, yesterday.knowledgeTotal);
  const memoryDelta = delta(today.memoryTotal, yesterday.memoryTotal);
  const accuracyDelta = delta(today.predictionAccuracy, yesterday.predictionAccuracy);

  // 第6次監査で発見した欠陥の修正:
  //   「外れた理由を3件分析しました」という**その日の活動量**だけで
  //   improved=true(緑の📈「昨日より賢くなりました」)になっていた。
  //   自分の失敗を分析するのは活動であって、測定された改善ではない。
  //   知識が1件も増えず、記憶も増えず、的中率が8ポイント下がった日でも
  //   「賢くなりました」と表示されてしまう状態だった。
  //   「賢くなった」と言ってよいのは、前日と比べて**実際に増えた/上がった**
  //   ものがある場合だけに限る。活動量は別枠(activities)で正直に併記する。
  const points = [];
  if (knowledgeDelta !== null && knowledgeDelta > 0) points.push(`知識が${knowledgeDelta}件増えました`);
  if (memoryDelta !== null && memoryDelta > 0) points.push(`記憶(振り返り)が${memoryDelta}件増えました`);
  if (accuracyDelta !== null && accuracyDelta > 0) points.push(`自社予測の的中率が${accuracyDelta}ポイント改善しました`);
  if (today.weightsUpdated) points.push("実データに基づいて予測モデルの重みを更新しました");

  // 活動量(それ自体は「賢くなった証拠」にはならないが、何をしたかは伝える)
  const activities = [];
  if ((today.successReasonsToday || 0) > 0) activities.push(`当たった理由を${today.successReasonsToday}件分析しました`);
  if ((today.failureReasonsToday || 0) > 0) activities.push(`外れた理由を${today.failureReasonsToday}件分析しました`);

  const declines = [];
  if (accuracyDelta !== null && accuracyDelta < 0) declines.push(`的中率が${Math.abs(accuracyDelta)}ポイント下がりました`);

  let verdictJa;
  let improved;
  // ---- v67: 「賢くなりました」の見出し条件を実力側へ寄せる(利用者の指摘) ----
  //   これまでは知識・記憶が増えれば的中率が下がった日でも見出しは
  //   「昨日より賢くなりました」だった(下落は「ただし…」で開示)。
  //   知識の件数は活動の結果であって実力の証明ではない。的中率が下がった日は
  //   見出しでは断定せず、「増えたもの」と「下がったもの」を同格で並べる。
  //   (勝手な閾値は置かない: 下がったか上がったかの符号だけで言い分ける)
  if (points.length && declines.length) {
    improved = null; // 混在: 断定しない
    verdictJa = `${points.join("、")}。一方で、${declines.join("、")}。知識は増えましたが、的中率が下がったため「賢くなった」とは言い切りません(検証データが少ないうちは的中率が上下します)。`;
    if (activities.length) verdictJa += ` また、${activities.join("、")}。`;
  } else if (points.length) {
    improved = true;
    verdictJa = `昨日より賢くなりました: ${points.join("、")}。`;
    if (activities.length) verdictJa += ` また、${activities.join("、")}。`;
  } else if (declines.length) {
    improved = false;
    verdictJa = `本日は${declines.join("、")}。知識・記憶の増加もありませんでした。`;
  } else {
    improved = null;
    verdictJa = "本日は、知識・記憶・的中率のいずれにも変化がありませんでした(取得したデータが前日と同じ内容だった場合に起こります。異常ではありません)。";
    if (activities.length) verdictJa += ` なお、${activities.join("、")}が、これ自体は「賢くなった」ことの証拠にはなりません。`;
  }

  return {
    hasBaseline: true, knowledgeDelta, memoryDelta, accuracyDelta, verdictJa, improved,
    // 「賢くなった」の判定には使わないが、その日に何をしたかは別枠で返す
    activitiesJa: activities,
    // 第6次監査の指摘への対応: 比較対象が「本当に前日か」を呼び出し側が
    // 判断できるようにする(飛び日をまたいだ比較を「昨日より」と呼ばないため)
    comparedFromDate: yesterday.date || null,
    comparedToDate: today.date || null,
  };
}

/**
 * 過去N日分の指標を読み出し、日ごとの差分つきで返す。
 * 記録が無い日は推測で埋めず、そのまま欠落として扱う。
 */
async function getMetricsTrend(deps, days, todayDateKey) {
  const { upstashEnabled, upstashGetJSON } = deps || {};
  const n = Math.max(2, Math.min(METRICS_HISTORY_MAX_DAYS, days || 14));
  if (!upstashEnabled || typeof upstashGetJSON !== "function") {
    return { available: false, reasonJa: "Upstashが設定されていないため、日々の指標を読み出せません。", days: [] };
  }
  const base = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  const rows = [];
  for (let i = 0; i < n; i++) {
    const dateKey = new Date(base - i * 86400000).toISOString().slice(0, 10);
    let snap = null;
    try { snap = await upstashGetJSON(`${METRICS_KEY_PREFIX}${dateKey}`); } catch (e) { snap = null; }
    rows.push(snap ? { ...snap, date: dateKey, recorded: true } : { date: dateKey, recorded: false });
  }
  // rows[0] が今日。前日との差分を付ける(前日の記録が無い日は null のまま)。
  const withDelta = rows.map((r, i) => {
    const prev = rows[i + 1] && rows[i + 1].recorded ? rows[i + 1] : null;
    if (!r.recorded) return r;
    return {
      ...r,
      knowledgeDelta: delta(r.knowledgeTotal, prev && prev.knowledgeTotal),
      memoryDelta: delta(r.memoryTotal, prev && prev.memoryTotal),
      accuracyDelta: delta(r.predictionAccuracy, prev && prev.predictionAccuracy),
    };
  });
  const recorded = withDelta.filter((r) => r.recorded);
  const latest = recorded[0] || null;
  const previous = recorded[1] || null;
  // 第6次監査で発見した欠陥の修正:
  //   recorded[0]/recorded[1] は「記録がある直近2日」であって、
  //   必ずしも連続した2日ではない。日次ジョブが1日休むと、2日分の増加を
  //   「昨日より知識が12件増えました」と表示してしまっていた。
  //   また、その日の記録がまだ書かれていない時間帯(=1日の大半)は、
  //   「前日比」と書かれた数字が1日ぶん古い状態だった。
  //   実際に何日離れているかを添えて、呼び出し側が正しく言い換えられるようにする。
  const daysApart = (latest && previous)
    ? Math.round((new Date(latest.date + "T00:00:00Z") - new Date(previous.date + "T00:00:00Z")) / 86400000)
    : null;
  return {
    available: true,
    days: withDelta,
    recordedDays: recorded.length,
    latest,
    comparison: (() => {
      const c = compareSnapshots(latest, previous);
      if (c && c.hasBaseline && Number.isFinite(daysApart) && daysApart !== 1) {
        // 連続していない2日を比べている場合は、「昨日より」と言わずに
        // 実際に比べた日付をそのまま示す(利用者に誤解させないため)。
        c.verdictJa = c.verdictJa.replace(/^昨日より賢くなりました/, `${previous.date}から${latest.date}までの間に賢くなりました`);
        c.verdictJa += ` (比較したのは${previous.date}と${latest.date}です。日次学習の記録が無い日が間にあるため、厳密な「前日比」ではありません。)`;
        c.adjacentDays = false;
      } else if (c && c.hasBaseline) {
        c.adjacentDays = true;
      }
      return c;
    })(),
    comparisonDaysApart: daysApart,
    // 期間全体での伸び(「先週より今週の方が賢いか」を1行で言い切るための指標)
    rangeGrowth: (recorded.length >= 2)
      ? {
        knowledge: delta(recorded[0].knowledgeTotal, recorded[recorded.length - 1].knowledgeTotal),
        memory: delta(recorded[0].memoryTotal, recorded[recorded.length - 1].memoryTotal),
        accuracy: delta(recorded[0].predictionAccuracy, recorded[recorded.length - 1].predictionAccuracy),
        fromDate: recorded[recorded.length - 1].date,
        toDate: recorded[0].date,
      }
      : null,
  };
}

module.exports = {
  buildDailySnapshot, saveDailyMetrics, getMetricsTrend, compareSnapshots,
  METRICS_KEY_PREFIX, METRICS_HISTORY_MAX_DAYS,
};
