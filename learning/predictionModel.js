/**
 * server/learning/predictionModel.js
 * ------------------------------------------------
 * Prediction Engineの「v2」モデル。既存の server/learning/dailyJob.js の
 * predictOutcome/computeFormScore/backtestAccuracy(v1)は一切変更していない
 * (既存のテスト・既存の挙動を壊さないため)。このファイルはそれを置き換える
 * のではなく、特徴量を増やした上位互換のモデルを「追加」するもの。
 *
 * 設計上の安全策: 新しく追加した特徴量の重み(sensitivity系)は既定で全て0。
 * つまり「まだ何も学習していない」状態では、v2モデルはv1モデルと完全に
 * 同じ予測を返す(homeBase/awayBase/sensitivityの3つだけがフォームスコアに
 * 効き、他の特徴量は無視される)。実際にデータが溜まって重みが学習された
 * 場合にのみ、新しい特徴量が予測に影響し始める。
 *
 * 「重要度を学習する」の実装方法: 各特徴量の予測結果への的中率貢献を、
 * 実際に解決した自社予測の記録(learn:ownpred:recent)に対する負の対数尤度
 * (Poisson分布による勝敗確率のモデルに基づく)を損失関数とした、数値微分に
 * よる勾配降下法で最適化する。npm等の機械学習ライブラリは一切使わず、
 * 素のJavaScriptで実装している(zero-dependency方針を維持)。学習結果は
 * 必ずバックテスト(backtestAccuracyV2)で「今より的中率が上回る場合のみ」
 * 採用するゲートを通す(dailyJob.js側で既存のグリッドサーチと同じ安全策を適用)。
 */

const EXTENDED_DEFAULT_WEIGHTS = {
  homeBase: 1.35,
  awayBase: 1.15,
  sensitivity: 0.18, // フォーム差(v1から引き継ぎ)
  goalRateSensitivity: 0, // 得点力・失点率の差
  injurySensitivity: 0, // 負傷者数の差
  standingsSensitivity: 0, // 順位・勝点の差
  headToHeadSensitivity: 0, // 直接対戦成績の差
  fatigueSensitivity: 0, // 過密日程(疲労)の差
  version: 0,
  updatedAt: null,
};

const FEATURE_WEIGHT_MAP = {
  formDiff: "sensitivity",
  goalRateDiff: "goalRateSensitivity",
  injuryDiff: "injurySensitivity",
  standingsDiff: "standingsSensitivity",
  headToHeadDiff: "headToHeadSensitivity",
  fatigueDiff: "fatigueSensitivity",
};

const FEATURE_LABELS_JA = {
  formDiff: "直近フォーム",
  goalRateDiff: "得点力・失点率",
  injuryDiff: "怪我人",
  standingsDiff: "順位・勝点",
  headToHeadDiff: "過去対戦成績",
  fatigueDiff: "過密日程(疲労)",
};

/**
 * @param {object} homeCtx - { formScore, avgGoalsFor, avgGoalsAgainst, injuryCount, pointsPerGame, matchesLast7Days }
 * @param {object} awayCtx - 同上(アウェイ側)
 * @param {object} h2h - computeHeadToHeadFeatureの戻り値
 */
function computeMatchFeatures(homeCtx, awayCtx, h2h) {
  const hGoalNet = (homeCtx.avgGoalsFor ?? 0) - (homeCtx.avgGoalsAgainst ?? 0);
  const aGoalNet = (awayCtx.avgGoalsFor ?? 0) - (awayCtx.avgGoalsAgainst ?? 0);
  return {
    formDiff: (homeCtx.formScore ?? 0) - (awayCtx.formScore ?? 0),
    goalRateDiff: hGoalNet - aGoalNet,
    // 相手の負傷者が多いほど自チームに有利、なので符号は「相手 - 自分」。
    injuryDiff: (awayCtx.injuryCount ?? 0) - (homeCtx.injuryCount ?? 0),
    standingsDiff: (homeCtx.pointsPerGame ?? 0) - (awayCtx.pointsPerGame ?? 0),
    headToHeadDiff: h2h ? (h2h.homeSideWins ?? 0) - (h2h.awaySideWins ?? 0) : 0,
    fatigueDiff: (awayCtx.matchesLast7Days ?? 0) - (homeCtx.matchesLast7Days ?? 0),
  };
}

function predictOutcomeV2(features, weights) {
  const w = weights || EXTENDED_DEFAULT_WEIGHTS;
  const f = features || {};
  let score = 0;
  for (const [fKey, wKey] of Object.entries(FEATURE_WEIGHT_MAP)) {
    score += (f[fKey] || 0) * (w[wKey] || 0);
  }
  const homeLambda = Math.max(0.4, (w.homeBase ?? EXTENDED_DEFAULT_WEIGHTS.homeBase) + score);
  const awayLambda = Math.max(0.4, (w.awayBase ?? EXTENDED_DEFAULT_WEIGHTS.awayBase) - score);
  const lambdaDiff = homeLambda - awayLambda;
  let predictedWinner = "draw";
  if (lambdaDiff > 0.15) predictedWinner = "home";
  else if (lambdaDiff < -0.15) predictedWinner = "away";
  return { homeLambda, awayLambda, predictedWinner, score };
}

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// ポアソン分布に基づく、実際の点差確率分布からの勝敗確率(生の小数値)算出。
// (単純にlambdaの大小だけで「勝ち/引き分け/負け」を決めるのではなく、
// 実際に起こりうるスコアの組み合わせを網羅して確率化する、標準的な手法)。
// 丸め処理はしない(下のcomputeMatchProbabilitiesが表示用に丸める)。理由:
// 勾配降下法(fitWeightsGradientDescent)は微小な重みの変化(既定epsilon=0.001)
// による確率の微小な変化を検出する必要があり、小数点1桁への丸めを挟むと
// その変化が丸め誤差に埋もれて勾配が常に0になってしまう(実際に発生した
// バグ。テストで発見・修正済み)。
function computeMatchProbabilitiesRaw(homeLambda, awayLambda, maxGoals) {
  const cap = maxGoals || 8;
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      const p = poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda);
      if (h > a) pHome += p;
      else if (h < a) pAway += p;
      else pDraw += p;
    }
  }
  const total = pHome + pDraw + pAway || 1;
  return { homeWin: pHome / total, draw: pDraw / total, awayWin: pAway / total };
}

// 表示用(人間が読む%表記に丸めたもの)。
function computeMatchProbabilities(homeLambda, awayLambda, maxGoals) {
  const raw = computeMatchProbabilitiesRaw(homeLambda, awayLambda, maxGoals);
  return {
    homeWinPct: Math.round(raw.homeWin * 1000) / 10,
    drawPct: Math.round(raw.draw * 1000) / 10,
    awayWinPct: Math.round(raw.awayWin * 1000) / 10,
  };
}

// 最も確率の高いスコアライン(「2-1」のような最終予想スコア)をポアソン分布の
// 格子から総当たりで探す。架空の数字ではなく、実際に計算した確率分布の最頻値。
function mostLikelyScoreline(homeLambda, awayLambda, maxGoals) {
  const cap = maxGoals || 6;
  let best = { h: 0, a: 0, p: -1 };
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      const p = poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda);
      if (p > best.p) best = { h, a, p };
    }
  }
  return `${best.h}-${best.a}`;
}

// この試合において、どの特徴量がどれだけ予測に効いたか(★1〜5)。
// 重みが0(＝まだ学習されていない特徴量)は★0とし、「まだ学習していない
// ため考慮していません」と正直に区別する(でっち上げの重要度を出さない)。
function computeFactorImportance(features, weights) {
  const w = weights || EXTENDED_DEFAULT_WEIGHTS;
  const f = features || {};
  const items = [
    { key: "homeAdvantage", labelJa: "ホームアドバンテージ", contribution: Math.abs((w.homeBase ?? 0) - (w.awayBase ?? 0)) },
  ];
  for (const [fKey, wKey] of Object.entries(FEATURE_WEIGHT_MAP)) {
    items.push({
      key: fKey,
      labelJa: FEATURE_LABELS_JA[fKey],
      contribution: Math.abs((f[fKey] || 0) * (w[wKey] || 0)),
    });
  }
  const maxC = Math.max(...items.map((i) => i.contribution), 0);
  return items
    .map((i) => ({ ...i, stars: i.contribution > 0 && maxC > 0 ? Math.max(1, Math.round((i.contribution / maxC) * 5)) : 0 }))
    .sort((a, b) => b.contribution - a.contribution);
}

function backtestAccuracyV2(records, weights) {
  const usable = (records || []).filter((r) => r && r.actualWinner && r.features && typeof r.features === "object");
  if (!usable.length) return null;
  const correct = usable.filter((r) => predictOutcomeV2(r.features, weights).predictedWinner === r.actualWinner).length;
  return { accuracy: Math.round((correct / usable.length) * 1000) / 10, sampleSize: usable.length };
}

// 負の対数尤度(NLL)。実際に起きた結果に、モデルがどれだけ高い確率を
// 割り当てられていたかを損失として測る(低いほど良い)。
function computeNegativeLogLikelihood(records, weights) {
  const usable = (records || []).filter((r) => r && r.actualWinner && r.features);
  if (!usable.length) return null;
  let total = 0;
  for (const r of usable) {
    const { homeLambda, awayLambda } = predictOutcomeV2(r.features, weights);
    const probs = computeMatchProbabilitiesRaw(homeLambda, awayLambda);
    const pFrac = r.actualWinner === "home" ? probs.homeWin : r.actualWinner === "away" ? probs.awayWin : probs.draw;
    const pClamped = Math.max(0.005, pFrac); // log(0)回避のための下限クランプ
    total += -Math.log(pClamped);
  }
  return total / usable.length;
}

const LEARNABLE_KEYS = ["sensitivity", "goalRateSensitivity", "injurySensitivity", "standingsSensitivity", "headToHeadSensitivity", "fatigueSensitivity"];

// 数値微分(有限差分法)による勾配降下法。各パラメータをごくわずかに動かして
// 損失(NLL)がどう変化するかを直接測るシンプルな方法(データ件数が少ない
// うちはこれで十分堅牢に動く。TensorFlow等の外部ライブラリは使わない)。
function fitWeightsGradientDescent(records, initialWeights, opts) {
  const usable = (records || []).filter((r) => r && r.actualWinner && r.features);
  if (usable.length < 5) return null; // データが少なすぎる場合は学習を試みない(過学習防止)

  let weights = { ...EXTENDED_DEFAULT_WEIGHTS, ...(initialWeights || {}) };
  const lr = (opts && opts.learningRate) || 0.08;
  const iterations = (opts && opts.iterations) || 40;
  const epsilon = 1e-3;

  for (let iter = 0; iter < iterations; iter++) {
    const baseLoss = computeNegativeLogLikelihood(usable, weights);
    if (baseLoss === null) break;
    const grad = {};
    for (const k of LEARNABLE_KEYS) {
      const bumped = { ...weights, [k]: weights[k] + epsilon };
      const bumpedLoss = computeNegativeLogLikelihood(usable, bumped);
      grad[k] = bumpedLoss === null ? 0 : (bumpedLoss - baseLoss) / epsilon;
    }
    const next = { ...weights };
    for (const k of LEARNABLE_KEYS) {
      const updated = weights[k] - lr * grad[k];
      next[k] = Math.max(-1, Math.min(1, updated)); // 発散防止のクリップ
    }
    weights = next;
  }
  return weights;
}

module.exports = {
  EXTENDED_DEFAULT_WEIGHTS,
  FEATURE_WEIGHT_MAP,
  FEATURE_LABELS_JA,
  LEARNABLE_KEYS,
  computeMatchFeatures,
  predictOutcomeV2,
  poissonPmf,
  computeMatchProbabilitiesRaw,
  computeMatchProbabilities,
  mostLikelyScoreline,
  computeFactorImportance,
  backtestAccuracyV2,
  computeNegativeLogLikelihood,
  fitWeightsGradientDescent,
};
