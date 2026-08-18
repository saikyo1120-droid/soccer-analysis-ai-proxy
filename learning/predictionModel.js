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
  // ---- 2026年8月・優先順位②(Proプラン移行に伴う特徴量の拡張) ----
  // 既存の重みと同じく、既定値は全て0。つまり追加した瞬間は予測結果が
  // 一切変わらず(＝既存の挙動を壊さず)、実データで学習して初めて効き始める。
  venueSensitivity: 0, // ホームでのホーム成績 と アウェイでのアウェイ成績 の差
  suspensionSensitivity: 0, // 出場停止者数の差(怪我とは分けて評価する)
  xgSensitivity: 0, // xG(期待得点)- xGA(期待失点)の差
  topScorerSensitivity: 0, // 各チームの得点ランキング上位選手の得点数の差
  // ---- λの独立化(2026年8月) ----
  // これらは「試合の総得点」を動かす。初期値0=旧モデルと完全に同一。
  attackSumSensitivity: 0,    // 両チームの得点力の合計
  concededSumSensitivity: 0,  // 両チームの失点しやすさの合計
  fatigueSumSensitivity: 0,   // 両チームの過密日程の合計(疲れた試合は点が減るか)
  xgSumSensitivity: 0,        // 両チームのxG収支の合計
  // ---- Dixon-Coles の低スコア補正(2026年8月) ----
  // 0-0 / 1-0 / 0-1 / 1-1 は、独立ポアソンが仮定するより実際には
  // 起こりやすい/にくい(得点が互いに独立ではない)。ρで補正する。
  // **初期値0のときτ関数は恒等的に1**になり、素のポアソンと完全に一致する。
  rho: 0,
  version: 0,
  updatedAt: null,
};

// ---- 2026年8月・共同開発者レビューを受けた構造改修(λの独立化) ----
//   旧モデルは単一スカラー score を λH に足し λA から引くだけだったため、
//     λH + λA = homeBase + awayBase = 2.50(定数)
//   となり、**予想総得点があらゆる試合で2.50に固定**されていた。
//   実測でも「互角」でも「わずかにホーム有利」でも合計2.50。
//   その結果、
//     ・スコア予想の精度に構造的な上限
//     ・Over/Under、BTTS(両チーム得点)が原理的に表現不能
//     ・引き分け確率はロースコアほど上がるのに、それを表現できない
//   という問題があった。
//   そこで「差(どちらが強いか)」と「和(どれだけ点が入る試合か)」を
//   分離し、λH と λA が独立に動けるようにする。
//   **Sum系の重みはすべて初期値0**なので、追加した時点では旧モデルと
//   完全に同一の出力になる(最終方針①「劣化禁止」の実装)。
const FEATURE_SUM_WEIGHT_MAP = {
  attackSum: "attackSumSensitivity",
  concededSum: "concededSumSensitivity",
  fatigueSum: "fatigueSumSensitivity",
  xgSum: "xgSumSensitivity",
};

// 和の特徴量は「リーグ平均からのズレ」に直す。生の値のままだと
// homeBase/awayBase と役割が重なり、学習の収束が遅くなるため。
const SUM_CENTERS = {
  attackSum: 2.8,    // 1チームあたり平均約1.4得点 × 2
  concededSum: 2.8,  // 同上(失点側)
  fatigueSum: 2.0,   // 直近7日の試合数の合計の目安
  xgSum: 0,          // xgNetは元々0中心
};

const FEATURE_WEIGHT_MAP = {
  formDiff: "sensitivity",
  goalRateDiff: "goalRateSensitivity",
  injuryDiff: "injurySensitivity",
  standingsDiff: "standingsSensitivity",
  headToHeadDiff: "headToHeadSensitivity",
  fatigueDiff: "fatigueSensitivity",
  venueDiff: "venueSensitivity",
  suspensionDiff: "suspensionSensitivity",
  xgDiff: "xgSensitivity",
  topScorerDiff: "topScorerSensitivity",
};

const FEATURE_LABELS_JA = {
  formDiff: "直近フォーム",
  goalRateDiff: "得点力・失点率",
  injuryDiff: "怪我人",
  standingsDiff: "順位・勝点",
  headToHeadDiff: "過去対戦成績",
  fatigueDiff: "過密日程(疲労)",
  venueDiff: "ホーム/アウェイ別の成績",
  suspensionDiff: "出場停止",
  xgDiff: "xG(期待得点)の質",
  topScorerDiff: "エースの得点力",
};

/**
 * @param {object} homeCtx - { formScore, avgGoalsFor, avgGoalsAgainst, injuryCount, pointsPerGame, matchesLast7Days }
 * @param {object} awayCtx - 同上(アウェイ側)
 * @param {object} h2h - computeHeadToHeadFeatureの戻り値
 */
// 2026年8月・第5次監査で発見した最重要欠陥の修正。
//
// これまで goalRateDiff / injuryDiff / standingsDiff / fatigueDiff / formDiff /
// headToHeadDiff / suspensionDiff は、片側ずつ `?? 0` を使っていた。すると
// 「片方のチームだけAPI取得に失敗した」場合に、失敗した側が0として扱われ、
// **取れなかっただけなのに「相手が圧倒的に有利」という嘘の差**が
// 予測モデルへ入っていた。
//
// 例) ホームの/injuriesが成功して「4人負傷」、アウェイが予算切れで失敗
//     → injuryDiff = 0 - 4 = -4 → 「アウェイの方が4人ぶん有利」と誤解する。
//     実際には「アウェイの負傷者数は不明」でしかない。
//     順位(standingsDiff)ではこれがさらに悪質で、リーグIDを特定できなかった
//     チームは「1試合あたり0勝点」扱いになり、相手に最大級の下駄を履かせていた。
//     しかも画面には「順位データは考慮されていません」と表示していたため、
//     **利用者への説明そのものが事実と違っていた**。
//
// featureEngine.js の設計方針(値が取れなければnullのままにする。0にしない)を
// 予測モデル側でも必ず守る。**両側が揃っているときだけ差を計算し、片側でも
// 欠けていれば0**にする。ここでの0は「差が無い」ではなく「この特徴量は今回
// 使わない」という意味になる(重みを掛けても寄与0、星も0になるため)。
function diffOrZero(a, b) {
  return (a ?? null) !== null && (b ?? null) !== null ? a - b : 0;
}

/**
 * 各特徴量について「実データが両側そろっていたか」を返す。
 * ご指示⑥「途中で0/null/undefinedになっていないことをログ付きで確認」の証拠、
 * および利用者向けの「このデータは取れなかったので考慮していません」という
 * 正直な注記(dataNotes)を出すために使う。
 */
function computeFeatureAvailability(homeCtx, awayCtx, h2h) {
  const h = homeCtx || {};
  const a = awayCtx || {};
  const both = (x, y) => (x ?? null) !== null && (y ?? null) !== null;
  const hGoalOk = both(h.avgGoalsFor, h.avgGoalsAgainst);
  const aGoalOk = both(a.avgGoalsFor, a.avgGoalsAgainst);
  return {
    formDiff: both(h.formScore, a.formScore),
    goalRateDiff: hGoalOk && aGoalOk,
    injuryDiff: both(h.injuryCount, a.injuryCount),
    standingsDiff: both(h.pointsPerGame, a.pointsPerGame),
    headToHeadDiff: !!(h2h && both(h2h.homeSideWins, h2h.awaySideWins)),
    fatigueDiff: both(h.matchesLast7Days, a.matchesLast7Days),
    venueDiff: both(h.homeVenueWinRate, a.awayVenueWinRate),
    suspensionDiff: both(h.suspensionCount, a.suspensionCount),
    xgDiff: both(h.xgNet, a.xgNet),
    topScorerDiff: both(h.topScorerGoals, a.topScorerGoals),
  };
}

function computeMatchFeatures(homeCtx, awayCtx, h2h) {
  const h = homeCtx || {};
  const a = awayCtx || {};
  const bothOk = (x, y) => (x ?? null) !== null && (y ?? null) !== null;
  // 得点力は「得点平均 - 失点平均」。片方でも欠けていればそのチームの値は不明。
  const hGoalNet = bothOk(h.avgGoalsFor, h.avgGoalsAgainst) ? h.avgGoalsFor - h.avgGoalsAgainst : null;
  const aGoalNet = bothOk(a.avgGoalsFor, a.avgGoalsAgainst) ? a.avgGoalsFor - a.avgGoalsAgainst : null;
  return {
    formDiff: diffOrZero(h.formScore, a.formScore),
    goalRateDiff: diffOrZero(hGoalNet, aGoalNet),
    // 相手の負傷者が多いほど自チームに有利、なので符号は「相手 - 自分」。
    injuryDiff: diffOrZero(a.injuryCount, h.injuryCount),
    standingsDiff: diffOrZero(h.pointsPerGame, a.pointsPerGame),
    headToHeadDiff: h2h ? diffOrZero(h2h.homeSideWins, h2h.awaySideWins) : 0,
    fatigueDiff: diffOrZero(a.matchesLast7Days, h.matchesLast7Days),
    // ---- 2026年8月・優先順位②で追加した特徴量 ----
    // どれも「値が取れなければ0(＝予測に影響しない)」とする。存在しない
    // データを推測で埋めない(このプロジェクトの一貫した方針)。
    //
    // venueDiff: 「ホームチームがホームでどれだけ勝てているか」と
    //   「アウェイチームがアウェイでどれだけ勝てているか」の差。
    //   既存のformDiffは会場を区別しない全体の調子なので、別の情報になる。
    venueDiff: diffOrZero(h.homeVenueWinRate, a.awayVenueWinRate),
    // suspensionDiff: 出場停止は「確実に出られない」ため、出場が不確実な
    //   負傷者(injuryDiff)とは分けて学習させる。符号は相手 - 自分。
    //   第5次監査の修正: 以前は `?? 0` だったため、/injuries の取得に失敗した
    //   側が「出場停止0人」と断定され、勝敗予想そのものが反転していた。
    suspensionDiff: diffOrZero(a.suspensionCount, h.suspensionCount),
    // xgDiff: xG(期待得点) - xGA(期待失点) の差。実際の得点(goalRateDiff)は
    //   運に左右されるが、xGは「チャンスの質」を表すため、実力の指標として
    //   より安定するとされる。取得できないリーグでは0のままになる。
    xgDiff: diffOrZero(h.xgNet, a.xgNet),
    // topScorerDiff: 各チームのリーグ得点ランキング上位選手の得点数の差。
    //   「エースがいるか」を数値化する(架空のキーマン診断はしない)。
    topScorerDiff: diffOrZero(h.topScorerGoals, a.topScorerGoals),
    // ---- 和の特徴量(λの独立化。2026年8月) ----
    // 「どちらが強いか」ではなく「どれだけ点が入る試合か」を表す。
    // 片方でも欠けていれば0(=総得点を動かさない)。推測で埋めない。
    attackSum: sumOrZero(h.avgGoalsFor, a.avgGoalsFor, SUM_CENTERS.attackSum),
    concededSum: sumOrZero(h.avgGoalsAgainst, a.avgGoalsAgainst, SUM_CENTERS.concededSum),
    fatigueSum: sumOrZero(h.matchesLast7Days, a.matchesLast7Days, SUM_CENTERS.fatigueSum),
    xgSum: sumOrZero(h.xgNet, a.xgNet, SUM_CENTERS.xgSum),
  };
}

/** 両方の値が取れている場合だけ「合計 − 中心値」を返す。片方でも欠ければ0。 */
function sumOrZero(x, y, center) {
  if ((x ?? null) === null || (y ?? null) === null) return 0;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return (x + y) - (center || 0);
}

function predictOutcomeV2(features, weights) {
  const w = weights || EXTENDED_DEFAULT_WEIGHTS;
  const f = features || {};
  // 差: どちらが強いか(λHを上げ、λAを下げる)
  let score = 0;
  for (const [fKey, wKey] of Object.entries(FEATURE_WEIGHT_MAP)) {
    score += (f[fKey] || 0) * (w[wKey] || 0);
  }
  // 和: どれだけ点が入る試合か(λHとλAを**同じ向きに**動かす)。
  // これが無いと λH+λA が定数になり、総得点を一切表現できない。
  let openness = 0;
  for (const [fKey, wKey] of Object.entries(FEATURE_SUM_WEIGHT_MAP)) {
    openness += (f[fKey] || 0) * (w[wKey] || 0);
  }
  // 下限は0.15へ引き下げた。旧値0.4は「1試合で0.4点未満はあり得ない」という
  // 強い仮定で、守備的な組み合わせを表現できずクランプが頻発していた。
  const homeLambda = Math.max(0.15, (w.homeBase ?? EXTENDED_DEFAULT_WEIGHTS.homeBase) + score + openness);
  const awayLambda = Math.max(0.15, (w.awayBase ?? EXTENDED_DEFAULT_WEIGHTS.awayBase) - score + openness);
  const lambdaDiff = homeLambda - awayLambda;
  let predictedWinner = "draw";
  if (lambdaDiff > 0.15) predictedWinner = "home";
  else if (lambdaDiff < -0.15) predictedWinner = "away";
  return { homeLambda, awayLambda, predictedWinner, score };
}

// ---- Dixon-Coles(1997)の低スコア補正 ----
//   独立ポアソンは、実際のサッカーでは 0-0 / 1-0 / 0-1 / 1-1 の頻度を
//   系統的に外す(両チームの得点は完全には独立ではない)。
//   τ関数でその4マスだけを補正する。文献ではρ≈-0.13前後。
//   **ρ=0のときτは恒等的に1**になり、素のポアソンと完全に一致するため、
//   導入した時点では既存の挙動を1ミリも変えない(最終方針①「劣化禁止」)。
function dixonColesTau(x, y, lambda, mu, rho) {
  if (!rho) return 1; // ρ=0(既定)なら補正なし
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
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
/**
 * スコア(h,a)の同時確率の格子を返す。Dixon-Colesのτ補正を掛けたうえで
 * 全体を1に正規化する(τは総和を1からわずかにずらすため)。
 * rhoを渡さなければ従来どおりの独立ポアソン。
 */
function scoreGrid(homeLambda, awayLambda, maxGoals, rho) {
  const cap = maxGoals || 8;
  const grid = [];
  let total = 0;
  for (let h = 0; h <= cap; h++) {
    grid[h] = [];
    for (let a = 0; a <= cap; a++) {
      const p = poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda)
        * dixonColesTau(h, a, homeLambda, awayLambda, rho);
      const safe = p > 0 ? p : 0; // τが負を作りうる極端なρでも確率を壊さない
      grid[h][a] = safe;
      total += safe;
    }
  }
  if (total > 0) {
    for (let h = 0; h <= cap; h++) for (let a = 0; a <= cap; a++) grid[h][a] /= total;
  }
  return grid;
}

function computeMatchProbabilitiesRaw(homeLambda, awayLambda, maxGoals, rho) {
  const cap = maxGoals || 8;
  const grid = scoreGrid(homeLambda, awayLambda, cap, rho);
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      const p = grid[h][a];
      if (h > a) pHome += p;
      else if (h < a) pAway += p;
      else pDraw += p;
    }
  }
  const total = pHome + pDraw + pAway || 1;
  return { homeWin: pHome / total, draw: pDraw / total, awayWin: pAway / total };
}

// 表示用(人間が読む%表記に丸めたもの)。
function computeMatchProbabilities(homeLambda, awayLambda, maxGoals, rho) {
  const raw = computeMatchProbabilitiesRaw(homeLambda, awayLambda, maxGoals, rho);
  return {
    homeWinPct: Math.round(raw.homeWin * 1000) / 10,
    drawPct: Math.round(raw.draw * 1000) / 10,
    awayWinPct: Math.round(raw.awayWin * 1000) / 10,
  };
}

// 最も確率の高いスコアライン(「2-1」のような最終予想スコア)をポアソン分布の
// 格子から総当たりで探す。架空の数字ではなく、実際に計算した確率分布の最頻値。
function mostLikelyScoreline(homeLambda, awayLambda, maxGoals, rho, consistentWith) {
  // 2026年8月: Dixon-Colesのτ補正を反映する。ρ=0(既定)なら従来と同一の結果。
  //
  // ---- 2026年8月18日・本番の「AIの反省」画面で見つかった自己矛盾の修正 ----
  //   実例: 「AIの予想: Zalaegerszegi TE勝利(予想スコア 1-1)」
  //   全体の勝率(勝ち/分け/負けの合計確率)ではホーム勝利が最有力でも、
  //   単一スコアの最頻値は1-1(引き分け)になることが数学的に起こる
  //   (勝ちスコアは2-1,1-0,2-0…と分散するが、引き分けは1-1に集中するため)。
  //   正しい統計だが、1行の表示では「勝つと言いながらスコアは引き分け」という
  //   矛盾にしか読めない。
  //   → consistentWith("home"|"away"|"draw")を渡すと、**予想した勝敗と
  //     整合するスコアの中での最頻値** を返す。これも明確に定義された統計であり、
  //     数字のでっち上げではない(条件付きの最頻値)。
  //   渡さなければ従来どおり全体の最頻値(互換性維持)。
  const cap = maxGoals || 6;
  const grid = scoreGrid(homeLambda, awayLambda, cap, rho);
  const matches = (h, a) => {
    if (consistentWith === "home") return h > a;
    if (consistentWith === "away") return a > h;
    if (consistentWith === "draw") return h === a;
    return true;
  };
  let best = { h: 0, a: 0, p: -1 };
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      if (!matches(h, a)) continue;
      if (grid[h][a] > best.p) best = { h, a, p: grid[h][a] };
    }
  }
  return `${best.h}-${best.a}`;
}

/** スコア文字列("2-1")の勝敗が、予想した勝敗と整合しているか。 */
function scorelineOutcome(scoreline) {
  const m = String(scoreline || "").match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const h = Number(m[1]); const a = Number(m[2]);
  return h > a ? "home" : a > h ? "away" : "draw";
}

/** スコア予想の上位N件(Top1/Top3の精度計測に使う)。 */
function topScorelinesFrom(homeLambda, awayLambda, maxGoals, rho, n) {
  const cap = maxGoals || 6;
  const grid = scoreGrid(homeLambda, awayLambda, cap, rho);
  const all = [];
  for (let h = 0; h <= cap; h++) for (let a = 0; a <= cap; a++) all.push({ scoreline: `${h}-${a}`, p: grid[h][a] });
  all.sort((x, y) => y.p - x.p);
  return all.slice(0, n || 3);
}

/** 総得点2.5超(Over)と、両チーム得点(BTTS)の確率。λが独立でないと表現できない指標。 */
function marketProbabilities(homeLambda, awayLambda, maxGoals, rho) {
  const cap = maxGoals || 8;
  const grid = scoreGrid(homeLambda, awayLambda, cap, rho);
  let over25 = 0, btts = 0;
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      const p = grid[h][a];
      if (h + a > 2.5) over25 += p;
      if (h > 0 && a > 0) btts += p;
    }
  }
  return { over25, under25: 1 - over25, btts, noBtts: 1 - btts };
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
//
// 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示⑤)での拡張:
// opts.sampleWeightOf(record) を渡すと、記録ごとの重み(=その予測に使った
// データの信頼度)つきの加重平均になる。信頼度の高いデータで行った予測の
// 結果ほど強く学習し、古い・信頼度の低いデータでの予測は学習への影響を
// 弱める。opts無しの呼び出しは従来と完全に同じ動作(既存テストを壊さない)。
function computeNegativeLogLikelihood(records, weights, opts) {
  const usable = (records || []).filter((r) => r && r.actualWinner && r.features);
  if (!usable.length) return null;
  const weightOf = opts && typeof opts.sampleWeightOf === "function" ? opts.sampleWeightOf : null;
  let total = 0;
  let totalWeight = 0;
  for (const r of usable) {
    const { homeLambda, awayLambda } = predictOutcomeV2(r.features, weights);
    // ---- 2026年8月・検証で判明した「ρが絶対に学習されない」欠陥の修正 ----
    //   ρ(Dixon-Colesの低スコア補正)は学習対象のパラメータに入っていたのに、
    //   この尤度計算だけが ρ を渡していなかった。そのため
    //     NLL(ρ=0) === NLL(ρ=-0.13) === NLL(ρ=+0.5)
    //   が **ビット単位で同一** になり、数値微分の勾配が厳密に0。
    //   ρ は初期値のまま永久に動かなかった(9日間の実行で実測)。
    //   ρ は 0-0/1-0/0-1/1-1 の確率を動かし、引き分け確率に直接効くので、
    //   尤度に反映されないのは明確な誤りだった。
    const rho = weights && Number.isFinite(weights.rho) ? weights.rho : 0;
    const probs = computeMatchProbabilitiesRaw(homeLambda, awayLambda, undefined, rho);
    const pFrac = r.actualWinner === "home" ? probs.homeWin : r.actualWinner === "away" ? probs.awayWin : probs.draw;
    const pClamped = Math.max(0.005, pFrac); // log(0)回避のための下限クランプ
    const sw = weightOf ? weightOf(r) : 1;
    const swSafe = Number.isFinite(sw) && sw > 0 ? sw : 1; // 異常な重みで学習を壊さない
    total += -Math.log(pClamped) * swSafe;
    totalWeight += swSafe;
  }
  return totalWeight > 0 ? total / totalWeight : null;
}

// ---- 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示⑧) ----
// 「どの特徴量が当たりやすいか・どの特徴量が不要か」を自動分析する。
// 方法: 各特徴量について「その重みだけを0にしたモデル」のNLLを実測し、
//   contribution = NLL(その特徴量なし) - NLL(現在)
// を計算する。正の値=その特徴量を外すと損失が増える=役に立っている。
// 負の値=外した方が良い=有害(過学習など)。ゼロ重みの特徴量は「未学習」。
// すべて実データ(検証済み予測)に対する実測で、推測は入らない。
function computeFeatureEffectiveness(records, weights, opts) {
  const usable = (records || []).filter((r) => r && r.actualWinner && r.features);
  if (usable.length < 5) {
    return { measurable: false, sampleSize: usable.length, reasonJa: `検証済みの予測が${usable.length}件しかないため、特徴量ごとの有効性はまだ測定できません(5件以上で測定します)。`, features: [] };
  }
  const base = computeNegativeLogLikelihood(usable, weights, opts);
  if (base === null) return { measurable: false, sampleSize: usable.length, reasonJa: "損失を計算できませんでした。", features: [] };
  const features = [];
  for (const [fKey, wKey] of Object.entries(FEATURE_WEIGHT_MAP)) {
    const w = weights[wKey] || 0;
    if (Math.abs(w) < 1e-6) {
      features.push({ key: fKey, labelJa: FEATURE_LABELS_JA[fKey], weight: 0, contribution: null, verdictJa: "未学習(重み0のため予測に使われていません)" });
      continue;
    }
    const ablated = { ...weights, [wKey]: 0 };
    const without = computeNegativeLogLikelihood(usable, ablated, opts);
    const contribution = without === null ? null : Math.round((without - base) * 10000) / 10000;
    features.push({
      key: fKey, labelJa: FEATURE_LABELS_JA[fKey],
      weight: Math.round(w * 1000) / 1000,
      contribution,
      verdictJa: contribution === null ? "測定不能"
        : contribution > 0.002 ? "有効(この特徴量を外すと予測が悪化します)"
        : contribution < -0.002 ? "有害の疑い(外した方が損失が下がります。次回の重み学習で0化候補になります)"
        : "影響は小さい(あっても無くても損失がほぼ変わりません)",
    });
  }
  features.sort((a, b) => (b.contribution ?? -Infinity) - (a.contribution ?? -Infinity));
  return { measurable: true, sampleSize: usable.length, baseLoss: Math.round(base * 10000) / 10000, features };
}

// 有害と実測された特徴量を0にした候補を作る(ご指示⑧「不要な特徴量は重みを
// 減らす」の実行部)。候補は必ず既存のホールドアウト関門(学習用・検証用の
// 両方で改善した場合のみ採用)を通るため、誤検出で予測が悪化することはない。
function buildAblationCandidates(effectivenessReport, currentWeights) {
  if (!effectivenessReport || !effectivenessReport.measurable) return [];
  return effectivenessReport.features
    .filter((f) => f.contribution !== null && f.contribution < -0.002)
    .map((f) => ({
      w: { ...currentWeights, [FEATURE_WEIGHT_MAP[f.key]]: 0 },
      method: `ablation_${f.key}`,
      noteJa: `実測で「${f.labelJa}」が予測を悪化させていた(寄与${f.contribution})ため、この特徴量を外す候補を試しました。`,
    }));
}

// 2026年8月・優先順位②の実装中に、重みの学習シミュレーションで発見した重大な
// 実装漏れの修正: 新しく追加した特徴量の重みをこの配列に入れ忘れていたため、
// 勾配降下法の対象外となり「永遠に0のまま=その特徴量が一生使われない」状態に
// なっていた。特徴量を追加するときは、必ずこの配列にも追加すること。
const LEARNABLE_KEYS = [
  "sensitivity", "goalRateSensitivity", "injurySensitivity",
  "standingsSensitivity", "headToHeadSensitivity", "fatigueSensitivity",
  "venueSensitivity", "suspensionSensitivity", "xgSensitivity", "topScorerSensitivity",
  // λの独立化(和の重み)と Dixon-Coles の低スコア補正も学習対象にする
  "attackSumSensitivity", "concededSumSensitivity", "fatigueSumSensitivity", "xgSumSensitivity",
  "rho",
];

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
  // 2026年8月・ご指示⑤: 信頼度の高いデータで行った予測ほど強く学習する
  // (opts.sampleWeightOf経由。渡さなければ従来どおり全件同じ重み)。
  const nllOpts = opts && opts.sampleWeightOf ? { sampleWeightOf: opts.sampleWeightOf } : undefined;

  for (let iter = 0; iter < iterations; iter++) {
    const baseLoss = computeNegativeLogLikelihood(usable, weights, nllOpts);
    if (baseLoss === null) break;
    const grad = {};
    for (const k of LEARNABLE_KEYS) {
      const bumped = { ...weights, [k]: weights[k] + epsilon };
      const bumpedLoss = computeNegativeLogLikelihood(usable, bumped, nllOpts);
      grad[k] = bumpedLoss === null ? 0 : (bumpedLoss - baseLoss) / epsilon;
    }
    const next = { ...weights };
    for (const k of LEARNABLE_KEYS) {
      const updated = weights[k] - lr * grad[k];
      // 2026年8月・第5次監査で発見した「NaN汚染」の修正。
      // Math.max(-1, Math.min(1, NaN)) は NaN をそのまま通してしまう。
      // 保存された1件の記録に数値でない特徴量が混ざっているだけで、損失が
      // NaN → 勾配が NaN → 重みが NaN となり、しかも predictOutcomeV2 の
      // `(w[wKey] || 0)` が NaN を静かに0へ落とすため、**その特徴量が
      // 二度と使われない状態が永久に続く**(エラーも出ない)。
      // 有限な数値でなければ、その回の更新を捨てて直前の値を維持する。
      next[k] = Number.isFinite(updated) ? Math.max(-1, Math.min(1, updated)) : weights[k];
    }
    weights = next;
  }
  // 最終防衛線: 万一どこかでNaN/Infinityが残っていたら学習結果を採用しない。
  // (「壊れた重みを保存する」より「今日は学習しなかった」の方が正直で安全)
  if (!isSaneWeights(weights)) return null;
  return weights;
}

/**
 * 重みオブジェクトが「保存してよい状態か」を検査する。
 * 第5次監査の指摘への対応: これまで学習結果を無条件に Upstash へ書いていたため、
 * NaN が1つ混ざるだけで以降の予測が恒久的に壊れる設計だった。
 * 保存の直前に必ずこれを通す。
 */
function isSaneWeights(w) {
  if (!w || typeof w !== "object") return false;
  const numericKeys = [...LEARNABLE_KEYS, "homeBase", "awayBase"];
  for (const k of numericKeys) {
    const v = w[k];
    if (v === undefined) continue; // 既定値で補われるキーは許容する
    if (!Number.isFinite(v)) return false;
    // 学習で動きうる範囲を大きく超えた値は、計算が破綻した証拠とみなす。
    if (Math.abs(v) > 10) return false;
  }
  // 基礎得点はポアソン分布の平均なので、負やゼロはあり得ない。
  for (const k of ["homeBase", "awayBase"]) {
    if (w[k] !== undefined && !(w[k] > 0 && w[k] <= 5)) return false;
  }
  return true;
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
  venueSensitivity: "ホーム/アウェイ別の成績の重要度",
  suspensionSensitivity: "出場停止の影響の重要度",
  xgSensitivity: "xG(期待得点)の重要度",
  topScorerSensitivity: "エースの得点力の重要度",
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
  venueDiff_overweighted: "ホーム/アウェイ別の成績を重視しすぎた",
  venueDiff_underweighted: "ホーム/アウェイ別の成績を軽視した",
  suspensionDiff_overweighted: "出場停止者を重視しすぎた",
  suspensionDiff_underweighted: "出場停止者を軽視した",
  xgDiff_overweighted: "xG(期待得点)を重視しすぎた",
  xgDiff_underweighted: "xG(期待得点)との差を見逃した",
  topScorerDiff_overweighted: "エースの得点力を重視しすぎた",
  topScorerDiff_underweighted: "エースの得点力を軽視した",
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

// ---- 2026年8月・優先順位③「Failure Learningを本格化してください」 ----
// ご要望原文: 「ホーム補正が強すぎた/怪我を軽視した/スタメン変更を見逃した/
// フォーメーション相性を考慮しなかった/監督交代を考慮しなかった/xGとの差を
// 見逃した など、必ず原因を分析してください」。
//
// classifyFailureReasons は「モデルが持っている特徴量の重み」からしか原因を
// 出せないため、モデルに入っていない事情(監督交代・スタメン変更など)は
// 永久に "unmodeled_factors"(数値化していない要因)としか言えなかった。
// そこで、予測時点に記録しておいた文脈(predictionContext)と、試合後に判明した
// 事実(resolvedContext)を突き合わせて、モデルの外側の原因を特定する関数を追加する。
//
// でっち上げ防止の原則(重要):
//   ・「予測時点で分かっていたこと」と「試合後に判明したこと」が
//     実際に食い違っている場合にだけ理由を立てる。
//   ・文脈が記録されていない(古いレコード等)場合は、無理に推測せず何も返さない。
const CONTEXTUAL_FAILURE_LABELS_JA = {
  xg_goal_gap_missed: "xG(チャンスの質)との食い違いを見逃した",
  coach_change_ignored: "監督交代を考慮できなかった",
  formation_change_missed: "フォーメーション変更を見逃した",
  lineup_disruption_missed: "スタメンの大幅な入れ替わりを見逃した",
};

/**
 * モデルの外側にある原因を、予測時点の文脈と試合後の事実の差から特定する。
 * @param {object} record - resolved済みのlearn:ownpredレコード
 * @param {object} resolved - 試合後に判明した文脈
 *   { homeCoachName, awayCoachName, homeFormation, awayFormation, homeLineupNames, awayLineupNames }
 * @returns {Array<{id, labelJa, detail}>} 当たっていた場合・文脈が無い場合は空配列
 */
function classifyContextualFailureReasons(record, resolved) {
  if (!record || record.correct !== false) return [];
  const reasons = [];
  const ctx = record.predictionContext || null;
  const after = resolved || null;

  // ① xGとの食い違い(モデル内の特徴量だけで判定できるので、文脈が無くても使える)
  //    実際の得点力(goalRateDiff)とxG(xgDiff)が逆を向いていたのに、
  //    得点力の方を信じて外した場合。「最近よく点が入っていたのは幸運で、
  //    チャンスの質は伴っていなかった」という典型的な読み違い。
  const f = record.features || {};
  const goalSign = Math.sign(f.goalRateDiff || 0);
  const xgSign = Math.sign(f.xgDiff || 0);
  const predSign = record.predictedWinner === "home" ? 1 : record.predictedWinner === "away" ? -1 : 0;
  if (goalSign !== 0 && xgSign !== 0 && goalSign !== xgSign && predSign === goalSign) {
    reasons.push({
      id: "xg_goal_gap_missed",
      labelJa: CONTEXTUAL_FAILURE_LABELS_JA.xg_goal_gap_missed,
      detail: `実際の得点力の差(${(f.goalRateDiff || 0).toFixed(2)})とxG(チャンスの質)の差(${(f.xgDiff || 0).toFixed(2)})が逆を向いていましたが、実際の得点の方を信じて予想し、外れました。得点が続いていたのは一時的な幸運だった可能性があります。`,
    });
  }

  if (!ctx || !after) return reasons.slice(0, 3);

  // ② 監督交代: 予測時点の監督名と、試合時点の監督名が違う
  for (const side of ["home", "away"]) {
    const before = ctx[`${side}CoachName`];
    const now = after[`${side}CoachName`];
    if (before && now && before !== now) {
      reasons.push({
        id: "coach_change_ignored",
        labelJa: CONTEXTUAL_FAILURE_LABELS_JA.coach_change_ignored,
        detail: `${side === "home" ? "ホーム" : "アウェイ"}チームの監督が予測時点の「${before}」から試合時点では「${now}」に代わっていました。監督交代直後はチームの戦い方が大きく変わることがありますが、予測モデルはこれを数値として扱えていません。`,
      });
      break; // 同じ理由を両チーム分並べない
    }
  }

  // ③ フォーメーション変更: 予測時点に想定していた布陣と、実際の布陣が違う
  for (const side of ["home", "away"]) {
    const before = ctx[`${side}Formation`];
    const now = after[`${side}Formation`];
    if (before && now && before !== now) {
      reasons.push({
        id: "formation_change_missed",
        labelJa: CONTEXTUAL_FAILURE_LABELS_JA.formation_change_missed,
        detail: `${side === "home" ? "ホーム" : "アウェイ"}チームの布陣が、直近の${before}から実際の試合では${now}に変わっていました。`,
      });
      break;
    }
  }

  // ④ スタメンの大幅な入れ替わり: 予測時点の主力と実際の先発の重なりが少ない
  for (const side of ["home", "away"]) {
    const before = ctx[`${side}LineupNames`];
    const now = after[`${side}LineupNames`];
    if (Array.isArray(before) && Array.isArray(now) && before.length >= 5 && now.length >= 5) {
      const nowSet = new Set(now);
      const kept = before.filter((n) => nowSet.has(n)).length;
      const changed = before.length - kept;
      if (changed >= Math.ceil(before.length / 2)) {
        reasons.push({
          id: "lineup_disruption_missed",
          labelJa: CONTEXTUAL_FAILURE_LABELS_JA.lineup_disruption_missed,
          detail: `${side === "home" ? "ホーム" : "アウェイ"}チームの先発が、直近の試合から${changed}人入れ替わっていました(${before.length}人中)。主力を温存するターンオーバーは結果を大きく変えることがあります。`,
        });
        break;
      }
    }
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
  venueDiff_worked: "ホーム/アウェイ別の成績を正しく評価できた",
  suspensionDiff_worked: "出場停止者の影響を正しく評価できた",
  xgDiff_worked: "xG(期待得点)の質を正しく評価できた",
  topScorerDiff_worked: "エースの得点力を正しく評価できた",
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
  computeFeatureAvailability,
  isSaneWeights,
  predictOutcomeV2,
  poissonPmf,
  dixonColesTau, scoreGrid,
  computeMatchProbabilitiesRaw,
  computeMatchProbabilities,
  mostLikelyScoreline, scorelineOutcome, topScorelinesFrom, marketProbabilities,
  computeFactorImportance,
  backtestAccuracyV2,
  computeNegativeLogLikelihood,
  computeFeatureEffectiveness,
  buildAblationCandidates,
  fitWeightsGradientDescent,
  describeWeightsHistoryEntry,
  buildLearningSummary,
  classifyFailureReasons,
  summarizeFailureReasons,
  classifySuccessReasons,
  summarizeSuccessReasons,
  classifyContextualFailureReasons,
  CONTEXTUAL_FAILURE_LABELS_JA,
  SUCCESS_REASON_LABELS_JA,
};
