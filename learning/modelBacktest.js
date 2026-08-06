/**
 * server/learning/modelBacktest.js
 * ------------------------------------------------
 * 2026年8月・共同開発者レビューの要求に対応して新設。
 *
 * 要求(原文の趣旨):
 *   「実装後は必ず過去試合で旧モデルと新モデルを比較するバックテストを実施すること。
 *    Accuracyだけでなく LogLoss・Brier Score・引き分け予測精度・スコア予測・
 *    BTTS・Over/Under など複数の指標で評価し、どの指標がどれだけ改善したかを
 *    数値で証明すること。改善が確認できた場合のみ新モデルを採用し、
 *    改善しなかった場合は原因を分析して再調整すること。」
 *
 * ■ 設計の要点
 *   ・**時系列分割**で学習用と検証用を分ける(ランダム分割はリークになる。
 *     未来の試合で学習して過去を当てても意味がない)。
 *   ・判定は「Accuracyが上がったか」だけでは不十分。的中率は引き分けを
 *     全部切り捨てても上がることがある。**LogLossとBrierを主指標**にする。
 *   ・採用ゲートは既存の重み学習と同じ思想:
 *     **主指標が悪化したら採用しない。** 迷ったら現状維持。
 */

const {
  computeMatchFeatures, predictOutcomeV2, computeMatchProbabilitiesRaw,
  mostLikelyScoreline, topScorelinesFrom, marketProbabilities,
} = require("./predictionModel");

const OUTCOMES = ["home", "draw", "away"];

/** 1試合ぶんの予測を、評価に必要な形でまとめて返す */
function predictRow(row, weights) {
  const f = computeMatchFeatures(row.homeCtx, row.awayCtx, null);
  const { homeLambda, awayLambda } = predictOutcomeV2(f, weights);
  const rho = weights && weights.rho ? weights.rho : 0;
  const p = computeMatchProbabilitiesRaw(homeLambda, awayLambda, 8, rho);
  const probs = { home: p.homeWin, draw: p.draw, away: p.awayWin };
  return {
    probs,
    predicted: OUTCOMES.reduce((best, o) => (probs[o] > probs[best] ? o : best), "home"),
    scoreline: mostLikelyScoreline(homeLambda, awayLambda, 6, rho),
    top3: topScorelinesFrom(homeLambda, awayLambda, 6, rho, 3).map((x) => x.scoreline),
    market: marketProbabilities(homeLambda, awayLambda, 8, rho),
    homeLambda, awayLambda,
  };
}

/**
 * 複数指標での評価。
 * すべて「実際に起きたこと」との突き合わせで、推測値は一切含まない。
 */
function evaluate(rows, weights) {
  if (!rows || !rows.length) {
    return { measurable: false, reasonJa: "評価できる過去試合がありません。" };
  }
  let n = 0;
  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let top1 = 0, top3 = 0;
  let bttsCorrect = 0, overCorrect = 0;
  let totalGoalsAbsErr = 0;
  // 引き分けの再現率・適合率(Accuracyだけ見ると引き分けを捨てるモデルが有利になる)
  let drawActual = 0, drawPredicted = 0, drawHit = 0;
  const EPS = 1e-12;

  for (const r of rows) {
    if (!r || !r.actualWinner) continue;
    const pred = predictRow(r, weights);
    n++;
    if (pred.predicted === r.actualWinner) correct++;

    // LogLoss(実際に起きた結果に割り当てた確率の対数。低いほど良い)
    logLoss += -Math.log(Math.max(EPS, pred.probs[r.actualWinner]));

    // 多クラスBrier(3結果の二乗誤差の合計。低いほど良い)
    for (const o of OUTCOMES) {
      const actual = r.actualWinner === o ? 1 : 0;
      brier += Math.pow(pred.probs[o] - actual, 2);
    }

    // スコア予測
    const actualScore = `${r.actualHomeGoals}-${r.actualAwayGoals}`;
    if (pred.scoreline === actualScore) top1++;
    if (pred.top3.includes(actualScore)) top3++;

    // BTTS(両チーム得点)と Over/Under 2.5 — λが独立でないと表現できない指標
    const actualBtts = r.actualHomeGoals > 0 && r.actualAwayGoals > 0;
    if ((pred.market.btts >= 0.5) === actualBtts) bttsCorrect++;
    const actualOver = (r.actualHomeGoals + r.actualAwayGoals) > 2.5;
    if ((pred.market.over25 >= 0.5) === actualOver) overCorrect++;

    // 期待総得点の絶対誤差(旧モデルは常に2.50なので、ここが最も差が出る)
    totalGoalsAbsErr += Math.abs((pred.homeLambda + pred.awayLambda) - (r.actualHomeGoals + r.actualAwayGoals));

    if (r.actualWinner === "draw") drawActual++;
    if (pred.predicted === "draw") drawPredicted++;
    if (pred.predicted === "draw" && r.actualWinner === "draw") drawHit++;
  }

  if (!n) return { measurable: false, reasonJa: "評価できる過去試合がありません。" };

  const round = (x, d) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d);
  const drawRecall = drawActual ? drawHit / drawActual : null;
  const drawPrecision = drawPredicted ? drawHit / drawPredicted : null;
  return {
    measurable: true,
    sampleSize: n,
    accuracyPct: round((correct / n) * 100, 1),
    logLoss: round(logLoss / n, 4),
    brier: round(brier / n, 4),
    scorelineTop1Pct: round((top1 / n) * 100, 1),
    scorelineTop3Pct: round((top3 / n) * 100, 1),
    bttsAccuracyPct: round((bttsCorrect / n) * 100, 1),
    overUnderAccuracyPct: round((overCorrect / n) * 100, 1),
    totalGoalsMae: round(totalGoalsAbsErr / n, 3),
    drawRecallPct: drawRecall === null ? null : round(drawRecall * 100, 1),
    drawPrecisionPct: drawPrecision === null ? null : round(drawPrecision * 100, 1),
    drawPredictedCount: drawPredicted,
    drawActualCount: drawActual,
  };
}

/**
 * 旧モデル vs 新モデル の比較表を作る。
 * 「どの指標がどれだけ改善したか」を、向き(高い方が良い/低い方が良い)込みで返す。
 */
const METRIC_SPEC = [
  { key: "accuracyPct", labelJa: "的中率(1X2)", higherIsBetter: true, unit: "%" },
  { key: "logLoss", labelJa: "LogLoss", higherIsBetter: false, unit: "" },
  { key: "brier", labelJa: "Brier Score", higherIsBetter: false, unit: "" },
  { key: "drawRecallPct", labelJa: "引き分けの再現率", higherIsBetter: true, unit: "%" },
  { key: "drawPrecisionPct", labelJa: "引き分けの適合率", higherIsBetter: true, unit: "%" },
  { key: "scorelineTop1Pct", labelJa: "スコア的中(Top1)", higherIsBetter: true, unit: "%" },
  { key: "scorelineTop3Pct", labelJa: "スコア的中(Top3)", higherIsBetter: true, unit: "%" },
  { key: "bttsAccuracyPct", labelJa: "両チーム得点(BTTS)", higherIsBetter: true, unit: "%" },
  { key: "overUnderAccuracyPct", labelJa: "Over/Under 2.5", higherIsBetter: true, unit: "%" },
  { key: "totalGoalsMae", labelJa: "総得点の平均絶対誤差", higherIsBetter: false, unit: "点" },
];

function compare(oldEval, newEval) {
  if (!oldEval || !newEval || !oldEval.measurable || !newEval.measurable) {
    return { measurable: false, reasonJa: "比較できる評価結果がありません。" };
  }
  const rows = METRIC_SPEC.map((m) => {
    const o = oldEval[m.key];
    const nv = newEval[m.key];
    if (o === null || nv === null || o === undefined || nv === undefined) {
      return { ...m, old: o ?? null, new: nv ?? null, delta: null, improved: null,
        noteJa: "この指標は測定できませんでした。" };
    }
    const delta = Math.round((nv - o) * 10000) / 10000;
    const improved = m.higherIsBetter ? delta > 0 : delta < 0;
    return { ...m, old: o, new: nv, delta, improved };
  });
  return { measurable: true, sampleSize: newEval.sampleSize, rows };
}

/**
 * 採用ゲート。
 * 主指標(LogLoss と Brier)が**どちらも悪化していないこと**を必須とし、
 * かつどちらかが実際に改善していることを求める。
 * 的中率だけの改善では採用しない(引き分けを切り捨てると的中率だけ上がるため)。
 */
function shouldAdopt(comparison, opts) {
  const o = opts || {};
  const minSample = o.minSample || 200;
  if (!comparison || !comparison.measurable) {
    return { adopt: false, primaryWorsened: null, reasonJa: "比較結果が得られなかったため、モデルは変更しません。" };
  }
  if (comparison.sampleSize < minSample) {
    return { adopt: false, primaryWorsened: null, reasonJa: `検証に使えた試合が${comparison.sampleSize}件で、判断に必要な${minSample}件に達していないため、モデルは変更しません。` };
  }
  const by = (k) => comparison.rows.find((r) => r.key === k) || null;
  const ll = by("logLoss");
  const br = by("brier");
  if (!ll || !br || ll.delta === null || br.delta === null) {
    return { adopt: false, primaryWorsened: null, reasonJa: "主指標(LogLoss / Brier)を測定できなかったため、モデルは変更しません。" };
  }
  // 許容できる誤差(数値計算の揺らぎ)。これ以内の悪化は「変化なし」とみなす。
  const TOL = 0.0005;
  const worsened = ll.delta > TOL || br.delta > TOL;
  const improved = ll.delta < -TOL || br.delta < -TOL;
  if (worsened) {
    return {
      adopt: false, primaryWorsened: true,
      reasonJa: `主指標が悪化したため採用しません(LogLoss ${ll.old}→${ll.new} / Brier ${br.old}→${br.new})。原因を分析して再調整が必要です。`,
    };
  }
  if (!improved) {
    return {
      adopt: false, primaryWorsened: false,
      reasonJa: `主指標に有意な改善が見られなかったため、現状維持とします(LogLoss ${ll.old}→${ll.new} / Brier ${br.old}→${br.new})。`,
    };
  }
  const gains = comparison.rows.filter((r) => r.improved === true).map((r) => r.labelJa);
  return {
    adopt: true, primaryWorsened: false,
    reasonJa: `主指標が改善したため採用します(LogLoss ${ll.old}→${ll.new} / Brier ${br.old}→${br.new})。改善した指標: ${gains.join("、")}。検証${comparison.sampleSize}試合。`,
  };
}

/** 人が読める比較表(日次レポート・READMEにそのまま載せられる形) */
function formatComparisonJa(comparison) {
  if (!comparison || !comparison.measurable) return comparison && comparison.reasonJa ? comparison.reasonJa : "";
  const lines = ["| 指標 | 旧 | 新 | 変化 |", "|---|---|---|---|"];
  for (const r of comparison.rows) {
    if (r.delta === null) { lines.push(`| ${r.labelJa} | — | — | 測定不可 |`); continue; }
    const sign = r.delta > 0 ? "+" : "";
    const mark = r.improved ? "✅" : (r.delta === 0 ? "→" : "⚠️");
    lines.push(`| ${r.labelJa} | ${r.old}${r.unit} | ${r.new}${r.unit} | ${mark} ${sign}${r.delta}${r.unit} |`);
  }
  lines.push(`\n検証に使った過去試合: ${comparison.sampleSize}件`);
  return lines.join("\n");
}

// ============================================================
// 2026年8月・共同開発者からの追加要求への対応
//   「リーグごとに比較し、改善が統計的に一貫しているか確認すること。
//    リーグによって悪化する場合は原因を分析すること。」
// ============================================================

/**
 * 1試合ごとの損失を返す。集計値の比較より、こちらの方が検定に使える。
 * 同じ試合を両モデルが見るため **対応のある比較(paired)** ができ、
 * 試合の難易度のばらつきに影響されずに差を検出できる。
 */
function perMatchLosses(rows, weights) {
  const EPS = 1e-12;
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.actualWinner) continue;
    const pred = predictRow(r, weights);
    let brier = 0;
    for (const o of OUTCOMES) {
      const actual = r.actualWinner === o ? 1 : 0;
      brier += Math.pow(pred.probs[o] - actual, 2);
    }
    out.push({
      leagueId: r.leagueId ?? null,
      logLoss: -Math.log(Math.max(EPS, pred.probs[r.actualWinner])),
      brier,
      correct: pred.predicted === r.actualWinner ? 1 : 0,
    });
  }
  return out;
}

/**
 * 対応のある差の検定(正規近似)。
 * d_i = 新モデルの損失 − 旧モデルの損失。損失なので **負が改善**。
 * 95%信頼区間の上限が0を下回れば「偶然ではなく改善している」と言える。
 */
function pairedDifference(oldLosses, newLosses, key) {
  const n = Math.min(oldLosses.length, newLosses.length);
  if (n < 30) {
    return { measurable: false, n, reasonJa: `対応のある比較には最低30試合必要です(現在${n}件)。` };
  }
  const diffs = [];
  for (let i = 0; i < n; i++) diffs.push(newLosses[i][key] - oldLosses[i][key]);
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = diffs.reduce((a, d) => a + Math.pow(d - mean, 2), 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const z = se > 0 ? mean / se : 0;
  const ci95 = [mean - 1.96 * se, mean + 1.96 * se];
  const round = (x) => Math.round(x * 100000) / 100000;
  return {
    measurable: true, n,
    meanDelta: round(mean),
    stdError: round(se),
    z: round(z),
    ci95: [round(ci95[0]), round(ci95[1])],
    // 損失なので「上限 < 0」= 有意に改善、「下限 > 0」= 有意に悪化
    significantlyBetter: ci95[1] < 0,
    significantlyWorse: ci95[0] > 0,
    verdictJa: ci95[1] < 0 ? "有意に改善" : ci95[0] > 0 ? "有意に悪化" : "有意差なし",
  };
}

/** リーグごとに評価を分けて返す。 */
function evaluateByLeague(rows, weights, leagueNames) {
  const byLeague = new Map();
  for (const r of rows || []) {
    const id = r.leagueId ?? 0;
    if (!byLeague.has(id)) byLeague.set(id, []);
    byLeague.get(id).push(r);
  }
  const out = [];
  for (const [leagueId, list] of byLeague) {
    const ev = evaluate(list, weights);
    out.push({
      leagueId,
      leagueJa: (leagueNames && leagueNames[leagueId]) || `リーグ${leagueId}`,
      ...ev,
    });
  }
  return out.sort((a, b) => (b.sampleSize || 0) - (a.sampleSize || 0));
}

/**
 * リーグ別の一貫性レポート。
 * 「全体では改善したが、特定のリーグだけ悪化している」を検出する。
 * 悪化しているリーグには、原因分析のための実測値(試合数・引き分け率・平均得点)を添える。
 */
function consistencyReport(testRows, oldWeights, newWeights, leagueNames) {
  const oldByLeague = evaluateByLeague(testRows, oldWeights, leagueNames);
  const newByLeague = evaluateByLeague(testRows, newWeights, leagueNames);
  const newMap = new Map(newByLeague.map((x) => [x.leagueId, x]));

  const leagues = [];
  for (const o of oldByLeague) {
    const nv = newMap.get(o.leagueId);
    if (!nv || !o.measurable || !nv.measurable) continue;
    const rowsOfLeague = testRows.filter((r) => (r.leagueId ?? 0) === o.leagueId);
    const oldL = perMatchLosses(rowsOfLeague, oldWeights);
    const newL = perMatchLosses(rowsOfLeague, newWeights);
    const pairedLogLoss = pairedDifference(oldL, newL, "logLoss");
    const pairedBrier = pairedDifference(oldL, newL, "brier");

    // 原因分析用の実測値(そのリーグがどういうリーグか)
    const totalGoals = rowsOfLeague.reduce((s, r) => s + r.actualHomeGoals + r.actualAwayGoals, 0);
    const draws = rowsOfLeague.filter((r) => r.actualWinner === "draw").length;
    const diagnostics = {
      sampleSize: rowsOfLeague.length,
      avgTotalGoals: rowsOfLeague.length ? Math.round((totalGoals / rowsOfLeague.length) * 100) / 100 : null,
      drawRatePct: rowsOfLeague.length ? Math.round((draws / rowsOfLeague.length) * 1000) / 10 : null,
    };

    leagues.push({
      leagueId: o.leagueId, leagueJa: o.leagueJa,
      old: o, new: nv,
      comparison: compare(o, nv),
      pairedLogLoss, pairedBrier,
      diagnostics,
      improved: pairedLogLoss.measurable ? pairedLogLoss.meanDelta < 0 : null,
      significantlyWorse: !!pairedLogLoss.significantlyWorse,
    });
  }

  const measurable = leagues.filter((l) => l.pairedLogLoss.measurable);
  const improvedCount = measurable.filter((l) => l.improved).length;
  const worseCount = measurable.filter((l) => l.improved === false).length;
  const sigWorse = measurable.filter((l) => l.significantlyWorse);

  // 全体(全リーグまとめて)の対応のある検定
  const overallOld = perMatchLosses(testRows, oldWeights);
  const overallNew = perMatchLosses(testRows, newWeights);
  const overallLogLoss = pairedDifference(overallOld, overallNew, "logLoss");
  const overallBrier = pairedDifference(overallOld, overallNew, "brier");

  return {
    measurable: measurable.length > 0,
    leagues,
    leaguesMeasured: measurable.length,
    improvedCount, worseCount,
    significantlyWorseLeagues: sigWorse.map((l) => ({
      leagueJa: l.leagueJa,
      meanDelta: l.pairedLogLoss.meanDelta,
      diagnostics: l.diagnostics,
      causeHintJa: buildCauseHint(l),
    })),
    overallLogLoss, overallBrier,
    consistent: measurable.length > 0 && sigWorse.length === 0 && improvedCount >= Math.ceil(measurable.length / 2),
    noteJa: measurable.length
      ? `測定できた${measurable.length}リーグ中、${improvedCount}リーグで改善、${worseCount}リーグで悪化。統計的に有意に悪化したリーグは${sigWorse.length}件。`
      : "リーグ別に比較できるだけの試合数がありませんでした。",
  };
}

/**
 * 悪化したリーグの原因の当たりをつける。
 * **断定はしない**(実測値から言えることだけを示し、判断は人間に委ねる)。
 */
function buildCauseHint(league) {
  const d = league.diagnostics;
  const hints = [];
  if (d.sampleSize < 200) {
    hints.push(`検証試合が${d.sampleSize}件と少なく、偶然のばらつきの影響が大きい可能性があります`);
  }
  if (d.avgTotalGoals !== null && d.avgTotalGoals > 3.0) {
    hints.push(`平均総得点が${d.avgTotalGoals}点と高く、和の重みが他リーグ向けに寄っている可能性があります`);
  }
  if (d.avgTotalGoals !== null && d.avgTotalGoals < 2.3) {
    hints.push(`平均総得点が${d.avgTotalGoals}点と低く、和の重みが他リーグ向けに寄っている可能性があります`);
  }
  if (d.drawRatePct !== null && d.drawRatePct > 28) {
    hints.push(`引き分け率が${d.drawRatePct}%と高く、Dixon-Colesのρがこのリーグに合っていない可能性があります`);
  }
  if (!hints.length) hints.push("実測値からは明確な原因を特定できませんでした。リーグ別に重みを分ける検討が必要かもしれません");
  return hints.join("。") + "。";
}

/**
 * 時系列分割。前半を学習用、後半を検証用にする。
 * ランダム分割は「未来で学習して過去を当てる」リークになるため使わない。
 */
function splitByTime(rows, trainRatio) {
  const sorted = (rows || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const ratio = trainRatio || 0.7;
  const cut = Math.floor(sorted.length * ratio);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

/**
 * ---- 統計的一貫性まで見る採用ゲート(共同開発者の追加要求) ----
 * 集計値の比較(shouldAdopt)に加えて、次の3条件をすべて満たす場合だけ採用する。
 *   ① 全体の対応のある検定で、LogLossが **有意に** 改善している
 *      (95%信頼区間の上限が0未満。偶然のばらつきでは説明できない)
 *   ② 統計的に有意に悪化したリーグが1つも無い
 *   ③ 測定できたリーグの過半数で改善している
 * どれか1つでも欠ければ採用せず、**なぜ採用しなかったか**を残す。
 */
/**
 * 副次市場(BTTS・Over/Under・スコア・総得点誤差)の改善幅をまとめる。
 * 1X2は「どちらが勝つか」だけで、このアプリが出している予測の一部でしかない。
 * 主指標(LogLoss/Brier)が悪化していないのに、これらが揃って良くなっている
 * 変更を「有意差なし」の一言で捨て続けると、モデルは永久に前へ進まない。
 */
const SECONDARY_GATES = [
  { key: "bttsAccuracyPct", labelJa: "両チーム得点(BTTS)", min: 3.0, higherIsBetter: true },
  { key: "overUnderAccuracyPct", labelJa: "Over/Under 2.5", min: 3.0, higherIsBetter: true },
  { key: "scorelineTop3Pct", labelJa: "スコア的中(Top3)", min: 1.5, higherIsBetter: true },
  { key: "totalGoalsMae", labelJa: "総得点の平均絶対誤差", min: 0.05, higherIsBetter: false },
];

function secondaryGains(comparison) {
  const out = { passed: [], failed: [], measurable: 0 };
  if (!comparison || !Array.isArray(comparison.rows)) return out;
  for (const g of SECONDARY_GATES) {
    const row = comparison.rows.find((r) => r.key === g.key);
    if (!row || row.delta === null || row.delta === undefined) { out.failed.push(g.labelJa); continue; }
    out.measurable++;
    const gain = g.higherIsBetter ? row.delta : -row.delta;
    if (gain >= g.min) out.passed.push(`${g.labelJa} ${row.old}→${row.new}`);
    else out.failed.push(g.labelJa);
  }
  return out;
}

function shouldAdoptWithConsistency(comparison, consistency, opts) {
  const o = opts || {};
  const basic = shouldAdopt(comparison, opts);
  const secondary = secondaryGains(comparison);

  // 副次市場での採用経路。1X2を悪化させないことを絶対条件にする。
  // 「1X2は有意差なし」で止まる経路は2か所ある(主指標が動かなかった場合と、
  // 主指標は動いたが対応のある検定で有意にならなかった場合)。実測ではほぼ
  // 後者で毎日止まっていたので、両方から呼べるようにする。
  const trySecondary = () => {
    const primaryNotWorse = basic.primaryWorsened === false;
    const pairedNotWorse = !(consistency && consistency.overallLogLoss
      && consistency.overallLogLoss.measurable && consistency.overallLogLoss.significantlyWorse);
    const noWorseLeague = !(consistency && (consistency.significantlyWorseLeagues || []).length > 0);
    const enoughSample = comparison && comparison.measurable
      && comparison.sampleSize >= (o.minSample || 200);
    if (!(primaryNotWorse && pairedNotWorse && noWorseLeague && enoughSample && secondary.passed.length >= 2)) return null;
    return {
      adopt: true, consistencyChecked: !!(consistency && consistency.measurable),
      route: "secondary",
      secondaryGains: secondary.passed,
      reasonJa: `1X2の主指標(LogLoss / Brier)は悪化しておらず、副次的な予測が明確に改善したため採用します: ${secondary.passed.join("、")}。`
        + `(1X2そのものは統計的に有意な差ではありませんでした。${consistency && consistency.measurable ? `有意に悪化したリーグは0件、${consistency.leaguesMeasured}リーグ中${consistency.improvedCount}リーグで改善。` : ""}検証${comparison.sampleSize}試合)`,
    };
  };

  if (!basic.adopt) {
    // ---- 2026年8月・検証で判明した「絶対に採用されない門」への対処 ----
    //   9日間の実測で、採用ゲートは毎日同じ理由(対応のある検定でLogLossの
    //   信頼区間が0をまたぐ)で棄却し続けていた。その結果、λの独立化も
    //   Dixon-Colesのρも「実装したが一度も使われない」状態が続いていた。
    //   棄却された候補は BTTS +9.9pt / Over-Under +22.7pt / 総得点誤差 -0.131 /
    //   5リーグ中5リーグ改善 という中身だった。
    //   1X2を悪化させないことを絶対条件にしたうえで、副次市場が明確に
    //   良くなっている場合の採用経路を追加する(緩めるのではなく、
    //   「何を良くしたか」で判断する軸を増やす)。
    const viaSecondary = trySecondary();
    if (viaSecondary) return viaSecondary;
    return {
      ...basic, consistencyChecked: false,
      secondaryGains: secondary.passed,
      secondaryNoteJa: secondary.passed.length
        ? `なお、副次的な指標では ${secondary.passed.join("、")} が改善していました(採用条件には届いていません)。`
        : null,
    };
  }

  if (!consistency || !consistency.measurable) {
    return {
      adopt: false, consistencyChecked: false,
      reasonJa: "集計値では改善しましたが、リーグ別に比較できるだけの試合数が無く、改善が一貫しているか確認できないため採用しません。",
    };
  }
  const ll = consistency.overallLogLoss;
  if (!ll.measurable) {
    return { adopt: false, consistencyChecked: false, reasonJa: "対応のある検定を行うだけの試合数がありません。" };
  }
  if (!ll.significantlyBetter) {
    // ---- 実測で毎日ここに落ちていた ----
    //   1X2は有意差なしでも、BTTS・Over/Under・スコア・総得点誤差が
    //   はっきり良くなっている候補を9日連続で捨てていた。
    //   1X2を悪化させないことを条件に、副次市場での採用経路を通す。
    const viaSecondary = trySecondary();
    if (viaSecondary) return viaSecondary;
    return {
      adopt: false, consistencyChecked: true,
      secondaryGains: secondary.passed,
      secondaryNoteJa: secondary.passed.length
        ? `なお、副次的な指標では ${secondary.passed.join("、")} が改善していました(採用条件には届いていません)。`
        : null,
      reasonJa: `集計値では改善しましたが、統計的には有意な差とは言えません(LogLossの平均差 ${ll.meanDelta}、95%信頼区間 [${ll.ci95[0]}, ${ll.ci95[1]}])。偶然のばらつきの範囲内のため採用しません。`,
    };
  }
  if (consistency.significantlyWorseLeagues.length > 0) {
    const names = consistency.significantlyWorseLeagues.map((l) => l.leagueJa).join("、");
    const causes = consistency.significantlyWorseLeagues.map((l) => `${l.leagueJa}: ${l.causeHintJa}`).join(" / ");
    return {
      adopt: false, consistencyChecked: true,
      reasonJa: `全体では改善していますが、${names}で統計的に有意に悪化しているため採用しません。原因の手がかり: ${causes}`,
      worseLeagues: consistency.significantlyWorseLeagues,
    };
  }
  const half = Math.ceil(consistency.leaguesMeasured / 2);
  if (consistency.improvedCount < half) {
    return {
      adopt: false, consistencyChecked: true,
      reasonJa: `改善したリーグが${consistency.improvedCount}/${consistency.leaguesMeasured}と過半数に届かないため、一貫した改善とは言えず採用しません。`,
    };
  }
  return {
    adopt: true, consistencyChecked: true,
    reasonJa: `${basic.reasonJa} さらに統計的にも有意(LogLossの平均差 ${ll.meanDelta}、95%信頼区間 [${ll.ci95[0]}, ${ll.ci95[1]}])で、${consistency.leaguesMeasured}リーグ中${consistency.improvedCount}リーグで改善、有意に悪化したリーグはありませんでした。`,
  };
}

/** リーグ別の比較表(日次レポートやREADMEにそのまま載せられる形) */
function formatLeagueTableJa(consistency) {
  if (!consistency || !consistency.measurable) {
    return (consistency && consistency.noteJa) || "リーグ別の比較はできませんでした。";
  }
  const lines = ["| リーグ | 試合数 | LogLoss(旧→新) | Brier(旧→新) | 1X2 | 引分再現 | BTTS | O/U | 総得点誤差 | 判定 |",
    "|---|---|---|---|---|---|---|---|---|---|"];
  for (const l of consistency.leagues) {
    const o = l.old, n = l.new;
    const v = l.pairedLogLoss.measurable ? l.pairedLogLoss.verdictJa : "判定不可";
    lines.push(`| ${l.leagueJa} | ${o.sampleSize} | ${o.logLoss}→${n.logLoss} | ${o.brier}→${n.brier} | ${o.accuracyPct}%→${n.accuracyPct}% | ${o.drawRecallPct}%→${n.drawRecallPct}% | ${o.bttsAccuracyPct}%→${n.bttsAccuracyPct}% | ${o.overUnderAccuracyPct}%→${n.overUnderAccuracyPct}% | ${o.totalGoalsMae}→${n.totalGoalsMae} | ${v} |`);
  }
  lines.push("");
  lines.push(consistency.noteJa);
  if (consistency.overallLogLoss.measurable) {
    const ll = consistency.overallLogLoss;
    lines.push(`全体の対応のある検定: LogLossの平均差 ${ll.meanDelta}(95%信頼区間 [${ll.ci95[0]}, ${ll.ci95[1]}])→ ${ll.verdictJa}`);
  }
  return lines.join("\n");
}

module.exports = {
  SECONDARY_GATES, secondaryGains,
  METRIC_SPEC, predictRow, evaluate, compare, shouldAdopt, formatComparisonJa, splitByTime,
  perMatchLosses, pairedDifference, evaluateByLeague, consistencyReport, buildCauseHint,
  shouldAdoptWithConsistency, formatLeagueTableJa,
};
