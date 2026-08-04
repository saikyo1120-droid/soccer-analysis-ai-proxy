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

// ---- 2026年8月・知識拡張フェーズ: 「利用者にも学習内容を見えるようにする」----
// learn:weights:history の1件(dailyJob.jsが保存する{adopted, method, oldWeights,
// newWeights, oldAccuracy, newAccuracy, sampleSize, note})を、ユーザーの要望に
// あった「✓ ホーム補正を少し弱めました / 理由: ...」という形式の日本語文へ
// 機械的に変換する。LLMは使わない(実際に変化した数値そのものから導くため、
// 「賢くなったように見せかける」でっち上げの余地がない。変化が無ければ
// 「更新なし」と正直に返す)。
const WEIGHT_LABELS_JA = {
  homeBase: "ホームチームの基礎的な強さ",
  awayBase: "アウェイチームの基礎的な強さ",
  sensitivity: "フォーム(直近の調子)の重要度",
  goalRateSensitivity: "得点力・失点率の重要度",
  injurySensitivity: "怪我人の影響の重要度",
  standingsSensitivity: "順位・勝点の重要度",
  headToHeadSensitivity: "過去対戦成績の重要度",
  fatigueSensitivity: "過密日程(疲労)の影響の重要度",
};
const WEIGHT_CHANGE_THRESHOLD = 0.005; // これ未満の変化は「実質変化なし」として無視する

function describeOneWeightChange(key, oldVal, newVal) {
  const label = WEIGHT_LABELS_JA[key];
  if (!label) return null;
  const before = typeof oldVal === "number" ? oldVal : 0;
  const after = typeof newVal === "number" ? newVal : 0;
  const diff = after - before;
  if (Math.abs(diff) < WEIGHT_CHANGE_THRESHOLD) return null;
  // homeBase/awayBaseは「大きさそのもの」、sensitivity系は「重要度(絶対値)」の
  // 増減として説明する(符号が逆向きに振れても、モデルへの影響力という意味では
  // 「強めた」ことになるため、絶対値の変化で判定する)。
  const beforeMag = key === "homeBase" || key === "awayBase" ? before : Math.abs(before);
  const afterMag = key === "homeBase" || key === "awayBase" ? after : Math.abs(after);
  const magDiff = afterMag - beforeMag;
  if (Math.abs(magDiff) < WEIGHT_CHANGE_THRESHOLD) return null;
  const direction = magDiff > 0 ? "強めました" : "弱めました";
  const magnitude = Math.abs(magDiff) >= 0.15 ? "大きく" : Math.abs(magDiff) >= 0.05 ? "" : "少し";
  return `✓ ${label}を${magnitude}${direction}`;
}

/**
 * @param {object} entry - learn:weights:historyの1件
 * @returns {{date, method, adopted, bullets: string[], reason: string|null, sampleSize}}
 */
function describeWeightsHistoryEntry(entry) {
  if (!entry) return null;
  const methodLabelJa = entry.method === "gradient_descent_v2" ? "拡張特徴量モデル(v2)" : "基本モデル(v1・フォーム差のみ)";
  if (!entry.adopted) {
    return {
      date: entry.date, method: entry.method, methodLabelJa, adopted: false,
      bullets: [],
      reason: entry.note || `${methodLabelJa}の重みを見直しましたが、直近${entry.sampleSize ?? "?"}件の検証結果では既存の重みを上回らなかったため、更新を見送りました。`,
      sampleSize: entry.sampleSize ?? null,
      oldAccuracy: entry.oldAccuracy ?? null, newAccuracy: entry.newAccuracy ?? null,
    };
  }
  const oldW = entry.oldWeights || {};
  const newW = entry.newWeights || {};
  const keys = Object.keys(WEIGHT_LABELS_JA);
  const bullets = keys.map((k) => describeOneWeightChange(k, oldW[k], newW[k])).filter(Boolean);
  const accUp = typeof entry.oldAccuracy === "number" && typeof entry.newAccuracy === "number";
  const reason = accUp
    ? `直近${entry.sampleSize ?? "?"}試合の検証結果で、的中率が${entry.oldAccuracy}%→${entry.newAccuracy}%に上がったため(${methodLabelJa})。`
    : `直近の検証結果でこちらの重みの方が的中率が高かったため(${methodLabelJa})。`;
  return {
    date: entry.date, method: entry.method, methodLabelJa, adopted: true,
    bullets: bullets.length ? bullets : ["✓ 重みの数値を微調整しました(表示閾値未満の小さな変化)"],
    reason,
    sampleSize: entry.sampleSize ?? null,
    oldAccuracy: entry.oldAccuracy ?? null, newAccuracy: entry.newAccuracy ?? null,
  };
}

// weights:historyの配列(古い→新しい順を想定。RPUSHで積んでいるためRedisの
// LRANGEはそのまま古い→新しい順になる)から、実際に採用された(adopted:true)
// 変更だけを新しい順に抽出して返す。「昨日の学習」ウィジェット用。
function buildLearningSummary(historyEntries, limit) {
  const list = (historyEntries || []).map(describeWeightsHistoryEntry).filter(Boolean);
  const adopted = list.filter((e) => e.adopted).reverse();
  return adopted.slice(0, limit || 5);
}

// ---- 2026年8月・Failure Learning(ご要望①): 「何故外れたのか」を分類する ----
// 従来のサイクル(試合終了→正解/不正解→重み更新)は、外れた事実を数として
// 数えるだけで「何が原因で外れたのか」を一切言語化していなかった(正直な
// ギャップ)。ここでは、その予測を行った時点で実際に計算されていた特徴量
// (features)と、その時点で使っていた重み(weightsSnapshot)だけを根拠に、
// 機械的に(LLMを使わず)原因を分類する。でっち上げを避けるため、判定は
// 次の2パターンのみに限定する:
//   ①「重視しすぎた」: その特徴量が予測した方向に強く効いていた(重みが
//     一定以上ある)のに、実際の結果はその方向ではなかった。
//   ②「軽視した」: 実際の結果の方向を示す特徴量の値はあったのに、その
//     特徴量の重みがほぼ0(＝まだ学習で重視されていなかった)ため、
//     予測に反映されていなかった。
// どちらにも当てはまらない場合(v1のみの古いレコード等、拡張特徴量が無い場合を
// 含む)は、正直に「セットプレー・スタメン発表・審判の判定など、現在の
// モデルが数値化していない要因の影響」という限界を明示する(存在しない
// 原因をでっち上げない)。
const FAILURE_REASON_LABELS_JA = {
  home_bonus_overweighted: "ホーム補正が強すぎた",
  formDiff_overweighted: "直近フォームを重視しすぎた",
  formDiff_underweighted: "直近フォームを軽視した",
  goalRateDiff_overweighted: "得点力・失点率を重視しすぎた",
  goalRateDiff_underweighted: "得点力・失点率を軽視した",
  injuryDiff_overweighted: "怪我人を重視しすぎた",
  injuryDiff_underweighted: "怪我人を軽視した",
  standingsDiff_overweighted: "順位・勝点を重視しすぎた",
  standingsDiff_underweighted: "順位・勝点を軽視した",
  headToHeadDiff_overweighted: "過去対戦を重視しすぎた",
  headToHeadDiff_underweighted: "過去対戦を軽視した",
  fatigueDiff_overweighted: "過密日程を重視しすぎた",
  fatigueDiff_underweighted: "過密日程を軽視した",
  unmodeled_factors: "セットプレー・スタメン発表・審判の判定など、現在のモデルが数値化していない要因の影響",
};

const OUTCOME_SIGN = { home: 1, away: -1, draw: 0 };

/**
 * @param {object} record - learn:ownpred:<fixtureId> の1件(resolved済み・resultが確定済み)
 * @param {object} weightsUsed - その予測を行った時点の重み(record.weightsSnapshot)
 * @returns {Array<{id, labelJa, detail}>} 的中していれば空配列
 */
function classifyFailureReasons(record, weightsUsed) {
  if (!record || record.correct || !record.actualWinner || !record.predictedWinner) return [];
  const weights = weightsUsed || record.weightsSnapshot || EXTENDED_DEFAULT_WEIGHTS;
  const predictedSign = OUTCOME_SIGN[record.predictedWinner] ?? 0;
  const actualSign = OUTCOME_SIGN[record.actualWinner] ?? 0;
  const outcomeLabelJa = (w) => (w === "home" ? "ホーム勝利" : w === "away" ? "アウェイ勝利" : "引き分け");
  const reasons = [];

  const homeBiasMag = (weights.homeBase ?? 0) - (weights.awayBase ?? 0);
  if (predictedSign > 0 && actualSign <= 0 && homeBiasMag >= 0.3) {
    reasons.push({
      id: "home_bonus_overweighted",
      labelJa: FAILURE_REASON_LABELS_JA.home_bonus_overweighted,
      detail: `ホームアドバンテージ(基礎値の差+${homeBiasMag.toFixed(2)})の影響でホームチーム優位と予想しましたが、実際は${outcomeLabelJa(record.actualWinner)}でした。`,
    });
  }

  const features = record.features;
  if (features && typeof features === "object") {
    for (const [fKey, wKey] of Object.entries(FEATURE_WEIGHT_MAP)) {
      const fVal = features[fKey] || 0;
      const wVal = weights[wKey] || 0;
      const contributionSign = Math.sign(fVal * wVal);
      const featureSign = Math.sign(fVal);
      const labelJa = FEATURE_LABELS_JA[fKey];

      if (contributionSign !== 0 && contributionSign === predictedSign && predictedSign !== actualSign && Math.abs(wVal) >= 0.05) {
        reasons.push({
          id: `${fKey}_overweighted`,
          labelJa: FAILURE_REASON_LABELS_JA[`${fKey}_overweighted`] || `${labelJa}を重視しすぎた`,
          detail: `${labelJa}の差(${fVal.toFixed(2)})を根拠に予想しましたが、実際の結果(${outcomeLabelJa(record.actualWinner)})はそれを裏付けませんでした。`,
        });
      }
      if (featureSign !== 0 && featureSign === actualSign && actualSign !== predictedSign && Math.abs(wVal) < 0.03) {
        reasons.push({
          id: `${fKey}_underweighted`,
          labelJa: FAILURE_REASON_LABELS_JA[`${fKey}_underweighted`] || `${labelJa}を軽視した`,
          detail: `${labelJa}の差(${fVal.toFixed(2)})は実際の結果(${outcomeLabelJa(record.actualWinner)})の方向を示していましたが、モデルはこの要素をまだ十分に学習していませんでした。`,
        });
      }
    }
  }

  if (!reasons.length) {
    reasons.push({
      id: "unmodeled_factors",
      labelJa: FAILURE_REASON_LABELS_JA.unmodeled_factors,
      detail: "セットプレーの流れ・審判の判定・スタメン発表直前の変更など、現在のモデルが数値化していない要因が結果に影響した可能性があります。",
    });
  }

  return reasons.slice(0, 3);
}

// ---- 2026年8月・完全自動Learning Cycle ⑧「成功した理由も分析」 ----
// これまでは「外した理由」しか言語化しておらず、当たった時は数を数えるだけだった。
// 人間のアナリストは当たった時も「なぜ当たったのか」を確認して自分の判断基準を
// 強化するため、同じことをAIにもさせる。
//
// でっち上げ防止: 失敗分析と完全に対称な条件だけで判定する。
//   「その特徴量が予測した方向に効いていて(重みが一定以上)、実際の結果も
//     その方向だった」場合のみ「正しく評価できた要因」とみなす。
// 該当が1つも無い場合は、無理に理由を作らず「単一の決定的な要因は特定できない
// (モデル全体の総合判断が当たった)」と正直に返す。
const SUCCESS_REASON_LABELS_JA = {
  home_bonus_worked: "ホームアドバンテージを正しく評価できた",
  formDiff_worked: "直近フォームの差を正しく評価できた",
  goalRateDiff_worked: "得点力・失点率の差を正しく評価できた",
  injuryDiff_worked: "怪我人の影響を正しく評価できた",
  standingsDiff_worked: "順位・勝点の差を正しく評価できた",
  headToHeadDiff_worked: "過去対戦の傾向を正しく評価できた",
  fatigueDiff_worked: "過密日程(疲労)の影響を正しく評価できた",
  overall_judgement: "モデル全体の総合判断が当たった(単一の決定的な要因は特定できません)",
};

/**
 * 的中した予測について「なぜ当たったのか」を分類する。
 * @param {object} record - resolved済みのlearn:ownpredレコード
 * @param {object} weightsUsed - 予測時点の重み
 * @returns {Array<{id, labelJa, detail}>} 外れていれば空配列
 */
function classifySuccessReasons(record, weightsUsed) {
  if (!record || record.correct !== true || !record.actualWinner || !record.predictedWinner) return [];
  const weights = weightsUsed || record.weightsSnapshot || EXTENDED_DEFAULT_WEIGHTS;
  const actualSign = OUTCOME_SIGN[record.actualWinner] ?? 0;
  const outcomeLabelJa = (w) => (w === "home" ? "ホーム勝利" : w === "away" ? "アウェイ勝利" : "引き分け");
  const reasons = [];

  const homeBiasMag = (weights.homeBase ?? 0) - (weights.awayBase ?? 0);
  if (actualSign > 0 && homeBiasMag >= 0.3) {
    reasons.push({
      id: "home_bonus_worked",
      labelJa: SUCCESS_REASON_LABELS_JA.home_bonus_worked,
      detail: `ホームアドバンテージ(基礎値の差+${homeBiasMag.toFixed(2)})を見込んでホーム優位と予想し、実際に${outcomeLabelJa(record.actualWinner)}になりました。`,
    });
  }

  const features = record.features;
  if (features && typeof features === "object") {
    for (const [fKey, wKey] of Object.entries(FEATURE_WEIGHT_MAP)) {
      const fVal = features[fKey] || 0;
      const wVal = weights[wKey] || 0;
      const contributionSign = Math.sign(fVal * wVal);
      const labelJa = FEATURE_LABELS_JA[fKey];
      // 失敗分析の「重視しすぎた」と対称: 予測方向に効いていて、結果もその方向だった
      if (contributionSign !== 0 && contributionSign === actualSign && Math.abs(wVal) >= 0.05) {
        reasons.push({
          id: `${fKey}_worked`,
          labelJa: SUCCESS_REASON_LABELS_JA[`${fKey}_worked`] || `${labelJa}を正しく評価できた`,
          detail: `${labelJa}の差(${fVal.toFixed(2)})を根拠に予想し、実際の結果(${outcomeLabelJa(record.actualWinner)})もその方向でした。`,
        });
      }
    }
  }

  if (!reasons.length) {
    reasons.push({
      id: "overall_judgement",
      labelJa: SUCCESS_REASON_LABELS_JA.overall_judgement,
      detail: "個々の要素では決め手を特定できませんでしたが、複数要素を総合した予測が結果と一致しました。",
    });
  }
  return reasons.slice(0, 3);
}

// 成功理由も失敗理由と同じ形式で頻度集計する(「最近うまくいっている判断基準」)。
function summarizeSuccessReasons(records, limit) {
  const counts = new Map();
  for (const r of records || []) {
    if (!r || r.correct !== true || !Array.isArray(r.successReasons)) continue;
    for (const reason of r.successReasons) {
      if (!reason || !reason.id) continue;
      const cur = counts.get(reason.id) || { id: reason.id, labelJa: reason.labelJa, count: 0 };
      cur.count++;
      counts.set(reason.id, cur);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit || 5);
}

// 直近の解決済み予測(learn:ownpred:recentなど)の failureReasons を横断集計し、
// 「最近よく外れる原因」を頻度順に返す(AIの成長レポート・議論モードの根拠に使う)。
function summarizeFailureReasons(records, limit) {
  const counts = new Map();
  for (const r of records || []) {
    if (!r || r.correct !== false || !Array.isArray(r.failureReasons)) continue;
    for (const reason of r.failureReasons) {
      if (!reason || !reason.id) continue;
      const prev = counts.get(reason.id) || { id: reason.id, labelJa: reason.labelJa, count: 0 };
      prev.count += 1;
      counts.set(reason.id, prev);
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, limit || 5);
}

module.exports = {
  EXTENDED_DEFAULT_WEIGHTS,
  FEATURE_WEIGHT_MAP,
  FEATURE_LABELS_JA,
  LEARNABLE_KEYS,
  WEIGHT_LABELS_JA,
  FAILURE_REASON_LABELS_JA,
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
  describeWeightsHistoryEntry,
  buildLearningSummary,
  classifyFailureReasons,
  summarizeFailureReasons,
  classifySuccessReasons,
  summarizeSuccessReasons,
  SUCCESS_REASON_LABELS_JA,
};
