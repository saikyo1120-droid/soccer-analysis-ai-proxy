/**
 * server/learning/accuracyTracker.js
 * ------------------------------------------------
 * 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示⑨)。
 * 予測精度を毎日測定する: 勝敗(1X2)だけでなく、スコア・BTTS(両チーム得点)・
 * Over/Under 2.5 の各市場について、的中率・Brier Score・Log Loss・
 * Calibration(自信と実際の的中のズレ)を記録し、昨日・先週・先月と比較する。
 *
 * ■ でっち上げ防止
 *   ・BTTS/Over-Under の確率は、勝敗予測と同じポアソン分布(homeLambda/awayLambda)
 *     から機械的に導出する。別の「予想」を勝手に作らない。
 *   ・検証データが無い日は、無理に数字を出さず「測定できない」と正直に返す。
 *   ・ROI(オッズを使った収益率)は、現在オッズを取得していないため計算しない
 *     (存在しない数字を出さない)。API-Football Proにはオッズのエンドポイントが
 *     あるため、必要になれば追加できる。
 *
 * ■ 指標の意味(利用者向けの説明にも使う)
 *   ・的中率: 当たった割合。分かりやすいが「自信の質」は測れない。
 *   ・Brier Score: 確率予測の二乗誤差(0が最良、1X2の無情報予測≒0.667)。
 *   ・Log Loss: 実際の結果に割り当てていた確率の対数損失(低いほど良い。
 *     自信満々で外すと大きく罰される)。
 *   ・Calibration: 「70%と言った予測は本当に70%当たっているか」。
 *
 * ■ 2026年8月・AI知能計測ラウンド(ご指示⑥)での拡張
 *   ・Precision / Recall / F1: 1X2はホーム勝ち・引き分け・アウェイ勝ちの
 *     3クラスなので、クラスごとの混同行列(予測回数・実際の回数・正解回数)を
 *     毎日積み上げ、マクロ平均のPrecision/Recall/F1を出す。
 *   ・ECE(Expected Calibration Error): 較正の帯ごとに「申告した自信の平均」も
 *     保存し(confSum)、|平均自信 − 実際の的中率| の加重平均を厳密に計算する。
 *   ・Top1/Top3: 1X2は3クラスしかないため「Top3的中率」は定義上必ず100%になる
 *     (=無意味な数字)。でっち上げた高得点を出さないため、Top3は最も難しい
 *     「スコア(何対何)」で測る: ポアソン格子の上位3スコアのどれかが実スコアと
 *     一致したか。Top1は従来どおり予測スコアそのものの一致。
 *   いずれも過去に保存済みの集計(古い形式)とマージしても壊れないよう、
 *   新フィールドは欠けていれば0(または「測定不能」)として扱う。
 */

const { poissonPmf } = require("./predictionModel");

const ACCURACY_KEY_PREFIX = "learn:accuracy:";
const P_FLOOR = 0.005; // log(0)回避

/**
 * ポアソン格子から全市場の確率を導出する(勝敗と同一のモデル・同一のλ)。
 */
function computeMarketProbs(homeLambda, awayLambda, maxGoals) {
  if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda)) return null;
  const cap = maxGoals || 8;
  let pHome = 0, pDraw = 0, pAway = 0, pBtts = 0, pOver25 = 0;
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      const p = poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda);
      if (h > a) pHome += p; else if (h < a) pAway += p; else pDraw += p;
      if (h >= 1 && a >= 1) pBtts += p;
      if (h + a >= 3) pOver25 += p;
    }
  }
  const total = pHome + pDraw + pAway || 1;
  return {
    homeWin: pHome / total, draw: pDraw / total, awayWin: pAway / total,
    btts: pBtts / total, over25: pOver25 / total,
  };
}

/**
 * AI知能計測ラウンド(ご指示⑥・Top3): ポアソン格子から確率の高い順に
 * 上位Nスコアを返す。予測時と同じλ・同じ格子から機械的に導出するため、
 * 「後から都合の良いスコアを選ぶ」ことはできない。
 */
function topScorelines(homeLambda, awayLambda, topN, maxGoals) {
  if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda)) return null;
  const cap = maxGoals || 8;
  const cells = [];
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      cells.push({ scoreline: `${h}-${a}`, p: poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda) });
    }
  }
  cells.sort((x, y) => y.p - x.p);
  return cells.slice(0, Math.max(1, topN || 3)).map((c) => ({ scoreline: c.scoreline, prob: round4(c.p) }));
}

/** 実スコアから各市場の実際の結果を出す */
function outcomesFromScore(homeGoals, awayGoals) {
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
  return {
    winner: homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw",
    btts: homeGoals >= 1 && awayGoals >= 1,
    over25: homeGoals + awayGoals >= 3,
  };
}

/**
 * 解決済みの予測1件を全市場で採点する。
 * actualScore(実スコア)が無い古い記録は、1X2(actualWinner)だけ採点する。
 * @returns {object|null} 採点結果。採点材料が無ければnull。
 */
function scorePrediction(record) {
  if (!record || !Number.isFinite(record.homeLambda) || !Number.isFinite(record.awayLambda)) return null;
  const probs = computeMarketProbs(record.homeLambda, record.awayLambda);
  if (!probs) return null;

  const out = { markets: {} };

  // ---- 1X2(勝敗) ----
  const actualWinner = record.actualWinner
    || (record.actualScore ? outcomesFromScore(record.actualScore.home, record.actualScore.away)?.winner : null);
  if (actualWinner) {
    const oneHot = { home: actualWinner === "home" ? 1 : 0, draw: actualWinner === "draw" ? 1 : 0, away: actualWinner === "away" ? 1 : 0 };
    const brier = Math.pow(probs.homeWin - oneHot.home, 2) + Math.pow(probs.draw - oneHot.draw, 2) + Math.pow(probs.awayWin - oneHot.away, 2);
    const pActual = actualWinner === "home" ? probs.homeWin : actualWinner === "away" ? probs.awayWin : probs.draw;
    const maxProb = Math.max(probs.homeWin, probs.draw, probs.awayWin);
    const predictedWinner = probs.homeWin === maxProb ? "home" : probs.awayWin === maxProb ? "away" : "draw";
    out.markets.oneX2 = {
      hit: record.predictedWinner ? record.predictedWinner === actualWinner : predictedWinner === actualWinner,
      brier: round4(brier),
      logLoss: round4(-Math.log(Math.max(P_FLOOR, pActual))),
      confidence: round4(maxProb), // 予測時の自信(較正の材料)
      probs: { homeWin: round4(probs.homeWin), draw: round4(probs.draw), awayWin: round4(probs.awayWin) },
      // ご指示⑥(Precision/Recall/F1): クラス別混同行列の材料として、
      // 「どのクラスを予測したか」も採点結果に残す(記録に予測が保存されて
      // いればそれを使い、無ければ確率の最大クラス=当時の予測を使う)。
      predicted: record.predictedWinner || predictedWinner,
      actual: actualWinner,
    };
  }

  // ---- BTTS / Over-Under 2.5(実スコアがある記録のみ) ----
  const score = record.actualScore;
  const actuals = score ? outcomesFromScore(score.home, score.away) : null;
  if (actuals) {
    out.markets.btts = binaryScore(probs.btts, actuals.btts);
    out.markets.over25 = binaryScore(probs.over25, actuals.over25);
    // 最終スコアの一致(最も難しい市場。参考値として記録)
    if (record.predictedScoreline) {
      const actualSl = `${score.home}-${score.away}`;
      // ご指示⑥(Top3): 予測時と同じポアソン格子から上位3スコアを再導出し、
      // 実スコアがその中に入っていたかを採点する(1X2のTop3は3クラスで
      // 必ず100%になるため、意味のあるスコア市場で測る。冒頭コメント参照)。
      const top3 = topScorelines(record.homeLambda, record.awayLambda, 3);
      out.markets.scoreline = {
        hit: record.predictedScoreline === actualSl,
        predicted: record.predictedScoreline,
        actual: actualSl,
        top3: top3 ? top3.map((t) => t.scoreline) : null,
        top3Hit: top3 ? top3.some((t) => t.scoreline === actualSl) : null,
      };
    }
  }
  return out;
}

function binaryScore(prob, actual) {
  const y = actual ? 1 : 0;
  return {
    hit: (prob >= 0.5) === actual,
    brier: round4(Math.pow(prob - y, 2)),
    logLoss: round4(-Math.log(Math.max(P_FLOOR, actual ? prob : 1 - prob))),
    prob: round4(prob),
    actual,
  };
}

function round4(v) { return Math.round(v * 10000) / 10000; }
function round1(v) { return Math.round(v * 10) / 10; }

/**
 * 1日分の採点を集計する(合計値で持ち、同じ日の複数回実行はマージで加算できる形)。
 */
function buildDailyAccuracy(scoredList) {
  const agg = emptyDailyAccuracy();
  for (const s of scoredList || []) {
    if (!s || !s.markets) continue;
    for (const m of ["oneX2", "btts", "over25"]) {
      const mk = s.markets[m];
      if (!mk || !Number.isFinite(mk.brier)) continue;
      const a = agg[m];
      a.n++;
      if (mk.hit) a.hits++;
      a.brierSum = round4(a.brierSum + mk.brier);
      a.logLossSum = round4(a.logLossSum + mk.logLoss);
      if (m === "oneX2" && Number.isFinite(mk.confidence)) {
        // Calibration: 自信(最大確率)の帯ごとに「実際に当たった割合」を貯める。
        // ご指示⑥(ECE): 帯ごとの「申告した自信の合計」も貯める。これで
        // ECE = Σ(帯の件数/全件数)×|帯の平均自信 − 帯の的中率| が厳密に出せる。
        const bin = mk.confidence < 0.45 ? "33-45" : mk.confidence < 0.55 ? "45-55" : mk.confidence < 0.7 ? "55-70" : "70+";
        a.calibration[bin].n++;
        if (mk.hit) a.calibration[bin].hits++;
        a.calibration[bin].confSum = round4((a.calibration[bin].confSum || 0) + mk.confidence);
      }
      // ご指示⑥(Precision/Recall/F1): クラス別の混同行列を積み上げる
      if (m === "oneX2" && mk.predicted && mk.actual && a.perClass[mk.predicted] && a.perClass[mk.actual]) {
        a.perClass[mk.predicted].pred++;
        a.perClass[mk.actual].actual++;
        if (mk.predicted === mk.actual) a.perClass[mk.predicted].correct++;
      }
    }
    if (s.markets.scoreline) {
      agg.scoreline.n++;
      if (s.markets.scoreline.hit) agg.scoreline.hits++;
      // ご指示⑥(Top3): top3Hitが採点されている記録だけを分母に数える
      // (古い採点結果にはtop3が無いため、無いものを外れ扱いにしない)。
      if (typeof s.markets.scoreline.top3Hit === "boolean") {
        agg.scoreline.top3N++;
        if (s.markets.scoreline.top3Hit) agg.scoreline.top3Hits++;
      }
    }
  }
  return agg;
}

function emptyDailyAccuracy() {
  const bins = () => ({ "33-45": { n: 0, hits: 0, confSum: 0 }, "45-55": { n: 0, hits: 0, confSum: 0 }, "55-70": { n: 0, hits: 0, confSum: 0 }, "70+": { n: 0, hits: 0, confSum: 0 } });
  const perClass = () => ({ home: { pred: 0, actual: 0, correct: 0 }, draw: { pred: 0, actual: 0, correct: 0 }, away: { pred: 0, actual: 0, correct: 0 } });
  return {
    oneX2: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins(), perClass: perClass() },
    btts: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins() },
    over25: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins() },
    scoreline: { n: 0, hits: 0, top3N: 0, top3Hits: 0 },
  };
}

/** 同じ日の2回目以降の実行分を加算マージする(上書きで消さない) */
function mergeDailyAccuracy(a, b) {
  if (!a) return b; if (!b) return a;
  const out = emptyDailyAccuracy();
  for (const m of ["oneX2", "btts", "over25"]) {
    out[m].n = (a[m]?.n || 0) + (b[m]?.n || 0);
    out[m].hits = (a[m]?.hits || 0) + (b[m]?.hits || 0);
    out[m].brierSum = round4((a[m]?.brierSum || 0) + (b[m]?.brierSum || 0));
    out[m].logLossSum = round4((a[m]?.logLossSum || 0) + (b[m]?.logLossSum || 0));
    for (const bin of Object.keys(out[m].calibration)) {
      out[m].calibration[bin].n = (a[m]?.calibration?.[bin]?.n || 0) + (b[m]?.calibration?.[bin]?.n || 0);
      out[m].calibration[bin].hits = (a[m]?.calibration?.[bin]?.hits || 0) + (b[m]?.calibration?.[bin]?.hits || 0);
      // 古い保存形式にはconfSumが無い → 0として加算(ECE側は「confSumの無い
      // 件が混ざった帯」を測定対象から外すため、嘘の自信0%にはならない)
      out[m].calibration[bin].confSum = round4((a[m]?.calibration?.[bin]?.confSum || 0) + (b[m]?.calibration?.[bin]?.confSum || 0));
    }
  }
  for (const cls of ["home", "draw", "away"]) {
    out.oneX2.perClass[cls].pred = (a.oneX2?.perClass?.[cls]?.pred || 0) + (b.oneX2?.perClass?.[cls]?.pred || 0);
    out.oneX2.perClass[cls].actual = (a.oneX2?.perClass?.[cls]?.actual || 0) + (b.oneX2?.perClass?.[cls]?.actual || 0);
    out.oneX2.perClass[cls].correct = (a.oneX2?.perClass?.[cls]?.correct || 0) + (b.oneX2?.perClass?.[cls]?.correct || 0);
  }
  out.scoreline.n = (a.scoreline?.n || 0) + (b.scoreline?.n || 0);
  out.scoreline.hits = (a.scoreline?.hits || 0) + (b.scoreline?.hits || 0);
  out.scoreline.top3N = (a.scoreline?.top3N || 0) + (b.scoreline?.top3N || 0);
  out.scoreline.top3Hits = (a.scoreline?.top3Hits || 0) + (b.scoreline?.top3Hits || 0);
  return out;
}

/**
 * ご指示⑥(Precision/Recall/F1): クラス別混同行列からマクロ平均を計算する。
 * ・Precision(そのクラスを予測したときに当たっていた割合)は、そのクラスを
 *   一度も予測していなければ定義できない → 実際に出現しているクラスなら0点、
 *   そもそも出現していないクラスはマクロ平均から除外(嘘の0点で平均を
 *   下げない・嘘の満点で上げない)。
 */
function computePrecisionRecallF1(perClass) {
  if (!perClass) return { measurable: false, reasonJa: "クラス別の集計がまだ保存されていません(この機能の追加前に保存された記録です)。" };
  const CLASS_JA = { home: "ホーム勝ち", draw: "引き分け", away: "アウェイ勝ち" };
  const classes = [];
  for (const cls of ["home", "draw", "away"]) {
    const c = perClass[cls] || { pred: 0, actual: 0, correct: 0 };
    if (!c.pred && !c.actual) continue; // データに一度も出ていないクラスは評価しない
    const precision = c.pred > 0 ? c.correct / c.pred : (c.actual > 0 ? 0 : null);
    const recall = c.actual > 0 ? c.correct / c.actual : (c.pred > 0 ? 0 : null);
    const f1 = (precision !== null && recall !== null && (precision + recall) > 0)
      ? (2 * precision * recall) / (precision + recall) : (precision === null || recall === null ? null : 0);
    classes.push({
      cls, labelJa: CLASS_JA[cls], predicted: c.pred, actual: c.actual, correct: c.correct,
      precision: precision === null ? null : round4(precision),
      recall: recall === null ? null : round4(recall),
      f1: f1 === null ? null : round4(f1),
    });
  }
  const usable = classes.filter((c) => c.precision !== null && c.recall !== null);
  if (!usable.length) return { measurable: false, reasonJa: "混同行列に件数がまだありません。", classes };
  const mean = (key) => round4(usable.reduce((s, c) => s + c[key], 0) / usable.length);
  return {
    measurable: true,
    macroPrecision: mean("precision"), macroRecall: mean("recall"), macroF1: mean("f1"),
    evaluatedClasses: usable.length,
    classes,
    noteJa: "3クラス(ホーム勝ち/引き分け/アウェイ勝ち)のマクロ平均です。データに出現したクラスだけで平均しています。",
  };
}

/**
 * ご指示⑥(ECE): 較正の帯ごとの |平均自信 − 実際の的中率| を件数で加重平均する。
 * confSumはこの機能の追加後に保存された記録にしか無いため、confSumの無い帯は
 * 測定対象から正直に外す(0%の自信と偽って計算しない)。
 */
function computeEce(calibration) {
  if (!calibration) return { measurable: false, reasonJa: "較正の帯がまだ保存されていません。" };
  let totalN = 0, coveredN = 0, weighted = 0;
  const binDetails = [];
  for (const [bin, v] of Object.entries(calibration)) {
    if (!v || !v.n) continue;
    totalN += v.n;
    if (!(v.confSum > 0)) continue; // 旧形式(自信の合計が無い)は測定不能として除外
    const avgConf = v.confSum / v.n;
    const hitRate = v.hits / v.n;
    coveredN += v.n;
    weighted += v.n * Math.abs(avgConf - hitRate);
    binDetails.push({ bin: `${bin}%`, n: v.n, avgConfPct: round1(avgConf * 100), actualHitPct: round1(hitRate * 100), gapPt: round1(Math.abs(avgConf - hitRate) * 100) });
  }
  if (!coveredN) return { measurable: false, reasonJa: totalN ? "自信の合計(confSum)が保存される前の記録のため、ECEは計算できません(新しい採点分から自動的に測定されます)。" : "採点済みの予測がまだありません。", bins: [] };
  return {
    measurable: true,
    ece: round4(weighted / coveredN),
    ecePct: round1((weighted / coveredN) * 100),
    measuredOnN: coveredN, totalN,
    bins: binDetails,
    noteJa: `ECE = 自信の帯ごとの|平均自信−実際の的中率|の加重平均(0が最良)。${coveredN < totalN ? `全${totalN}件のうち自信が記録されている${coveredN}件で測定。` : ""}`,
  };
}

/** 集計を人間が読む形(的中率%・平均Brier・平均LogLoss・較正表)へ変換 */
function summarizeAccuracy(agg) {
  if (!agg) return null;
  const marketJa = { oneX2: "勝敗(1X2)", btts: "両チーム得点(BTTS)", over25: "オーバー/アンダー2.5" };
  const out = { markets: {}, scoreline: null };
  let any = false;
  for (const m of ["oneX2", "btts", "over25"]) {
    const a = agg[m];
    if (!a || !a.n) { out.markets[m] = { labelJa: marketJa[m], n: 0, measurable: false }; continue; }
    any = true;
    out.markets[m] = {
      labelJa: marketJa[m], measurable: true, n: a.n,
      hitRatePct: round1((a.hits / a.n) * 100),
      avgBrier: round4(a.brierSum / a.n),
      avgLogLoss: round4(a.logLossSum / a.n),
      calibration: Object.entries(a.calibration)
        .filter(([, v]) => v.n > 0)
        .map(([bin, v]) => ({ bin: `${bin}%`, n: v.n, actualHitPct: round1((v.hits / v.n) * 100) })),
    };
    // ご指示⑥: 1X2にはPrecision/Recall/F1(マクロ平均)とECEを追加する
    if (m === "oneX2") {
      out.markets.oneX2.precisionRecallF1 = computePrecisionRecallF1(a.perClass);
      out.markets.oneX2.ece = computeEce(a.calibration);
    }
  }
  if (agg.scoreline && agg.scoreline.n) {
    out.scoreline = {
      n: agg.scoreline.n,
      hitRatePct: round1((agg.scoreline.hits / agg.scoreline.n) * 100),
      // ご指示⑥(Top1/Top3): Top1=予測スコアそのものの一致率。Top3=同じ
      // ポアソン格子の上位3スコアのどれかが実スコアだった割合(採点済み分のみ)。
      top1HitRatePct: round1((agg.scoreline.hits / agg.scoreline.n) * 100),
      top3: (agg.scoreline.top3N > 0)
        ? { n: agg.scoreline.top3N, hitRatePct: round1((agg.scoreline.top3Hits / agg.scoreline.top3N) * 100) }
        : { n: 0, measurable: false, reasonJa: "Top3の採点はこの機能の追加後の答え合わせから記録されます。" },
      noteJa: "1X2のTop3的中率は3クラスしか無いため定義上100%になり無意味です。そのためTop3は最も難しい「スコア一致」で測っています。",
    };
  }
  out.measurable = any;
  if (!any) out.reasonJa = "この期間に答え合わせできた予測がありません(試合が無い・まだ結果が出ていない場合は正常です)。";
  return out;
}

async function saveDailyAccuracy(deps, dateKey, aggToday) {
  const { upstashEnabled, upstashGetJSON, upstashSetJSON } = deps || {};
  if (!upstashEnabled || !dateKey || !aggToday) return false;
  try {
    const existing = await upstashGetJSON(`${ACCURACY_KEY_PREFIX}${dateKey}`).catch(() => null);
    const merged = mergeDailyAccuracy(existing, aggToday);
    await upstashSetJSON(`${ACCURACY_KEY_PREFIX}${dateKey}`, merged);
    return true;
  } catch (e) { return false; }
}

/**
 * 昨日・直近7日・直近30日との比較(ご指示⑨「昨日/先週/先月との比較」)。
 * 記録の無い日は欠落として扱い、推測で埋めない。
 */
async function getAccuracyTrend(deps, todayDateKey) {
  const { upstashEnabled, upstashGetJSON } = deps || {};
  if (!upstashEnabled) return { available: false, reasonJa: "Upstashが未設定のため測定記録を読み出せません。" };
  const base = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  const daily = [];
  for (let i = 0; i < 30; i++) {
    const dk = new Date(base - i * 86400000).toISOString().slice(0, 10);
    const agg = await upstashGetJSON(`${ACCURACY_KEY_PREFIX}${dk}`).catch(() => null);
    if (agg) daily.push({ date: dk, agg });
  }
  const sumRange = (rows) => rows.reduce((acc, r) => mergeDailyAccuracy(acc, r.agg), null);
  const today = daily.find((d) => d.date === todayDateKey) || null;
  const yesterdayKey = new Date(base - 86400000).toISOString().slice(0, 10);
  const yesterday = daily.find((d) => d.date === yesterdayKey) || null;
  const last7 = sumRange(daily.filter((d) => d.date !== todayDateKey).slice(0, 7));
  const last30 = sumRange(daily.filter((d) => d.date !== todayDateKey));
  const s = (agg) => summarizeAccuracy(agg);
  const t = today ? s(today.agg) : null;
  const y = yesterday ? s(yesterday.agg) : null;
  return {
    available: true,
    recordedDays: daily.length,
    today: t, yesterday: y, last7Days: s(last7), last30Days: s(last30),
    // 「前日より精度が何%改善したか」: 両日とも測定できた市場だけ差を出す
    vsYesterday: (t && y && t.markets.oneX2.measurable && y.markets.oneX2.measurable)
      ? {
        hitRateDeltaPct: round1(t.markets.oneX2.hitRatePct - y.markets.oneX2.hitRatePct),
        brierDelta: round4(t.markets.oneX2.avgBrier - y.markets.oneX2.avgBrier),
        logLossDelta: round4(t.markets.oneX2.avgLogLoss - y.markets.oneX2.avgLogLoss),
        noteJa: "Brier/LogLossはマイナス(減少)が改善です。",
      }
      : { noteJa: "昨日か今日のどちらかに答え合わせできた予測が無いため、前日比は測定できません。" },
  };
}

module.exports = {
  ACCURACY_KEY_PREFIX,
  computeMarketProbs, outcomesFromScore, scorePrediction, topScorelines,
  buildDailyAccuracy, mergeDailyAccuracy, emptyDailyAccuracy,
  computePrecisionRecallF1, computeEce,
  summarizeAccuracy, saveDailyAccuracy, getAccuracyTrend,
};
