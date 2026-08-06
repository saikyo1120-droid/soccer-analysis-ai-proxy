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
    return { adopt: false, reasonJa: "比較結果が得られなかったため、モデルは変更しません。" };
  }
  if (comparison.sampleSize < minSample) {
    return { adopt: false, reasonJa: `検証に使えた試合が${comparison.sampleSize}件で、判断に必要な${minSample}件に達していないため、モデルは変更しません。` };
  }
  const by = (k) => comparison.rows.find((r) => r.key === k) || null;
  const ll = by("logLoss");
  const br = by("brier");
  if (!ll || !br || ll.delta === null || br.delta === null) {
    return { adopt: false, reasonJa: "主指標(LogLoss / Brier)を測定できなかったため、モデルは変更しません。" };
  }
  // 許容できる誤差(数値計算の揺らぎ)。これ以内の悪化は「変化なし」とみなす。
  const TOL = 0.0005;
  const worsened = ll.delta > TOL || br.delta > TOL;
  const improved = ll.delta < -TOL || br.delta < -TOL;
  if (worsened) {
    return {
      adopt: false,
      reasonJa: `主指標が悪化したため採用しません(LogLoss ${ll.old}→${ll.new} / Brier ${br.old}→${br.new})。原因を分析して再調整が必要です。`,
    };
  }
  if (!improved) {
    return {
      adopt: false,
      reasonJa: `主指標に有意な改善が見られなかったため、現状維持とします(LogLoss ${ll.old}→${ll.new} / Brier ${br.old}→${br.new})。`,
    };
  }
  const gains = comparison.rows.filter((r) => r.improved === true).map((r) => r.labelJa);
  return {
    adopt: true,
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

module.exports = {
  METRIC_SPEC, predictRow, evaluate, compare, shouldAdopt, formatComparisonJa, splitByTime,
};
